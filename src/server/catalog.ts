/**
 * Catalogue reads for the storefront.
 *
 * Each function here is a `createServerFn` that a route loader calls, so the
 * HTML arrives populated and crawlable. They read through `lib/catalog.ts`,
 * which is what enforces "only active products are ever returned".
 *
 * A missing database must not produce a 500 on a public page: `safe()` returns a
 * documented empty collection and logs, so the storefront degrades to "nothing
 * here yet" rather than an error page while the schema is being applied.
 */

import {
  findCollectionBySlug,
  findProductBySlug,
  listCategories,
  listCollections,
  listProducts,
  relatedProducts,
  findVariantsByIds,
} from '../lib/catalog';
import { createServerFn } from '@tanstack/react-start';
import { readString } from './typed';
import type { DeclaredServerFn, DeclaredServerFnNoInput } from './declare';

async function safe<T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(`[catalog] ${what} failed`, error);
    return fallback;
  }
}

export const getStorefront = createServerFn({ method: 'GET' }).handler(async (): Promise<StorefrontData> => {
  return safe(
    'storefront',
    async () => {
      const [featured, allProducts, collections] = await Promise.all([
        listProducts({ featuredOnly: true, limit: 8 }),
        listProducts({ limit: 200 }),
        listCollections(),
      ]);
      const categories = await listCategories();

      return {
        featured: featured.length ? featured : allProducts.slice(0, 4),
        productCount: allProducts.length,
        collections: collections.map((collection) => ({
          slug: collection.slug,
          title: collection.title,
          description: collection.description,
          image: collection.image_url,
        })),
        // The four landing tiles: the collection rows, with the image of the
        // first product in each, so the tile shows something real.
        categories: collections.slice(0, 4).map((collection) => ({
          slug: collection.slug,
          title: collection.title,
          description: collection.description,
          image:
            allProducts.find((product) => product.collection_id === collection.id)?.image_url ||
            collection.image_url ||
            '/media/print.jpg',
        })).filter((category) => categories.length === 0 || categories.includes(category.title)),
      };
    },
    { featured: [], collections: [], categories: [], productCount: 0 }
  );
}) as unknown as DeclaredServerFnNoInput<StorefrontData>;

export const getShop = createServerFn({ method: 'GET' }).handler(async (): Promise<ShopData> => {
  return safe(
    'shop',
    async () => {
      const [products, categories] = await Promise.all([listProducts({ limit: 200 }), listCategories()]);
      return { products, categories };
    },
    { products: [], categories: [] }
  );
}) as unknown as DeclaredServerFnNoInput<ShopData>;

export const getCollections = createServerFn({ method: 'GET' }).handler(async (): Promise<CollectionSummary[]> => {
  return safe(
    'collections',
    async () => {
      const [collections, products] = await Promise.all([listCollections(), listProducts({ limit: 200 })]);
      return collections.map((collection) => ({
        ...collection,
        image:
          products.find((product) => product.collection_id === collection.id)?.image_url ||
          collection.image_url ||
          '/media/print.jpg',
        productCount: products.filter((product) => product.collection_id === collection.id).length,
      }));
    },
    []
  );
}) as unknown as DeclaredServerFnNoInput<CollectionSummary[]>;

export const getCollection = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = input as { slug?: unknown };
    return { slug: typeof data?.slug === 'string' ? data.slug : '' };
  })
  .handler(async ({ data }): Promise<CollectionResult> => {
    return safe(
      'collection',
      async () => {
        const collection = await findCollectionBySlug(readString(data, 'slug'));
        if (!collection) return { found: false as const };
        const products = collection
          ? await listProducts({ collectionId: collection.id, limit: 200 })
          : [];
        return { found: true as const, collection, products };
      },
      { found: false as const }
    );
  }) as unknown as DeclaredServerFn<CollectionResult>;

