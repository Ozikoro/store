import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';

import {
  archiveProduct,
  getProductAdmin,
  getVariantMovements,
  saveProduct,
  saveVariant,
} from '@/server/admin';
import {
  AdminPage,
  ErrorNote,
  OkNote,
  Panel,
  adminButtonClass,
  adminLinkClass,
  adminQuietButtonClass,
} from '@/store/admin-layout';
import { storeHead } from '@/store/head';
import { formatMoney, minorToMajorString } from '@/lib/money';

export const Route = createFileRoute('/admin/products/$slug')({
  head: ({ params }) =>
    storeHead({
      title: params.slug === 'new' ? 'New product' : `Edit ${params.slug}`,
      description: 'Edit a product and its variants.',
      path: `/admin/products/${params.slug}`,
    }),
  component: ProductEditor,
});

type ProductOk = Extract<Awaited<ReturnType<typeof getProductAdmin>>, { ok: true }>;
type Product = ProductOk['product'];
type Variant = Product['variants'][number];

type Feedback = { tone: 'ok' | 'error'; text: string } | null;

interface ProductFields {
  title: string;
  slug: string;
  category: string;
  description: string;
  details: string;
  imageUrl: string;
  imageAlt: string;
  priceMajor: string;
  currency: string;
  status: string;
  isFeatured: boolean;
  madeToOrder: boolean;
  position: string;
  seoTitle: string;
  seoDescription: string;
}

function fieldsFrom(product: Product | null, details: string[]): ProductFields {
  return {
    title: product?.title ?? '',
    slug: product?.slug ?? '',
    category: product?.category ?? '',
    description: product?.description ?? '',
    details: details.join('\n'),
    imageUrl: product?.image_url ?? '',
    imageAlt: product?.image_alt ?? '',
    priceMajor: product ? minorToMajorString(product.price_minor) : '',
    currency: product?.currency ?? 'NGN',
    status: product?.status ?? 'draft',
    isFeatured: product ? product.is_featured === 1 : false,
    madeToOrder: product ? product.made_to_order === 1 : false,
    position: String(product?.position ?? 0),
    seoTitle: product?.seo_title ?? '',
    seoDescription: product?.seo_description ?? '',
  };
}

function ProductEditor() {
  const { slug } = Route.useParams();
  const isNew = slug === 'new';

  const query = useQuery({
    queryKey: ['admin', 'product', slug],
    queryFn: () => getProductAdmin({ data: { slug } }),
    enabled: !isNew,
  });

  if (isNew) {
    return (
      <AdminPage
        eyebrow="Product"
        title="New product"
        description="A new product starts as a draft. Add it to the storefront when it is ready."
        actions={
          <Link to="/admin/products" className={adminQuietButtonClass}>
            All products
          </Link>
        }
      >
        <ProductFields product={null} details={[]} />
      </AdminPage>
    );
  }

  if (query.isPending) {
    return (
      <AdminPage eyebrow="Product" title={slug}>
        <p className="text-sm text-muted-foreground">Loading the product…</p>
      </AdminPage>
    );
  }

  if (query.isError) {
    return (
      <AdminPage eyebrow="Product" title={slug}>
        <ErrorNote>{query.error instanceof Error ? query.error.message : 'The product could not be loaded.'}</ErrorNote>
      </AdminPage>
    );
  }

  const data = query.data;
  if (!data) return null;
  if (!data.ok) {
    return (
      <AdminPage eyebrow="Product" title={slug}>
        <ErrorNote>{data.error}</ErrorNote>
        <Link to="/admin/products" className={`${adminLinkClass} inline-block mt-6`}>
          Back to products
        </Link>
      </AdminPage>
    );
  }

  return (
    <AdminPage
      eyebrow="Product"
      title={data.product.title}
      description={`${data.product.category} · ${data.product.status}`}
      actions={
        <Link to="/admin/products" className={adminQuietButtonClass} data-testid="product-back">
          All products
        </Link>
      }
    >
      <ProductFields product={data.product} details={data.details} />
      <VariantsPanel product={data.product} />
      <ArchivePanel product={data.product} />
    </AdminPage>
  );
}

