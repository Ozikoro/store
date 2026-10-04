/**
 * The catalogue: products, variants and collections, as the storefront reads
 * them.
 *
 * Only `active` products are ever returned by the storefront queries. A `draft`
 * product must not be reachable by guessing its URL, and an `archived` one must
 * not be purchasable — both of those are enforced here rather than in a page
 * component, so a new page cannot forget.
 */

import { db } from './env';
import { randomToken } from './crypto';
import { recordAudit, type AuditActor } from './audit';

export type ProductStatus = 'active' | 'draft' | 'archived';

export interface ProductRow {
  id: string;
  slug: string;
  title: string;
  category: string;
  collection_id: string | null;
  description: string;
  details: string;
  image_url: string;
  image_alt: string;
  price_minor: number;
  currency: string;
  status: ProductStatus;
  is_featured: number;
  position: number;
  seo_title: string;
  seo_description: string;
  made_to_order: number;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  price_minor: number;
  compare_at_minor: number | null;
  stock: number;
  weight_grams: number;
  position: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  image_url: string;
  position: number;
  is_visible: number;
  created_at: string;
  updated_at: string;
}

/** A product with its variants, as a page renders it. */
export interface ProductWithVariants extends ProductRow {
  variants: VariantRow[];
}

export function parseDetails(details: string): string[] {
  try {
    const parsed = JSON.parse(details);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // A malformed details blob must not take a product page down.
  }
  return [];
}

/**
 * Total stock across a product's active variants.
 *
 * This is a display convenience — "sold out" on a card — never a purchasing
 * decision. The purchasing decision is made per variant, against live stock.
 */
export function totalStock(product: ProductWithVariants): number {
  return product.variants.filter((variant) => variant.is_active).reduce((sum, variant) => sum + variant.stock, 0);
}

export function isSoldOut(product: ProductWithVariants): boolean {
  if (product.made_to_order) return false;
  const active = product.variants.filter((variant) => variant.is_active);
  return active.length > 0 && active.every((variant) => variant.stock <= 0);
}

/** The variant a card should price from: the cheapest active one, or the first. */
export function leadVariant(product: ProductWithVariants): VariantRow | null {
  const active = product.variants.filter((variant) => variant.is_active);
  if (!active.length) return null;
  const sorted = [...active].sort((a, b) => a.price_minor - b.price_minor);
  return sorted[0] ?? null;
}

export function displayPrice(product: ProductWithVariants): number {
  const variant = leadVariant(product);
  return variant ? variant.price_minor : product.price_minor;
}

// -------------------------------------------------------------------- reads

async function variantsFor(productIds: string[]): Promise<Map<string, VariantRow[]>> {
  const map = new Map<string, VariantRow[]>();
  if (!productIds.length) return map;
  const placeholders = productIds.map((_, index) => `?${index + 1}`).join(',');
  const result = await db()
    .prepare(
      `SELECT * FROM product_variants
        WHERE product_id IN (${placeholders})
        ORDER BY position, title`
    )
    .bind(...productIds)
    .all<VariantRow>();
  for (const variant of result.results ?? []) {
    const list = map.get(variant.product_id) ?? [];
    list.push(variant);
    map.set(variant.product_id, list);
  }
  return map;
}

function attach(products: ProductRow[], variants: Map<string, VariantRow[]>): ProductWithVariants[] {
  return products.map((product) => ({ ...product, variants: variants.get(product.id) ?? [] }));
}

/** Storefront list. Excludes drafts and archives unless asked. */
export async function listProducts(input: {
  status?: ProductStatus | 'all';
  category?: string;
  collectionId?: string;
  search?: string;
  featuredOnly?: boolean;
  limit?: number;
} = {}): Promise<ProductWithVariants[]> {
  const clauses: string[] = [];
  const bindings: unknown[] = [];

  const status = input.status ?? 'active';
  if (status !== 'all') {
    bindings.push(status);
    clauses.push(`status = ?${bindings.length}`);
  }
  if (input.category && input.category !== 'All') {
    bindings.push(input.category);
    clauses.push(`category = ?${bindings.length}`);
  }
  if (input.collectionId) {
    bindings.push(input.collectionId);
    clauses.push(`collection_id = ?${bindings.length}`);
  }
  if (input.featuredOnly) clauses.push('is_featured = 1');
  if (input.search && input.search.trim()) {
    bindings.push(`%${input.search.trim().toLowerCase()}%`);
    const index = bindings.length;
    clauses.push(
      `(LOWER(title) LIKE ?${index} OR LOWER(description) LIKE ?${index} OR LOWER(category) LIKE ?${index} OR LOWER(slug) LIKE ?${index})`
    );
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, input.limit ?? 100));
  bindings.push(limit);

  const result = await db()
    .prepare(`SELECT * FROM products ${where} ORDER BY position, created_at DESC LIMIT ?${bindings.length}`)
    .bind(...bindings)
    .all<ProductRow>();

  const products = result.results ?? [];
  const variants = await variantsFor(products.map((product) => product.id));
  return attach(products, variants);
}

