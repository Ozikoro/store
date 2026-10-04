/**
 * Admin metrics.
 *
 * The handoff asks for four numbers: revenue, orders, average order value and
 * top products. Every one of them is computed from PAID orders only — a pending
 * order is not revenue, and counting it is how a dashboard lies to its owner.
 *
 * The queries are grouped in a single batch so the dashboard costs one round
 * trip, not six.
 */

import { db } from './env';

export interface DashboardMetrics {
  currency: string;
  paidOrderCount: number;
  grossRevenueMinor: number;
  averageOrderValueMinor: number;
  pendingOrderCount: number;
  unfulfilledPaidCount: number;
  refundedMinor: number;
  customerCount: number;
  lowStockCount: number;
  windowDays: number;
  windowRevenueMinor: number;
  windowOrderCount: number;
  topProducts: Array<{
    title: string;
    productSlug: string;
    sku: string;
    quantity: number;
    revenueMinor: number;
  }>;
  recentOrders: Array<{
    number: string;
    email: string;
    status: string;
    payment_status: string;
    total_minor: number;
    created_at: string;
  }>;
  revenueByDay: Array<{ day: string; revenueMinor: number; orders: number }>;
}

const PAID_STATUSES = `('paid','processing','fulfilled','shipped','delivered','partially_refunded','refunded')`;

export function averageOrderValue(grossRevenueMinor: number, paidOrderCount: number): number {
  if (paidOrderCount <= 0) return 0;
  // Integer division, rounded to the nearest kobo. An average is display-only,
  // but it should still not be a float.
  return Math.round(grossRevenueMinor / paidOrderCount);
}

export async function dashboardMetrics(windowDays = 30): Promise<DashboardMetrics> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const batch = await db().batch<Record<string, unknown>>([
    db()
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_minor), 0) AS revenue
           FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded')`
      ),
    db()
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_minor), 0) AS revenue
           FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded') AND created_at >= ?1`
      )
      .bind(since),
    db().prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'`),
    db()
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
          WHERE payment_status = 'paid' AND fulfilment_status IN ('unfulfilled','partial')`
      ),
    db()
      .prepare(`SELECT COALESCE(SUM(total_minor), 0) AS n FROM orders WHERE payment_status = 'refunded'`),
    db().prepare('SELECT COUNT(*) AS n FROM customers'),
    db()
      .prepare(
        `SELECT COUNT(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE v.is_active = 1 AND v.stock <= 3 AND p.status != 'archived'`
      ),
    db()
      .prepare(
        `SELECT oi.title, oi.product_slug, oi.sku,
                SUM(oi.quantity) AS quantity,
                SUM(oi.line_total_minor) AS revenue
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.payment_status IN ('paid','partially_refunded','refunded')
          GROUP BY oi.sku
          ORDER BY quantity DESC
          LIMIT 8`
      ),
    db()
      .prepare(
        `SELECT number, email, status, payment_status, total_minor, created_at
           FROM orders ORDER BY created_at DESC LIMIT 8`
      ),
    db()
      .prepare(
        `SELECT date(created_at) AS day,
                COALESCE(SUM(total_minor), 0) AS revenue,
                COUNT(*) AS orders
           FROM orders
          WHERE payment_status IN ('paid','partially_refunded','refunded') AND created_at >= ?1
          GROUP BY date(created_at)
          ORDER BY day`
      )
      .bind(since),
  ]);

  // `batch` resolves one result per statement, in order. Destructuring with a
  // fallback keeps the reads total even if a driver ever returns fewer entries.
  const at = (index: number): Record<string, unknown> => batch[index]?.results?.[0] ?? {};
  const rows = (index: number): Record<string, unknown>[] => batch[index]?.results ?? [];

  const totalRow = at(0) as { n?: number; revenue?: number };
  const windowRow = at(1) as { n?: number; revenue?: number };
  const pendingRow = at(2) as { n?: number };
  const unfulfilledRow = at(3) as { n?: number };
  const refundsRow = at(4) as { n?: number };
  const customersRow = at(5) as { n?: number };
  const lowStockRow = at(6) as { n?: number };

  const paidOrderCount = Number(totalRow.n ?? 0);
  const grossRevenueMinor = Number(totalRow.revenue ?? 0);

  return {
    currency: 'NGN',
    paidOrderCount,
    grossRevenueMinor,
    averageOrderValueMinor: averageOrderValue(grossRevenueMinor, paidOrderCount),
    pendingOrderCount: Number(pendingRow.n ?? 0),
    unfulfilledPaidCount: Number(unfulfilledRow.n ?? 0),
    refundedMinor: Number(refundsRow.n ?? 0),
    customerCount: Number(customersRow.n ?? 0),
    lowStockCount: Number(lowStockRow.n ?? 0),
    windowDays,
    windowRevenueMinor: Number(windowRow.revenue ?? 0),
    windowOrderCount: Number(windowRow.n ?? 0),
    topProducts: rows(7) as DashboardMetrics['topProducts'],
    recentOrders: rows(8) as DashboardMetrics['recentOrders'],
    revenueByDay: rows(9).map((row) => {
      const item = row as { day: string; revenue: number; orders: number };
      return { day: item.day, revenueMinor: Number(item.revenue ?? 0), orders: Number(item.orders ?? 0) };
    }),
  };
}

export interface CustomerSummary {
  email: string;
  name: string;
  orderCount: number;
  lifetimeMinor: number;
  lastOrderAt: string | null;
}

export async function recentCustomers(limit = 50): Promise<CustomerSummary[]> {
  const result = await db()
    .prepare(
      `SELECT c.email, c.name,
              COUNT(o.id) AS orderCount,
              COALESCE(SUM(CASE WHEN o.payment_status IN ('paid','partially_refunded','refunded') THEN o.total_minor ELSE 0 END), 0) AS lifetimeMinor,
              MAX(o.created_at) AS lastOrderAt
         FROM customers c
         LEFT JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at DESC
        LIMIT ?1`
    )
    .bind(limit)
    .all<{ email: string; name: string; orderCount: number; lifetimeMinor: number; lastOrderAt: string | null }>();
  return result.results ?? [];
}

export { PAID_STATUSES };
