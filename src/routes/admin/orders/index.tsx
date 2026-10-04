import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { listOrdersAdmin } from '@/server/admin';
import { AdminPage, ErrorNote, Panel, adminButtonClass, adminLinkClass, formatDateTime } from '@/store/admin-layout';
import { formatMoney } from '@/lib/money';
import { ORDER_STATUSES, ORDER_STATUS_LABELS } from '@/lib/order-state';

export const Route = createFileRoute('/admin/orders/')({
  staticData: {
    seo: {
      title: 'Orders',
      description: 'Ozikoro Store orders.',
      kind: 'private',
      noindex: true,
    },
  },
  component: OrdersAdmin,
});

const PAGE_SIZE = 25;

function statusLabel(status: string): string {
  return (ORDER_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function OrdersAdmin() {
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['admin', 'orders', status, search, page],
    queryFn: () => listOrdersAdmin({ data: { status, search, page, perPage: PAGE_SIZE } }),
  });

  const data = query.data;

  return (
    <AdminPage
      title="Orders"
      description="Every order, newest first. Search matches the order number or the email it was placed with."
    >
      <Panel testId="orders-filters">
        <form
          className="flex flex-wrap items-end gap-4"
          data-testid="orders-filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft.trim());
            setPage(1);
          }}
        >
          <label className="flex-1 min-w-[220px]">
            <span className="field-label">Number or email</span>
            <input
              className="field"
              type="search"
              name="search"
              value={searchDraft}
              data-testid="orders-search"
              placeholder="OZK-10428 or buyer@example.com"
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </label>
          <label className="min-w-[180px]">
            <span className="field-label">Status</span>
            <select
              className="field"
              name="status"
              value={status}
              data-testid="orders-status"
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All statuses</option>
              {ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {ORDER_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={adminButtonClass} data-testid="orders-filter-submit">
            Apply
          </button>
        </form>
      </Panel>

      {query.isError ? (
        <ErrorNote>{query.error instanceof Error ? query.error.message : 'Orders could not be loaded.'}</ErrorNote>
      ) : null}

      <Panel className="mt-6" testId="orders-table">
        {query.isPending ? <p className="text-sm text-muted-foreground">Loading orders…</p> : null}
        {data && data.orders.length === 0 ? <p className="text-sm text-muted-foreground">No orders match that.</p> : null}
        {data && data.orders.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground">
                  <th className="pb-3">Order</th>
                  <th className="pb-3">Placed</th>
                  <th className="pb-3">Customer</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3">Payment</th>
                  <th className="pb-3">Fulfilment</th>
                  <th className="pb-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr key={order.id} className="border-t border-border" data-testid={`order-row-${order.number}`}>
                    <td className="py-3">
                      <Link to="/admin/orders/$number" params={{ number: order.number }} className={adminLinkClass}>
                        {order.number}
                      </Link>
                    </td>
                    <td className="py-3 text-xs text-muted-foreground">{formatDateTime(order.created_at)}</td>
                    <td className="py-3">{order.email}</td>
                    <td className="py-3 uppercase text-[11px] tracking-widest">{statusLabel(order.status)}</td>
                    <td className="py-3 text-xs uppercase tracking-widest text-muted-foreground">
                      {order.payment_status}
                    </td>
                    <td className="py-3 text-xs uppercase tracking-widest text-muted-foreground">
                      {order.fulfilment_status}
                    </td>
                    <td className="py-3 text-right">{formatMoney(order.total_minor, order.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {data ? (
          <div className="flex items-center justify-between gap-4 mt-6 text-xs">
            <span className="text-muted-foreground" data-testid="orders-total">
              {data.total} order{data.total === 1 ? '' : 's'} · page {data.page} of {data.pageCount}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="h-9 border border-border px-3 uppercase tracking-widest disabled:opacity-40"
                data-testid="orders-prev"
                disabled={data.page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="h-9 border border-border px-3 uppercase tracking-widest disabled:opacity-40"
                data-testid="orders-next"
                disabled={data.page >= data.pageCount}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </Panel>
    </AdminPage>
  );
}