export async function findProductBySlug(slug: string, status: ProductStatus | 'all' = 'active'): Promise<ProductWithVariants | null> {
  const row =
    status === 'all'
      ? await db().prepare('SELECT * FROM products WHERE slug = ?1').bind(slug).first<ProductRow>()
      : await db()
          .prepare('SELECT * FROM products WHERE slug = ?1 AND status = ?2')
          .bind(slug, status)
          .first<ProductRow>();
  if (!row) return null;
  return { ...row, variants: (await variantsFor([row.id])).get(row.id) ?? [] };
}

export async function findProductById(id: string): Promise<ProductWithVariants | null> {
  const row = await db().prepare('SELECT * FROM products WHERE id = ?1').bind(id).first<ProductRow>();
  if (!row) return null;
  return { ...row, variants: (await variantsFor([row.id])).get(row.id) ?? [] };
}

export async function findVariantsByIds(ids: string[]): Promise<VariantRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(',');
  const result = await db()
    .prepare(`SELECT * FROM product_variants WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<VariantRow>();
  return result.results ?? [];
}

export async function findVariantBySku(sku: string): Promise<VariantRow | null> {
  return db().prepare('SELECT * FROM product_variants WHERE sku = ?1').bind(sku).first<VariantRow>();
}

export async function listCollections(visibleOnly = true): Promise<CollectionRow[]> {
  const result = await db()
    .prepare(
      `SELECT * FROM collections ${visibleOnly ? 'WHERE is_visible = 1' : ''} ORDER BY position, title`
    )
    .all<CollectionRow>();
  return result.results ?? [];
}

export async function findCollectionBySlug(slug: string): Promise<CollectionRow | null> {
  return db().prepare('SELECT * FROM collections WHERE slug = ?1').bind(slug).first<CollectionRow>();
}

/** Distinct categories, in catalogue order rather than alphabetical. */
export async function listCategories(): Promise<string[]> {
  const result = await db()
    .prepare(
      `SELECT category, MIN(position) AS p FROM products WHERE status = 'active' AND category != ''
        GROUP BY category ORDER BY p, category`
    )
    .all<{ category: string }>();
  return (result.results ?? []).map((row) => row.category);
}

export async function relatedProducts(product: ProductWithVariants, limit = 3): Promise<ProductWithVariants[]> {
  const result = await db()
    .prepare(
      `SELECT * FROM products
        WHERE status = 'active' AND category = ?1 AND slug != ?2
        ORDER BY position LIMIT ?3`
    )
    .bind(product.category, product.slug, limit)
    .all<ProductRow>();
  const products = result.results ?? [];
  const variants = await variantsFor(products.map((row) => row.id));
  return attach(products, variants);
}

// -------------------------------------------------------------------- writes

export interface ProductInput {
  slug: string;
  title: string;
  category: string;
  description?: string;
  details?: string[];
  imageUrl?: string;
  imageAlt?: string;
  priceMinor: number;
  currency?: string;
  status?: ProductStatus;
  isFeatured?: boolean;
  position?: number;
  seoTitle?: string;
  seoDescription?: string;
  madeToOrder?: boolean;
  collectionId?: string | null;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function createProduct(input: ProductInput, actor: AuditActor | null): Promise<ProductRow> {
  const id = `prd_${randomToken(12)}`;
  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  await db()
    .prepare(
      `INSERT INTO products (
         id, slug, title, category, collection_id, description, details, image_url, image_alt,
         price_minor, currency, status, is_featured, position, seo_title, seo_description, made_to_order
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`
    )
    .bind(
      id,
      slug,
      input.title.trim(),
      input.category.trim(),
      input.collectionId ?? null,
      input.description ?? '',
      JSON.stringify(input.details ?? []),
      input.imageUrl ?? '',
      input.imageAlt ?? input.title,
      Math.round(input.priceMinor),
      input.currency ?? 'NGN',
      input.status ?? 'draft',
      input.isFeatured ? 1 : 0,
      input.position ?? 0,
      input.seoTitle ?? '',
      input.seoDescription ?? '',
      input.madeToOrder ? 1 : 0
    )
    .run();

  await recordAudit({ actor, action: 'product.created', entity: 'product', entityId: id, after: input });
  const created = await db().prepare('SELECT * FROM products WHERE id = ?1').bind(id).first<ProductRow>();
  if (!created) throw new Error('Product was not created');
  return created;
}

export async function updateProduct(
  id: string,
  input: Partial<ProductInput>,
  actor: AuditActor | null
): Promise<ProductRow> {
  const before = await db().prepare('SELECT * FROM products WHERE id = ?1').bind(id).first<ProductRow>();
  if (!before) throw new Error('No such product');

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    fields.push(`${column} = ?${values.length + 1}`);
  };

  if (input.title !== undefined) set('title', input.title.trim());
  if (input.slug !== undefined) set('slug', slugify(input.slug));
  if (input.category !== undefined) set('category', input.category.trim());
  if (input.collectionId !== undefined) set('collection_id', input.collectionId);
  if (input.description !== undefined) set('description', input.description);
  if (input.details !== undefined) set('details', JSON.stringify(input.details));
  if (input.imageUrl !== undefined) set('image_url', input.imageUrl);
  if (input.imageAlt !== undefined) set('image_alt', input.imageAlt);
  if (input.priceMinor !== undefined) set('price_minor', Math.round(input.priceMinor));
  if (input.currency !== undefined) set('currency', input.currency);
  if (input.status !== undefined) set('status', input.status);
  if (input.isFeatured !== undefined) set('is_featured', input.isFeatured ? 1 : 0);
  if (input.position !== undefined) set('position', input.position);
  if (input.seoTitle !== undefined) set('seo_title', input.seoTitle);
  if (input.seoDescription !== undefined) set('seo_description', input.seoDescription);
  if (input.madeToOrder !== undefined) set('made_to_order', input.madeToOrder ? 1 : 0);

  if (!fields.length) return before;

  fields.push(`updated_at = datetime('now')`);
  await db()
    .prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?1`)
    .bind(id, ...values)
    .run();

  await recordAudit({
    actor,
    action: 'product.updated',
    entity: 'product',
    entityId: id,
    before: { price_minor: before.price_minor, status: before.status, title: before.title },
    after: input,
  });

  const updated = await db().prepare('SELECT * FROM products WHERE id = ?1').bind(id).first<ProductRow>();
  if (!updated) throw new Error('Product disappeared during update');
  return updated;
}

