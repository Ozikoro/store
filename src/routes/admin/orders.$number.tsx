import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  addShipment,
  advanceOrderStatus,
  fulfilItems,
  getOrderDetail,
  refundOrder,
  setOrderNote,
  setShipmentStatus,
} from '@/server/admin';
import {
  AdminPage,
  ErrorNote,
  OkNote,
  Panel,
  adminButtonClass,
  adminLinkClass,
  adminQuietButtonClass,
  formatDateTime,
} from '@/store/admin-layout';
import { formatMoney } from '@/lib/money';
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  SHIPMENT_STATUSES,
  canTransition,
  canTransitionShipment,
  type OrderStatus,
  type ShipmentStatus,
} from '@/lib/order-state';

export const Route = createFileRoute('/admin/orders/$number')({
  staticData: {
    seo: {
      title: 'Order',
      description: 'An Ozikoro Store order.',
      kind: 'private',
      noindex: true,
    },
  },
  component: OrderDetailPage,
});

type OrderDetailOk = Extract<Awaited<ReturnType<typeof getOrderDetail>>, { ok: true }>;
type OrderRow = OrderDetailOk['order'];
type OrderItem = OrderDetailOk['items'][number];
type Shipment = OrderDetailOk['shipments'][number];

type ActionResult = { ok: true } | { ok: false; error: string };