export const getProduct = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = input as { slug?: unknown };
    return { slug: typeof data?.slug === 'string' ? data.slug : '' };
  })
  .handler(async ({ data }): Promise<ProductResult> => {
    return safe(
      'product',
      async () => {
        const slug = readString(data, 'slug');

        // An active product first. Only then look for an archived one, so the
        // ordinary path is unchanged and there is no ambiguity when a slug has
        // been reused.
        const active = await findProductBySlug(slug, 'active');
        if (active) {
          const related = await relatedProducts(active, 3);
          return { found: true as const, product: active, related };
        }

        const archived = await findProductBySlug(slug, 'archived');
        if (archived) {
          const related = await relatedProducts(archived, 3);
          return { found: true as const, product: archived, related, discontinued: true as const };
        }

        // A DRAFT is not served at all: it is a product somebody is still
        // writing, and it must not be reachable by guessing its address.
        return { found: false as const };
      },
      { found: false as const }
    );
  }) as unknown as DeclaredServerFn<ProductResult>;

export const searchProducts = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as { query?: unknown };
    return { query: typeof data.query === 'string' ? data.query : '' };
  })
  .handler(async ({ data }): Promise<SearchResult> => {
    const query = readString(data, 'query').trim();
    if (!query) {
      return { query, results: await safe('search-empty', () => listProducts({ limit: 8 }), []) };
    }
    const results = await safe('search', () => listProducts({ search: query, limit: 40 }), []);
    return { query, results };
  }) as unknown as DeclaredServerFn<SearchResult>;

/** Re-price a set of variants, used by the cart to confirm live prices. */
export const priceVariants = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as { variantIds?: unknown };
    const variantIds = Array.isArray(data.variantIds)
      ? data.variantIds.filter((id): id is string => typeof id === 'string').slice(0, 50)
      : [];
    return { variantIds };
  })
  .handler(async ({ data }): Promise<VariantPrice[]> => {
    const variants = await safe('priceVariants', () => findVariantsByIds(data.variantIds ?? []), []);
    return variants.map((variant) => ({
      id: variant.id,
      productId: variant.product_id,
      title: variant.title,
      priceMinor: variant.price_minor,
      stock: variant.stock,
      isActive: variant.is_active === 1,
    }));
  }) as unknown as DeclaredServerFn<VariantPrice[]>;

// ---------------------------------------------------------------- the shapes
// Every server function above declares its response type explicitly. The
// installed TanStack Start does not infer it, and a cast at each call site would
// hide exactly the mistakes this is meant to catch.

export interface CategoryTile {
  slug: string;
  title: string;
  description: string;
  image: string;
}

export interface StorefrontData {
  featured: Awaited<ReturnType<typeof listProducts>>;
  productCount: number;
  collections: Array<{ slug: string; title: string; description: string; image: string }>;
  categories: CategoryTile[];
}

export interface ShopData {
  products: Awaited<ReturnType<typeof listProducts>>;
  categories: string[];
}

export interface CollectionSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  image: string;
  productCount: number;
}

export type CollectionResult =
  | { found: true; collection: Awaited<ReturnType<typeof findCollectionBySlug>> & object; products: Awaited<ReturnType<typeof listProducts>> }
  | { found: false };

export type ProductResult =
  | {
      found: true;
      product: NonNullable<Awaited<ReturnType<typeof findProductBySlug>>>;
      related: Awaited<ReturnType<typeof relatedProducts>>;
      /**
       * True when the product exists but has been ARCHIVED.
       *
       * The page still renders, and that is deliberate: the handoff asks for
       * "useful redirects/archive pages for discontinued products". A 404 throws
       * away every inbound link, every bookmark and every search result for a
       * thing that once existed — and the person following one gets nothing, not
       * even an explanation. An archive page keeps the value and tells them the
       * truth, with a route to what is still for sale.
       *
       * It is marked `noindex, follow`: there is nothing left to buy, so the page
       * should leave the index, but its links out are good ones.
       */
      discontinued?: boolean;
    }
  | { found: false };

export interface SearchResult {
  query: string;
  results: Awaited<ReturnType<typeof listProducts>>;
}

export interface VariantPrice {
  id: string;
  productId: string;
  title: string;
  priceMinor: number;
  stock: number;
  isActive: boolean;
}