/** Archive rather than delete: an archived product keeps its order history. */
export async function archiveProduct(id: string, actor: AuditActor | null): Promise<void> {
  await db()
    .prepare(`UPDATE products SET status = 'archived', updated_at = datetime('now') WHERE id = ?1`)
    .bind(id)
    .run();
  await db()
    .prepare(`UPDATE product_variants SET is_active = 0, updated_at = datetime('now') WHERE product_id = ?1`)
    .bind(id)
    .run();
  await recordAudit({ actor, action: 'product.archived', entity: 'product', entityId: id });
}

export interface VariantInput {
  productId: string;
  title: string;
  sku?: string;
  priceMinor: number;
  compareAtMinor?: number | null;
  stock?: number;
  weightGrams?: number;
  position?: number;
  isActive?: boolean;
}

export async function createVariant(input: VariantInput, actor: AuditActor | null): Promise<VariantRow> {
  const id = `var_${randomToken(12)}`;
  const sku = input.sku?.trim() || `${slugify(input.productId).slice(0, 20)}-${slugify(input.title) || randomToken(4)}`;
  await db()
    .prepare(
      `INSERT INTO product_variants (id, product_id, sku, title, price_minor, compare_at_minor, stock, weight_grams, position, is_active)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
    )
    .bind(
      id,
      input.productId,
      sku,
      input.title.trim(),
      Math.round(input.priceMinor),
      input.compareAtMinor ?? null,
      Math.max(0, Math.round(input.stock ?? 0)),
      Math.max(0, Math.round(input.weightGrams ?? 0)),
      input.position ?? 0,
      input.isActive === false ? 0 : 1
    )
    .run();

  const stock = Math.max(0, Math.round(input.stock ?? 0));
  if (stock > 0) {
    await db()
      .prepare(
        `INSERT INTO inventory_movements (id, variant_id, delta, reason, note, actor_email)
         VALUES (?1, ?2, ?3, 'seed', 'variant created', ?4)`
      )
      .bind(`inv_${randomToken(10)}`, id, stock, actor?.email ?? '')
      .run();
  }

  await recordAudit({
    actor,
    action: 'variant.created',
    entity: 'variant',
    entityId: id,
    after: { productId: input.productId, sku, priceMinor: input.priceMinor, stock },
  });

  const created = await db().prepare('SELECT * FROM product_variants WHERE id = ?1').bind(id).first<VariantRow>();
  if (!created) throw new Error('Variant was not created');
  return created;
}

export async function updateVariant(
  id: string,
  input: Partial<Omit<VariantInput, 'productId'>>,
  actor: AuditActor | null
): Promise<VariantRow> {
  const before = await db().prepare('SELECT * FROM product_variants WHERE id = ?1').bind(id).first<VariantRow>();
  if (!before) throw new Error('No such variant');

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    fields.push(`${column} = ?${values.length + 1}`);
  };

  if (input.title !== undefined) set('title', input.title.trim());
  if (input.sku !== undefined && input.sku.trim()) set('sku', input.sku.trim());
  if (input.priceMinor !== undefined) set('price_minor', Math.round(input.priceMinor));
  if (input.compareAtMinor !== undefined) set('compare_at_minor', input.compareAtMinor);
  if (input.weightGrams !== undefined) set('weight_grams', Math.max(0, Math.round(input.weightGrams)));
  if (input.position !== undefined) set('position', input.position);
  if (input.isActive !== undefined) set('is_active', input.isActive ? 1 : 0);

  if (input.stock !== undefined) {
    const next = Math.max(0, Math.round(input.stock));
    set('stock', next);
    const delta = next - before.stock;
    if (delta !== 0) {
      await db()
        .prepare(
          `INSERT INTO inventory_movements (id, variant_id, delta, reason, note, actor_email)
           VALUES (?1, ?2, ?3, 'manual', ?4, ?5)`
        )
        .bind(
          `inv_${randomToken(10)}`,
          id,
          delta,
          `set from ${before.stock} to ${next}`,
          actor?.email ?? ''
        )
        .run();
    }
  }

  if (fields.length) {
    fields.push(`updated_at = datetime('now')`);
    await db()
      .prepare(`UPDATE product_variants SET ${fields.join(', ')} WHERE id = ?1`)
      .bind(id, ...values)
      .run();
  }

  await recordAudit({
    actor,
    action: input.priceMinor !== undefined && input.priceMinor !== before.price_minor
      ? 'variant.price_changed'
      : input.stock !== undefined && input.stock !== before.stock
        ? 'variant.stock_changed'
        : 'variant.updated',
    entity: 'variant',
    entityId: id,
    before: { price_minor: before.price_minor, stock: before.stock, is_active: before.is_active },
    after: input,
  });

  const updated = await db().prepare('SELECT * FROM product_variants WHERE id = ?1').bind(id).first<VariantRow>();
  if (!updated) throw new Error('Variant disappeared during update');
  return updated;
}

/** Variants at or below the low-stock threshold, for the admin alert. */
export async function lowStockVariants(threshold = 3): Promise<Array<VariantRow & { product_title: string; product_slug: string }>> {
  const result = await db()
    .prepare(
      `SELECT v.*, p.title AS product_title, p.slug AS product_slug
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.is_active = 1 AND v.stock <= ?1 AND p.status != 'archived'
        ORDER BY v.stock, p.title`
    )
    .bind(threshold)
    .all<VariantRow & { product_title: string; product_slug: string }>();
  return result.results ?? [];
}

export async function inventoryMovements(variantId: string, limit = 50) {
  const result = await db()
    .prepare('SELECT * FROM inventory_movements WHERE variant_id = ?1 ORDER BY created_at DESC LIMIT ?2')
    .bind(variantId, limit)
    .all<{
      id: string;
      variant_id: string;
      delta: number;
      reason: string;
      order_id: string | null;
      note: string;
      actor_email: string;
      created_at: string;
    }>();
  return result.results ?? [];
}
