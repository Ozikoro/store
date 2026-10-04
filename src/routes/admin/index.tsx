import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { getDashboard } from '@/server/admin';
import { AdminPage, ErrorNote, Panel, StatCard, adminLinkClass, formatDateTime } from '@/store/admin-layout';
import { storeHead } from '@/store/head';
import { formatMoney } from '@/lib/money';
import { ORDER_STATUS_LABELS } from '@/lib/order-state';

export const Route = createFileRoute('/admin/')({
  head: () =>
    storeHead({
      title: 'Admin dashboard',
      description: 'Revenue, orders and stock at a glance.',
      path: '/admin',
    }),
  component: Dashboard,
});

const WINDOWS = [30, 90, 365] as const;

function statusLabel(status: string): string {
  return (ORDER_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function Dashboard() {
  const [windowDays, setWindowDays] = useState<number>(30);
  const query = useQuery({
    queryKey: ['admin', 'dashboard', windowDays],
    queryFn: () => getDashboard({ data: { windowDays } }),
  });

  const data = query.data;
  const metrics = data?.metrics;
  const currency = metrics?.currency ?? 'NGN';
  const windowAov =
    metrics && metrics.windowOrderCount > 0 ? Math.round(metrics.windowRevenueMinor / metrics.windowOrderCount) : 0;

  return (
    <AdminPage
      title="Dashboard"
      description="Paid orders only. A pending order is not revenue, and the window figures sit beside the lifetime ones so a quiet month is visible."
      actions={
        <div className="flex gap-2" data-testid="dashboard-window">
          {WINDOWS.map((days) => (
            <button
              key={days}
              type="button"
              data-testid={`dashboard-window-${days}`}
              onClick={() => setWindowDays(days)}
              className={
                days === windowDays
                  ? 'h-10 border border-foreground bg-foreground px-4 text-xs font-semibold uppercase tracking-widest text-background'
                  : 'h-10 border border-border px-4 text-xs font-semibold uppercase tracking-widest'
              }
            >
              {days} days
            </button>
          ))}
        </div>
      }
    >
      {query.isPending ? <p className="text-muted-foreground">Loading the numbers…</p> : null}
      {query.isError ? (
        <ErrorNote>{query.error instanceof Error ? query.error.message : 'The dashboard could not be loaded.'}</ErrorNote>
      ) : null}

      {metrics ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            testId="metric-window-revenue"
            label={`Revenue · last ${metrics.windowDays} days`}
            value={formatMoney(metrics.windowRevenueMinor, currency)}
            hint={`${metrics.windowOrderCount} paid order${metrics.windowOrderCount === 1 ? '' : 's'}`}
          />
          <StatCard
            testId="metric-window-aov"
            label={`Average order · last ${metrics.windowDays} days`}
            value={formatMoney(windowAov, currency)}
            hint="Integer division, to the nearest kobo"
          />
          <StatCard
            testId="metric-all-revenue"
            label="Revenue · all time"
            value={formatMoney(metrics.grossRevenueMinor, currency)}
            hint={`${metrics.paidOrderCount} paid order${metrics.paidOrderCount === 1 ? '' : 's'}`}
          />
          <StatCard
            testId="metric-all-aov"
            label="Average order · all time"
            value={formatMoney(metrics.averageOrderValueMinor, currency)}
          />
          <StatCard
            testId="metric-orders-window"
            label={`Orders · last ${metrics.windowDays} days`}
            value={String(metrics.windowOrderCount)}
          />
          <StatCard
            testId="metric-pending"
            label="Awaiting payment"
            value={String(metrics.pendingOrderCount)}
            hint="Stock is reserved until these settle or are cancelled"
          />
          <StatCard
            testId="metric-unfulfilled"
            label="Paid, not sent"
            value={String(metrics.unfulfilledPaidCount)}
          />
          <StatCard
            testId="metric-low-stock"
            label="Low stock (3 or fewer)"
            value={String(metrics.lowStockCount)}
            hint="Across active variants"
          />
          <StatCard testId="metric-customers" label="Customers" value={String(metrics.customerCount)} />
          <StatCard
            testId="metric-refunded"
            label="Refunded orders · value"
            value={formatMoney(metrics.refundedMinor, currency)}
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2 mt-8">
        <Panel title="Top products" description="By units sold on paid orders." testId="panel-top-products">
          {metrics && metrics.topProducts.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground">
                  <th className="pb-3">Product</th>
                  <th className="pb-3">SKU</th>
                  <th className="pb-3 text-right">Units</th>
                  <th className="pb-3 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {metrics.topProducts.map((row) => (
                  <tr key={row.sku} className="border-t border-border">
                    <td className="py-3">
                      <Link to="/admin/products/$slug" params={{ slug: row.productSlug }} className={adminLinkClass}>
                        {row.title}
                      </Link>
                    </td>
                    <td className="py-3 text-muted-foreground">{row.sku}</td>
                    <td className="py-3 text-right">{row.quantity}</td>
                    <td className="py-3 text-right">{formatMoney(row.revenueMinor, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing has sold yet.</p>
          )}
        </Panel>

        <Panel title="Low-stock alerts" description="Three or fewer left on an active variant." testId="panel-low-stock">
          {data && data.lowStock.length > 0 ? (
            <ul className="text-sm">
              {data.lowStock.map((variant) => (
                <li key={variant.id} className="flex items-baseline justify-between gap-4 border-t border-border py-3">
                  <span>
                    <Link
                      to="/admin/products/$slug"
                      params={{ slug: variant.product_slug }}
                      className={adminLinkClass}
                    >
                      {variant.product_title}
                    </Link>
                    <span className="text-muted-foreground"> · {variant.title}</span>
                  </span>
                  <span className={variant.stock <= 0 ? 'text-destructive' : 'text-muted-foreground'}>
                    {variant.stock <= 0 ? 'Out of stock' : `${variant.stock} left`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Every active variant is above the threshold.</p>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 mt-6">
        <Panel
          title="Pending orders"
          description={`${data?.pendingTotal ?? 0} awaiting payment.`}
          testId="panel-pending-orders"
        >
          {data && data.pendingOrders.length > 0 ? (
            <ul className="text-sm">
              {data.pendingOrders.map((order) => (
                <li key={order.id} className="flex items-baseline justify-between gap-4 border-t border-border py-3">
                  <Link to="/admin/orders/$number" params={{ number: order.number }} className={adminLinkClass}>
                    {order.number}
                  </Link>
                  <span className="text-muted-foreground flex-1 truncate">{order.email}</span>
                  <span>{formatMoney(order.total_minor, order.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing is waiting on a payment.</p>
          )}
        </Panel>

        <Panel
          title="Paid, not fully sent"
          description={`${metrics?.unfulfilledPaidCount ?? 0} orders with something outstanding.`}
          testId="panel-unfulfilled-orders"
        >
          {data && data.unfulfilledOrders.length > 0 ? (
            <ul className="text-sm">
              {data.unfulfilledOrders.map((order) => (
                <li key={order.id} className="flex items-baseline justify-between gap-4 border-t border-border py-3">
                  <Link to="/admin/orders/$number" params={{ number: order.number }} className={adminLinkClass}>
                    {order.number}
                  </Link>
                  <span className="text-muted-foreground flex-1 truncate">{order.email}</span>
                  <span className="uppercase text-[11px] tracking-widest">{order.fulfilment_status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Every paid order has been sent.</p>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 mt-6">
        <Panel title="Recent orders" testId="panel-recent-orders">
          {metrics && metrics.recentOrders.length > 0 ? (
            <table className="w-full text-sm">
              <tbody>
                {metrics.recentOrders.map((order) => (
                  <tr key={order.number} className="border-t border-border">
                    <td className="py-3">
                      <Link to="/admin/orders/$number" params={{ number: order.number }} className={adminLinkClass}>
                        {order.number}
                      </Link>
                    </td>
                    <td className="py-3 text-muted-foreground truncate max-w-[16ch]">{order.email}</td>
                    <td className="py-3 text-[11px] uppercase tracking-widest">{statusLabel(order.status)}</td>
                    <td className="py-3 text-right">{formatMoney(order.total_minor, currency)}</td>
                    <td className="py-3 text-right text-xs text-muted-foreground">{formatDateTime(order.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No orders yet.</p>
          )}
        </Panel>

        <Panel title="Recent customers" testId="panel-recent-customers">
          {data && data.customers.length > 0 ? (
            <table className="w-full text-sm">
              <tbody>
                {data.customers.map((customer) => (
                  <tr key={customer.email} className="border-t border-border">
                    <td className="py-3">{customer.name || customer.email}</td>
                    <td className="py-3 text-muted-foreground">{customer.orderCount} orders</td>
                    <td className="py-3 text-right">{formatMoney(customer.lifetimeMinor, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No customers yet.</p>
          )}
        </Panel>
      </div>
    </AdminPage>
  );
}
