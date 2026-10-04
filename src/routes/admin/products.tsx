import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { listProductsAdmin } from '@/server/admin';
import { AdminPage, ErrorNote, Panel, adminButtonClass, adminLinkClass } from '@/store/admin-layout';
import { storeHead } from '@/store/head';
import { formatMoney } from '@/lib/money';

export const Route = createFileRoute('/admin/products')({
  head: () =>
    storeHead({
      title: 'Admin products',
      description: 'Every product, drafts and archives included.',
      path: '/admin/products',
    }),
  component: ProductsAdmin,
});

const STATUSES = ['all', 'active', 'draft', 'archived'] as const;

function activeStock(variants: Array<{ is_active: number; stock: number }>): number {
  return variants.reduce((sum, variant) => sum + (variant.is_active ? variant.stock : 0), 0);
}

function ProductsAdmin() {
  const [statusDraft, setStatusDraft] = useState<string>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [filters, setFilters] = useState<{ status: string; search: string }>({ status: 'all', search: '' });

  const query = useQuery({
    queryKey: ['admin', 'products', filters.status, filters.search],
    queryFn: () => listProductsAdmin({ data: { status: filters.status, search: filters.search, limit: 200 } }),
  });

  return (
    <AdminPage
      title="Products"
      description="Stock is the sum of the active variants. Archiving hides a product from the storefront and keeps its order history."
      actions={
        <Link to="/admin/products/$slug" params={{ slug: 'new' }} className={adminButtonClass} data-testid="products-new">
          New product
        </Link>
      }
    >
      <Panel testId="products-filters">
        <form
          className="flex flex-wrap items-end gap-4"
          data-testid="products-filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters({ status: statusDraft, search: searchDraft.trim() });
          }}
        >
          <label className="flex-1 min-w-[220px]">
            <span className="field-label">Title, slug or category</span>
            <input
              className="field"
              type="search"
              value={searchDraft}
              data-testid="products-search"
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </label>
          <label className="min-w-[170px]">
            <span className="field-label">Status</span>
            <select
              className="field"
              value={statusDraft}
              data-testid="products-status"
              onChange={(event) => setStatusDraft(event.target.value)}
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status === 'all' ? 'All statuses' : status}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={adminButtonClass} data-testid="products-filter-submit">
            Apply
          </button>
        </form>
      </Panel>

      {query.isError ? (
        <ErrorNote>{query.error instanceof Error ? query.error.message : 'Products could not be loaded.'}</ErrorNote>
      ) : null}

      <Panel className="mt-6" testId="products-table">
        {query.isPending ? <p className="text-sm text-muted-foreground">Loading products…</p> : null}
        {query.data && query.data.products.length === 0 ? (
          <p className="text-sm text-muted-foreground">No products match that.</p>
        ) : null}
        {query.data && query.data.products.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground">
                  <th className="pb-3">Product</th>
                  <th className="pb-3">Category</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3 text-right">Variants</th>
                  <th className="pb-3 text-right">In stock</th>
                  <th className="pb-3 text-right">Price from</th>
                </tr>
              </thead>
              <tbody>
                {query.data.products.map((product) => {
                  const active = product.variants.filter((variant) => variant.is_active);
                  const cheapest = active.reduce<number | null>(
                    (lowest, variant) => (lowest === null || variant.price_minor < lowest ? variant.price_minor : lowest),
                    null
                  );
                  return (
                    <tr key={product.id} className="border-t border-border" data-testid={`product-row-${product.slug}`}>
                      <td className="py-3">
                        <Link
                          to="/admin/products/$slug"
                          params={{ slug: product.slug }}
                          className={adminLinkClass}
                        >
                          {product.title}
                        </Link>
                        <span className="block text-xs text-muted-foreground font-mono">{product.slug}</span>
                      </td>
                      <td className="py-3 text-muted-foreground">{product.category}</td>
                      <td className="py-3 uppercase text-[11px] tracking-widest">{product.status}</td>
                      <td className="py-3 text-right">{active.length}</td>
                      <td className="py-3 text-right" data-testid={`product-stock-${product.slug}`}>
                        {product.made_to_order ? 'Made to order' : activeStock(product.variants)}
                      </td>
                      <td className="py-3 text-right">
                        {formatMoney(cheapest ?? product.price_minor, product.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
    </AdminPage>
  );
}