function ProductFields({ product, details }: { product: Product | null; details: string[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<ProductFields>(() => fieldsFrom(product, details));
  const [feedback, setFeedback] = useState<Feedback>(null);

  function update<K extends keyof ProductFields>(key: K, value: ProductFields[K]): void {
    setFields((current) => ({ ...current, [key]: value }) as ProductFields);
  }

  const save = useMutation({
    mutationFn: () =>
      saveProduct({
        data: {
          id: product?.id ?? '',
          slug: fields.slug,
          title: fields.title,
          category: fields.category,
          description: fields.description,
          details: fields.details,
          imageUrl: fields.imageUrl,
          imageAlt: fields.imageAlt,
          priceMajor: fields.priceMajor,
          currency: fields.currency,
          status: fields.status,
          isFeatured: fields.isFeatured,
          madeToOrder: fields.madeToOrder,
          position: Number(fields.position) || 0,
          seoTitle: fields.seoTitle,
          seoDescription: fields.seoDescription,
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setFeedback({ tone: 'error', text: result.error });
        return;
      }
      setFeedback({ tone: 'ok', text: result.created ? 'Product created.' : 'Product saved.' });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'products'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'product', result.product.slug] });
      if (!product || product.slug !== result.product.slug) {
        void navigate({ to: '/admin/products/$slug', params: { slug: result.product.slug } });
      }
    },
    onError: (error: unknown) => {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    },
  });

  return (
    <Panel
      title="Product"
      description="The price here is the default; each variant may price itself."
      testId="product-form-panel"
    >
      <form
        data-testid="product-form"
        onSubmit={(event) => {
          event.preventDefault();
          setFeedback(null);
          save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Title</span>
            <input
              className="field"
              value={fields.title}
              data-testid="product-title"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('title', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Address (slug)</span>
            <input
              className="field"
              value={fields.slug}
              data-testid="product-slug"
              placeholder="left blank, derived from the title"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('slug', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Category</span>
            <input
              className="field"
              value={fields.category}
              data-testid="product-category"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('category', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Status</span>
            <select
              className="field"
              value={fields.status}
              data-testid="product-status"
              onChange={(event: ChangeEvent<HTMLSelectElement>) => update('status', event.target.value)}
            >
              <option value="active">active</option>
              <option value="draft">draft</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">Price (major units)</span>
            <input
              className="field"
              value={fields.priceMajor}
              data-testid="product-price"
              placeholder="18500"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('priceMajor', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Currency</span>
            <input
              className="field"
              value={fields.currency}
              data-testid="product-currency"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('currency', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Image URL</span>
            <input
              className="field"
              value={fields.imageUrl}
              data-testid="product-image-url"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('imageUrl', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Image alt text</span>
            <input
              className="field"
              value={fields.imageAlt}
              data-testid="product-image-alt"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('imageAlt', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Order in the catalogue</span>
            <input
              className="field"
              value={fields.position}
              data-testid="product-position"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('position', event.target.value)}
            />
          </label>
          <div className="flex items-end gap-6 pb-2">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={fields.isFeatured}
                data-testid="product-featured"
                onChange={(event: ChangeEvent<HTMLInputElement>) => update('isFeatured', event.target.checked)}
              />
              Featured
            </label>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={fields.madeToOrder}
                data-testid="product-made-to-order"
                onChange={(event: ChangeEvent<HTMLInputElement>) => update('madeToOrder', event.target.checked)}
              />
              Made to order
            </label>
          </div>
        </div>

        <label className="block mt-4">
          <span className="field-label">Description</span>
          <textarea
            className="field h-28 py-3"
            value={fields.description}
            data-testid="product-description"
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => update('description', event.target.value)}
          />
        </label>
        <label className="block mt-4">
          <span className="field-label">Details (one per line)</span>
          <textarea
            className="field h-24 py-3"
            value={fields.details}
            data-testid="product-details"
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => update('details', event.target.value)}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2 mt-4">
          <label className="block">
            <span className="field-label">SEO title</span>
            <input
              className="field"
              value={fields.seoTitle}
              data-testid="product-seo-title"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('seoTitle', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">SEO description</span>
            <input
              className="field"
              value={fields.seoDescription}
              data-testid="product-seo-description"
              onChange={(event: ChangeEvent<HTMLInputElement>) => update('seoDescription', event.target.value)}
            />
          </label>
        </div>

        <button
          type="submit"
          className={`${adminButtonClass} mt-6`}
          data-testid="product-save"
          disabled={save.isPending}
        >
          {save.isPending ? 'Saving…' : product ? 'Save product' : 'Create product'}
        </button>
      </form>

      {feedback?.tone === 'error' ? <ErrorNote testId="product-error">{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote testId="product-ok">{feedback.text}</OkNote> : null}
    </Panel>
  );
}

function VariantsPanel({ product }: { product: Product }) {
  return (
    <Panel
      className="mt-6"
      title="Variants"
      description="Price and stock changes are audited, and a stock change writes an inventory movement."
      testId="variants-panel"
    >
      {product.variants.length ? (
        <ul>
          {product.variants.map((variant) => (
            <VariantRow key={variant.id} variant={variant} product={product} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground mb-5">This product has no variants yet.</p>
      )}
      <NewVariantForm product={product} />
    </Panel>
  );
}

function VariantRow({ variant, product }: { variant: Variant; product: Product }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(variant.title);
  const [sku, setSku] = useState(variant.sku);
  const [priceMajor, setPriceMajor] = useState(minorToMajorString(variant.price_minor));
  const [compareAtMajor, setCompareAtMajor] = useState(
    variant.compare_at_minor === null ? '' : minorToMajorString(variant.compare_at_minor)
  );
  const [stock, setStock] = useState(String(variant.stock));
  const [weightGrams, setWeightGrams] = useState(String(variant.weight_grams));
  const [isActive, setIsActive] = useState(variant.is_active === 1);
  const [showHistory, setShowHistory] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const save = useMutation({
    mutationFn: () =>
      saveVariant({
        data: {
          id: variant.id,
          productId: product.id,
          title,
          sku,
          priceMajor,
          compareAtMajor,
          stock: Number(stock) || 0,
          weightGrams: Number(weightGrams) || 0,
          position: variant.position,
          isActive,
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setFeedback({ tone: 'error', text: result.error });
        return;
      }
      setFeedback({ tone: 'ok', text: 'Variant saved.' });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'product', product.slug] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'products'] });
    },
    onError: (error: unknown) => {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    },
  });

  const history = useQuery({
    queryKey: ['admin', 'variant-movements', variant.id],
    queryFn: () => getVariantMovements({ data: { variantId: variant.id } }),
    enabled: showHistory,
  });

  return (
    <li className="border-t border-border py-5" data-testid={`variant-${variant.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
        <span className="font-mono text-xs text-muted-foreground">{variant.sku}</span>
        <span className="text-xs text-muted-foreground">
          {variant.is_active ? 'Active' : 'Inactive'} · {formatMoney(variant.price_minor, product.currency)} ·{' '}
          {variant.stock} in stock
        </span>
      </div>
      <form
        className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6"
        data-testid={`variant-form-${variant.id}`}
        onSubmit={(event) => {
          event.preventDefault();
          setFeedback(null);
          save.mutate();
        }}
      >
        <label className="block">
          <span className="field-label">Name</span>
          <input
            className="field"
            value={title}
            data-testid={`variant-title-${variant.id}`}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">SKU</span>
          <input
            className="field"
            value={sku}
            data-testid={`variant-sku-${variant.id}`}
            onChange={(event) => setSku(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Price</span>
          <input
            className="field"
            value={priceMajor}
            data-testid={`variant-price-${variant.id}`}
            onChange={(event) => setPriceMajor(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Compare at</span>
          <input
            className="field"
            value={compareAtMajor}
            data-testid={`variant-compare-at-${variant.id}`}
            onChange={(event) => setCompareAtMajor(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Stock</span>
          <input
            className="field"
            type="number"
            min={0}
            value={stock}
            data-testid={`variant-stock-${variant.id}`}
            onChange={(event) => setStock(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Weight (g)</span>
          <input
            className="field"
            type="number"
            min={0}
            value={weightGrams}
            data-testid={`variant-weight-${variant.id}`}
            onChange={(event) => setWeightGrams(event.target.value)}
          />
        </label>
        <div className="flex items-center gap-4 sm:col-span-3 xl:col-span-6">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              data-testid={`variant-active-${variant.id}`}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            Available to buy
          </label>
          <button
            type="submit"
            className={adminButtonClass}
            data-testid={`variant-save-${variant.id}`}
            disabled={save.isPending}
          >
            Save variant
          </button>
          <button
            type="button"
            className={adminQuietButtonClass}
            data-testid={`variant-history-toggle-${variant.id}`}
            onClick={() => setShowHistory((current) => !current)}
          >
            {showHistory ? 'Hide history' : 'Stock history'}
          </button>
        </div>
      </form>

      {feedback?.tone === 'error' ? <ErrorNote testId={`variant-error-${variant.id}`}>{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote testId={`variant-ok-${variant.id}`}>Variant saved.</OkNote> : null}

      {showHistory ? (
        <div className="mt-4" data-testid={`variant-history-${variant.id}`}>
          {history.isPending ? <p className="text-xs text-muted-foreground">Loading the ledger…</p> : null}
          {history.isError ? <ErrorNote>The ledger could not be loaded.</ErrorNote> : null}
          {history.data && history.data.ok && history.data.movements.length > 0 ? (
            <ul className="text-xs">
              {history.data.movements.map((movement) => (
                <li key={movement.id} className="border-t border-border py-2 flex flex-wrap justify-between gap-3">
                  <span>
                    {movement.delta > 0 ? `+${movement.delta}` : movement.delta} · {movement.reason}
                  </span>
                  <span className="text-muted-foreground">
                    {movement.note} {movement.actor_email ? `· ${movement.actor_email}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {history.data && history.data.ok && history.data.movements.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing has moved yet.</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function NewVariantForm({ product }: { product: Product }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [sku, setSku] = useState('');
  const [priceMajor, setPriceMajor] = useState('');
  const [stock, setStock] = useState('0');
  const [weightGrams, setWeightGrams] = useState('0');
  const [isActive, setIsActive] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const save = useMutation({
    mutationFn: () =>
      saveVariant({
        data: {
          id: '',
          productId: product.id,
          title,
          sku,
          priceMajor,
          compareAtMajor: '',
          stock: Number(stock) || 0,
          weightGrams: Number(weightGrams) || 0,
          position: product.variants.length,
          isActive,
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setFeedback({ tone: 'error', text: result.error });
        return;
      }
      setFeedback({ tone: 'ok', text: 'Variant added.' });
      setTitle('');
      setSku('');
      setPriceMajor('');
      setStock('0');
      setWeightGrams('0');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'product', product.slug] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'products'] });
    },
    onError: (error: unknown) => {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    },
  });

  return (
    <form
      className="border-t border-border pt-5 mt-2"
      data-testid="variant-new-form"
      onSubmit={(event) => {
        event.preventDefault();
        setFeedback(null);
        save.mutate();
      }}
    >
      <p className="field-label">Add a variant</p>
      <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <label className="block">
          <span className="field-label">Name</span>
          <input
            className="field"
            value={title}
            data-testid="variant-new-title"
            placeholder="Hardcover"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">SKU (optional)</span>
          <input
            className="field"
            value={sku}
            data-testid="variant-new-sku"
            onChange={(event) => setSku(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Price</span>
          <input
            className="field"
            value={priceMajor}
            data-testid="variant-new-price"
            onChange={(event) => setPriceMajor(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Stock</span>
          <input
            className="field"
            type="number"
            min={0}
            value={stock}
            data-testid="variant-new-stock"
            onChange={(event) => setStock(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Weight (g)</span>
          <input
            className="field"
            type="number"
            min={0}
            value={weightGrams}
            data-testid="variant-new-weight"
            onChange={(event) => setWeightGrams(event.target.value)}
          />
        </label>
      </div>
      <label className="flex items-center gap-3 text-sm mt-4">
        <input
          type="checkbox"
          checked={isActive}
          data-testid="variant-new-active"
          onChange={(event) => setIsActive(event.target.checked)}
        />
        Available to buy
      </label>
      <button
        type="submit"
        className={`${adminButtonClass} mt-4`}
        data-testid="variant-new-submit"
        disabled={save.isPending}
      >
        Add variant
      </button>
      {feedback?.tone === 'error' ? <ErrorNote testId="variant-new-error">{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote testId="variant-new-ok">Variant added.</OkNote> : null}
    </form>
  );
}

function ArchivePanel({ product }: { product: Product }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const archive = useMutation({
    mutationFn: () => archiveProduct({ data: { id: product.id } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setFeedback({ tone: 'error', text: result.error });
        return;
      }
      setFeedback({ tone: 'ok', text: 'Product archived.' });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'product', product.slug] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'products'] });
    },
    onError: (error: unknown) => {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    },
  });

  return (
    <Panel
      className="mt-6"
      title="Archive"
      description="Archiving takes the product off the storefront and deactivates its variants. It is never deleted, so order history keeps its lines."
      testId="archive-panel"
    >
      <button
        type="button"
        className={adminQuietButtonClass}
        data-testid="product-archive"
        disabled={archive.isPending || product.status === 'archived'}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setFeedback(null);
          archive.mutate();
          setConfirming(false);
        }}
      >
        {product.status === 'archived' ? 'Already archived' : confirming ? 'Confirm archive' : 'Archive product'}
      </button>
      {feedback?.tone === 'error' ? <ErrorNote testId="archive-error">{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote testId="archive-ok">Product archived.</OkNote> : null}
    </Panel>
  );
}