/** One mutation plus the one line of feedback the operator needs to read. */
function useAdminAction<TVars, TResult extends ActionResult>(
  run: (vars: TVars) => Promise<TResult>,
  orderNumber: string
) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const mutation = useMutation({
    mutationFn: run,
    onSuccess: (result) => {
      if (result.ok) {
        setNote({ tone: 'ok', text: 'Saved.' });
        void queryClient.invalidateQueries({ queryKey: ['admin', 'order', orderNumber] });
        void queryClient.invalidateQueries({ queryKey: ['admin', 'orders'] });
      } else {
        setNote({ tone: 'error', text: result.error });
      }
    },
    onError: (error: unknown) => {
      setNote({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    },
  });

  return { mutation, note };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function addressLines(value: string): string[] {
  const address = safeJson(value);
  const read = (key: string): string => {
    const found = address[key];
    return typeof found === 'string' ? found : '';
  };
  return [
    [read('firstName'), read('lastName')].filter(Boolean).join(' '),
    read('line1'),
    read('line2'),
    [read('city'), read('region')].filter(Boolean).join(', '),
    read('postalCode'),
    read('country'),
    read('phone'),
  ].filter((line) => line.trim().length > 0);
}

function statusLabel(status: string): string {
  return (ORDER_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function OrderDetailPage() {
  const { number } = Route.useParams();
  const query = useQuery({
    queryKey: ['admin', 'order', number],
    queryFn: () => getOrderDetail({ data: { number } }),
  });

  const detail = query.data;

  if (query.isPending) {
    return (
      <AdminPage title={`Order ${number}`}>
        <p className="text-sm text-muted-foreground">Loading the order…</p>
      </AdminPage>
    );
  }

  if (query.isError) {
    return (
      <AdminPage title={`Order ${number}`}>
        <ErrorNote>{query.error instanceof Error ? query.error.message : 'The order could not be loaded.'}</ErrorNote>
      </AdminPage>
    );
  }

  if (!detail) return null;

  if (!detail.ok) {
    return (
      <AdminPage title={`Order ${number}`}>
        <ErrorNote>{detail.error}</ErrorNote>
        <Link to="/admin/orders" className={`${adminLinkClass} inline-block mt-6`}>
          Back to orders
        </Link>
      </AdminPage>
    );
  }

  const { order, items, payments, shipments, refunds, audit, refundableMinor } = detail;
  const currency = order.currency;
  const shippingLines = addressLines(order.shipping_address);
  const billingLines = addressLines(order.billing_address);

  return (
    <AdminPage
      eyebrow="Order"
      title={order.number}
      description={`Placed ${formatDateTime(order.created_at)} by ${order.email}`}
      actions={
        <Link to="/admin/orders" className={adminQuietButtonClass}>
          All orders
        </Link>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCell label="Status" value={statusLabel(order.status)} testId="order-status" />
        <SummaryCell label="Payment" value={order.payment_status} testId="order-payment-status" />
        <SummaryCell label="Fulfilment" value={order.fulfilment_status} testId="order-fulfilment-status" />
        <SummaryCell label="Total" value={formatMoney(order.total_minor, currency)} testId="order-total" />
        <SummaryCell label="Subtotal" value={formatMoney(order.subtotal_minor, currency)} />
        <SummaryCell
          label="Discount"
          value={`${formatMoney(order.discount_minor, currency)}${order.discount_code ? ` · ${order.discount_code}` : ''}`}
        />
        <SummaryCell label="Shipping" value={`${formatMoney(order.shipping_minor, currency)} · ${order.shipping_method || '—'}`} />
        <SummaryCell label="Paid at" value={formatDateTime(order.paid_at)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2 mt-8">
        <AdvancePanel order={order} />
        <NotePanel order={order} />
      </div>

      <Panel className="mt-6" title="Items" description="Mark what has actually been packed." testId="panel-items">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground">
                <th className="pb-3">Item</th>
                <th className="pb-3">SKU</th>
                <th className="pb-3 text-right">Unit</th>
                <th className="pb-3 text-right">Qty</th>
                <th className="pb-3 text-right">Sent</th>
                <th className="pb-3 text-right">Line total</th>
                <th className="pb-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <FulfilRow key={item.id} item={item} order={order} currency={currency} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2 mt-6">
        <Panel title="Shipping address" testId="panel-shipping-address">
          {shippingLines.length ? (
            <address className="not-italic text-sm leading-relaxed">
              {shippingLines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
          ) : (
            <p className="text-sm text-muted-foreground">No shipping address was recorded.</p>
          )}
        </Panel>
        <Panel title="Billing address" testId="panel-billing-address">
          {billingLines.length ? (
            <address className="not-italic text-sm leading-relaxed">
              {billingLines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
          ) : (
            <p className="text-sm text-muted-foreground">No billing address was recorded.</p>
          )}
        </Panel>
      </div>

      <Panel className="mt-6" title="Payment record" testId="panel-payments">
        {payments.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground">
                  <th className="pb-3">Reference</th>
                  <th className="pb-3">Provider ref</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3 text-right">Amount</th>
                  <th className="pb-3">Settled</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-t border-border">
                    <td className="py-3 font-mono text-xs">{payment.reference}</td>
                    <td className="py-3 font-mono text-xs text-muted-foreground">
                      {payment.provider_reference ?? '—'}
                    </td>
                    <td className="py-3 uppercase text-[11px] tracking-widest">{payment.status}</td>
                    <td className="py-3 text-right">{formatMoney(payment.amount_minor, payment.currency)}</td>
                    <td className="py-3 text-xs text-muted-foreground">{formatDateTime(payment.settled_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No payment has been initialised against this order.</p>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2 mt-6">
        <ShipmentPanel order={order} shipments={shipments} />
        <Panel
          className="mt-0"
          title="Refunds"
          description={`${formatMoney(refundableMinor, currency)} still refundable. A refund executes against the gateway immediately.`}
          testId="panel-refunds"
        >
          {refunds.length ? (
            <ul className="text-sm mb-5">
              {refunds.map((refund) => (
                <li key={refund.id} className="border-t border-border py-3">
                  <div className="flex items-baseline justify-between gap-4">
                    <span>{formatMoney(refund.amount_minor, currency)}</span>
                    <span className="uppercase text-[11px] tracking-widest">{refund.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{refund.reason || 'No reason recorded.'}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {refund.created_by || 'unknown'} · {formatDateTime(refund.created_at)}
                    {refund.restock ? ' · restocks' : ' · no restock'}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground mb-5">Nothing has been refunded.</p>
          )}
          <RefundForm order={order} refundableMinor={refundableMinor} />
        </Panel>
      </div>

      <Panel className="mt-6" title="Audit trail" description="Order, refund and shipment changes." testId="panel-audit">
        {audit.length ? (
          <ul className="text-sm">
            {audit.map((row) => (
              <li key={row.id} className="border-t border-border py-3" data-testid={`audit-row-${row.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-mono text-xs">{row.action}</span>
                  <span className="text-xs text-muted-foreground">
                    {row.actor_email || 'system'} · {formatDateTime(row.created_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
                  {row.entity}/{row.entity_id}
                </p>
                <details className="mt-2">
                  <summary className="text-xs cursor-pointer">Before and after</summary>
                  <pre className="text-[11px] mt-2 overflow-x-auto bg-secondary p-2">{`before ${row.before}\nafter  ${row.after}`}</pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing has been recorded against this order yet.</p>
        )}
      </Panel>
    </AdminPage>
  );
}

function SummaryCell({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="border border-border bg-card p-4" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
      <p className="mt-2">{value}</p>
    </div>
  );
}

function AdvancePanel({ order }: { order: OrderRow }) {
  // `paid` is never offered: an order becomes paid only when its payment
  // settles, and the state machine says so.
  const options = ORDER_STATUSES.filter(
    (status) => status !== order.status && status !== 'paid' && canTransition(order.status, status)
  );
  const [to, setTo] = useState<string>(options[0] ?? '');
  const [note, setNote] = useState('');
  const { mutation, note: feedback } = useAdminAction<{ to: string; note: string }, ActionResult>(
    (vars) => advanceOrderStatus({ data: { orderId: order.id, to: vars.to, note: vars.note } }),
    order.number
  );

  return (
    <Panel title="Advance status" description={`Currently ${statusLabel(order.status)}.`} testId="panel-advance-status">
      {options.length ? (
        <form
          data-testid="advance-status-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (to) mutation.mutate({ to, note });
          }}
        >
          <label className="block">
            <span className="field-label">Move to</span>
            <select
              className="field"
              value={to}
              data-testid="advance-status-select"
              onChange={(event) => setTo(event.target.value)}
            >
              {options.map((status) => (
                <option key={status} value={status}>
                  {ORDER_STATUS_LABELS[status as OrderStatus]}
                </option>
              ))}
            </select>
          </label>
          <label className="block mt-4">
            <span className="field-label">Note (optional)</span>
            <input
              className="field"
              value={note}
              data-testid="advance-status-note"
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why this changed"
            />
          </label>
          <button
            type="submit"
            className={`${adminButtonClass} mt-4`}
            data-testid="advance-status-submit"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : 'Change status'}
          </button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          {order.status === 'refunded' || order.status === 'cancelled'
            ? 'This order is closed; nothing further can be done to it.'
            : 'There is no legal next status from here.'}
        </p>
      )}
      {feedback?.tone === 'error' ? <ErrorNote testId="advance-status-error">{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote>Status updated.</OkNote> : null}
      {order.admin_note ? (
        <p className="text-xs text-muted-foreground mt-4">Current admin note: {order.admin_note}</p>
      ) : null}
    </Panel>
  );
}

function NotePanel({ order }: { order: OrderRow }) {
  const [note, setNote] = useState(order.admin_note);
  const { mutation, note: feedback } = useAdminAction<{ note: string }, ActionResult>(
    (vars) => setOrderNote({ data: { orderId: order.id, note: vars.note } }),
    order.number
  );

  return (
    <Panel title="Internal note" description="Only staff see this." testId="panel-order-note">
      <form
        data-testid="order-note-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({ note });
        }}
      >
        <label className="block">
          <span className="field-label">Note</span>
          <textarea
            className="field h-28 py-3"
            value={note}
            data-testid="order-note"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className={`${adminButtonClass} mt-4`}
          data-testid="order-note-submit"
          disabled={mutation.isPending}
        >
          Save note
        </button>
      </form>
      {order.customer_note ? (
        <p className="text-xs text-muted-foreground mt-4">Customer note: {order.customer_note}</p>
      ) : null}
      {feedback?.tone === 'error' ? <ErrorNote testId="order-note-error">{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote>Note saved.</OkNote> : null}
    </Panel>
  );
}

function FulfilRow({ item, order, currency }: { item: OrderItem; order: OrderRow; currency: string }) {
  const outstanding = Math.max(0, item.quantity - item.quantity_fulfilled);
  const [quantity, setQuantity] = useState(String(outstanding > 0 ? outstanding : 0));
  const { mutation, note: feedback } = useAdminAction<{ quantity: number }, ActionResult>(
    (vars) => fulfilItems({ data: { orderId: order.id, itemId: item.id, quantity: vars.quantity } }),
    order.number
  );

  return (
    <tr className="border-t border-border" data-testid={`item-row-${item.id}`}>
      <td className="py-3">
        <span className="block">{item.title}</span>
        {item.variant_title ? <span className="text-xs text-muted-foreground">{item.variant_title}</span> : null}
      </td>
      <td className="py-3 font-mono text-xs text-muted-foreground">{item.sku}</td>
      <td className="py-3 text-right">{formatMoney(item.unit_price_minor, currency)}</td>
      <td className="py-3 text-right">{item.quantity}</td>
      <td className="py-3 text-right">{item.quantity_fulfilled}</td>
      <td className="py-3 text-right">{formatMoney(item.line_total_minor, currency)}</td>
      <td className="py-3">
        {outstanding > 0 ? (
          <form
            className="flex items-center gap-2 justify-end"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate({ quantity: Number(quantity) });
            }}
          >
            <input
              className="field h-9 w-16 px-2 text-right"
              type="number"
              min={1}
              max={outstanding}
              value={quantity}
              data-testid={`fulfil-qty-${item.id}`}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <button
              type="submit"
              className="h-9 border border-border px-3 text-xs uppercase tracking-widest disabled:opacity-40"
              data-testid={`fulfil-submit-${item.id}`}
              disabled={mutation.isPending}
            >
              Sent
            </button>
            {feedback?.tone === 'error' ? (
              <span className="text-xs text-destructive" data-testid={`fulfil-error-${item.id}`}>
                {feedback.text}
              </span>
            ) : null}
          </form>
        ) : (
          <span className="text-xs text-muted-foreground block text-right">Fully sent</span>
        )}
      </td>
    </tr>
  );
}

function ShipmentPanel({ order, shipments }: { order: OrderRow; shipments: Shipment[] }) {
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [shipmentNote, setShipmentNote] = useState('');
  const { mutation, note: feedback } = useAdminAction<
    { carrier: string; trackingNumber: string; trackingUrl: string; note: string },
    ActionResult
  >(
    (vars) =>
      addShipment({
        data: {
          orderId: order.id,
          carrier: vars.carrier,
          trackingNumber: vars.trackingNumber,
          trackingUrl: vars.trackingUrl,
          note: vars.note,
        },
      }),
    order.number
  );

  return (
    <Panel title="Shipments" description="A parcel can leave before the rest of the order does." testId="panel-shipments">
      {shipments.length ? (
        <ul className="text-sm mb-5">
          {shipments.map((shipment) => (
            <ShipmentRow key={shipment.id} shipment={shipment} order={order} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground mb-5">Nothing has been dispatched yet.</p>
      )}

      <form
        data-testid="shipment-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({ carrier, trackingNumber, trackingUrl, note: shipmentNote });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Carrier</span>
            <input
              className="field"
              value={carrier}
              data-testid="shipment-carrier"
              onChange={(event) => setCarrier(event.target.value)}
              placeholder="GIG Logistics"
            />
          </label>
          <label className="block">
            <span className="field-label">Tracking number</span>
            <input
              className="field"
              value={trackingNumber}
              data-testid="shipment-tracking-number"
              onChange={(event) => setTrackingNumber(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Tracking URL (optional)</span>
            <input
              className="field"
              type="url"
              value={trackingUrl}
              data-testid="shipment-tracking-url"
              onChange={(event) => setTrackingUrl(event.target.value)}
              placeholder="https://"
            />
          </label>
          <label className="block">
            <span className="field-label">Note (optional)</span>
            <input
              className="field"
              value={shipmentNote}
              data-testid="shipment-note"
              onChange={(event) => setShipmentNote(event.target.value)}
            />
          </label>
        </div>
        <button
          type="submit"
          className={`${adminButtonClass} mt-4`}
          data-testid="shipment-submit"
          disabled={mutation.isPending}
        >
          Record shipment
        </button>
      </form>
      {feedback?.tone === 'error' ? <ErrorNote testId="shipment-error">{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote>Shipment recorded.</OkNote> : null}
    </Panel>
  );
}

function ShipmentRow({ shipment, order }: { shipment: Shipment; order: OrderRow }) {
  const options = SHIPMENT_STATUSES.filter(
    (status) => status === shipment.status || canTransitionShipment(shipment.status as ShipmentStatus, status)
  );
  const [status, setStatus] = useState<string>(shipment.status);
  const { mutation, note: feedback } = useAdminAction<{ status: string }, ActionResult>(
    (vars) => setShipmentStatus({ data: { shipmentId: shipment.id, status: vars.status } }),
    order.number
  );

  return (
    <li className="border-t border-border py-3" data-testid={`shipment-${shipment.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span>
          {shipment.carrier} · <span className="font-mono text-xs">{shipment.tracking_number}</span>
        </span>
        <span className="uppercase text-[11px] tracking-widest">{shipment.status}</span>
      </div>
      {shipment.note ? <p className="text-xs text-muted-foreground mt-1">{shipment.note}</p> : null}
      {shipment.tracking_url ? (
        <a href={shipment.tracking_url} className={`${adminLinkClass} inline-block mt-1`} target="_blank" rel="noreferrer">
          Tracking link
        </a>
      ) : null}
      <form
        className="flex items-end gap-3 mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({ status });
        }}
      >
        <label className="block">
          <span className="field-label">Shipment status</span>
          <select
            className="field h-9 py-0"
            value={status}
            data-testid={`shipment-status-${shipment.id}`}
            onChange={(event) => setStatus(event.target.value)}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {option.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="h-9 border border-border px-3 text-xs uppercase tracking-widest disabled:opacity-40"
          data-testid={`shipment-status-submit-${shipment.id}`}
          disabled={mutation.isPending}
        >
          Update
        </button>
      </form>
      {feedback?.tone === 'error' ? <ErrorNote testId={`shipment-status-error-${shipment.id}`}>{feedback.text}</ErrorNote> : null}
    </li>
  );
}

function RefundForm({ order, refundableMinor }: { order: OrderRow; refundableMinor: number }) {
  const [amountMajor, setAmountMajor] = useState('');
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const { mutation, note: feedback } = useAdminAction<{ amountMajor: string; reason: string; restock: boolean }, ActionResult>(
    (vars) => refundOrder({ data: { orderId: order.id, amountMajor: vars.amountMajor, reason: vars.reason, restock: vars.restock } }),
    order.number
  );

  const canRefund = order.payment_status === 'paid' || order.payment_status === 'partially_refunded';

  if (!canRefund) {
    return (
      <p className="text-sm text-muted-foreground">
        Only a paid order can be refunded. This one is {order.payment_status}.
      </p>
    );
  }

  return (
    <form
      data-testid="refund-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirming) {
          setConfirming(true);
          return;
        }
        mutation.mutate({ amountMajor, reason, restock });
        setConfirming(false);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Amount ({order.currency})</span>
          <input
            className="field"
            value={amountMajor}
            data-testid="refund-amount"
            placeholder="18500"
            onChange={(event) => {
              setAmountMajor(event.target.value);
              setConfirming(false);
            }}
          />
        </label>
        <label className="block">
          <span className="field-label">Reason</span>
          <input
            className="field"
            value={reason}
            data-testid="refund-reason"
            onChange={(event) => {
              setReason(event.target.value);
              setConfirming(false);
            }}
          />
        </label>
      </div>
      <label className="flex items-center gap-3 mt-4 text-sm">
        <input
          type="checkbox"
          checked={restock}
          data-testid="refund-restock"
          onChange={(event) => setRestock(event.target.checked)}
        />
        Put returned units back in stock
      </label>
      <button
        type="submit"
        className={`${adminButtonClass} mt-4`}
        data-testid="refund-submit"
        disabled={mutation.isPending}
      >
        {confirming ? 'Confirm refund' : 'Refund'}
      </button>
      {confirming ? (
        <p className="text-xs text-muted-foreground mt-2">
          This sends the money back through the gateway. Press again to confirm.
        </p>
      ) : null}
      {feedback?.tone === 'error' ? <ErrorNote testId="refund-error">{feedback.text}</ErrorNote> : null}
      {feedback?.tone === 'ok' ? <OkNote>Refund executed.</OkNote> : null}
      <p className="text-xs text-muted-foreground mt-3">
        Refundable now: {formatMoney(refundableMinor, order.currency)}
      </p>
    </form>
  );
}
