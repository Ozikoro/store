import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { listDiscountsAdmin, saveDiscount, toggleDiscount } from '@/server/admin';
import {
  AdminPage,
  ErrorNote,
  OkNote,
  Panel,
  adminButtonClass,
  formatDateTime,
} from '@/store/admin-layout';
import { formatMoney, minorToMajorString } from '@/lib/money';

export const Route = createFileRoute('/admin/discounts')({
  staticData: {
    seo: {
      title: 'Discounts',
      description: 'Discount codes for the Ozikoro Store.',
      kind: 'private',
      noindex: true,
    },
  },
  component: DiscountsAdmin,
});

type DiscountsResult = Awaited<ReturnType<typeof listDiscountsAdmin>>;
type Discount = DiscountsResult['discounts'][number];
type Feedback = { tone: 'ok' | 'error'; text: string } | null;

const KINDS = [
  { value: 'percentage', label: 'Percentage off' },
  { value: 'fixed', label: 'Fixed amount off' },
  { value: 'free_shipping', label: 'Free shipping' },
] as const;

function kindLabel(kind: string): string {
  const found = KINDS.find((entry) => entry.value === kind);
  return found ? found.label : kind;
}

function formatValue(discount: Discount): string {
  if (discount.kind === 'percentage') return `${discount.value}%`;
  if (discount.kind === 'fixed') return formatMoney(discount.value, 'NGN');
  return '—';
}

function toLocalInput(value: string | null): string {
  if (!value) return '';
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function DiscountsAdmin() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['admin', 'discounts'],
    queryFn: () => listDiscountsAdmin(),
  });

  const [code, setCode] = useState('');
  const [kind, setKind] = useState<string>('percentage');
  const [value, setValue] = useState('');
  const [minimumSubtotalMajor, setMinimumSubtotalMajor] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const save = useMutation({
    mutationFn: () =>
      saveDiscount({
        data: {
          code,
          kind,
          value,
          minimumSubtotalMajor,
          maxRedemptions,
          startsAt: fromLocalInput(startsAt),
          endsAt: fromLocalInput(endsAt),
          isActive,
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setFeedback({ tone: 'error', text: result.error });
        return;
      }
      setFeedback({ tone: 'ok', text: `Saved ${result.discount.code}.` });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'discounts'] });
    },
    onError: (error: unknown) => {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    },
  });

  const toggle = useMutation({
    mutationFn: (vars: { code: string; active: boolean }) => toggleDiscount({ data: vars }),
    onSuccess: (result) => {
      if (!result.ok) {
        setFeedback({ tone: 'error', text: result.error });
        return;
      }
      setFeedback({ tone: 'ok', text: 'Discount updated.' });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'discounts'] });
    },
    onError: (error: unknown) => {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    },
  });

  function edit(discount: Discount): void {
    setCode(discount.code);
    setKind(discount.kind);
    setValue(
      discount.kind === 'fixed'
        ? minorToMajorString(discount.value)
        : discount.kind === 'percentage'
          ? String(discount.value)
          : ''
    );
    setMinimumSubtotalMajor(
      discount.minimum_subtotal_minor ? minorToMajorString(discount.minimum_subtotal_minor) : ''
    );
    setMaxRedemptions(discount.max_redemptions === null ? '' : String(discount.max_redemptions));
    setStartsAt(toLocalInput(discount.starts_at));
    setEndsAt(toLocalInput(discount.ends_at));
    setIsActive(discount.is_active === 1);
    setFeedback(null);
  }

  return (
    <AdminPage
      title="Discounts"
      description="A code is checked again immediately before a payment is initialised, so an expired or exhausted code cannot be used even if it was applied to a cart."
    >
      {query.isError ? (
        <ErrorNote>{query.error instanceof Error ? query.error.message : 'Discounts could not be loaded.'}</ErrorNote>
      ) : null}

      <Panel title="Codes" testId="discounts-table">
        {query.isPending ? <p className="text-sm text-muted-foreground">Loading codes…</p> : null}
        {query.data && query.data.discounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">There are no discount codes yet.</p>
        ) : null}
        {query.data && query.data.discounts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground">
                  <th className="pb-3">Code</th>
                  <th className="pb-3">Kind</th>
                  <th className="pb-3">Value</th>
                  <th className="pb-3 text-right">Minimum</th>
                  <th className="pb-3 text-right">Used</th>
                  <th className="pb-3">Window</th>
                  <th className="pb-3">Active</th>
                  <th className="pb-3" />
                </tr>
              </thead>
              <tbody>
                {query.data.discounts.map((discount) => (
                  <tr key={discount.id} className="border-t border-border" data-testid={`discount-row-${discount.code}`}>
                    <td className="py-3 font-mono text-xs">{discount.code}</td>
                    <td className="py-3 text-muted-foreground">{kindLabel(discount.kind)}</td>
                    <td className="py-3">{formatValue(discount)}</td>
                    <td className="py-3 text-right">
                      {discount.minimum_subtotal_minor
                        ? formatMoney(discount.minimum_subtotal_minor, 'NGN')
                        : '—'}
                    </td>
                    <td className="py-3 text-right">
                      {discount.redemption_count}
                      {discount.max_redemptions === null ? '' : ` / ${discount.max_redemptions}`}
                    </td>
                    <td className="py-3 text-xs text-muted-foreground">
                      {discount.starts_at ? formatDateTime(discount.starts_at) : 'any time'}
                      {' → '}
                      {discount.ends_at ? formatDateTime(discount.ends_at) : 'no end'}
                    </td>
                    <td className="py-3 text-xs uppercase tracking-widest">
                      {discount.is_active ? 'yes' : 'no'}
                    </td>
                    <td className="py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="h-8 border border-border px-3 text-[11px] uppercase tracking-widest"
                          data-testid={`discount-edit-${discount.code}`}
                          onClick={() => edit(discount)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="h-8 border border-border px-3 text-[11px] uppercase tracking-widest disabled:opacity-40"
                          data-testid={`discount-toggle-${discount.code}`}
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate({ code: discount.code, active: discount.is_active !== 1 })}
                        >
                          {discount.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <Panel
        className="mt-6"
        title="Create or update a code"
        description="Saving a code that already exists updates it. A fixed amount is entered in naira."
        testId="discount-form-panel"
      >
        <form
          data-testid="discount-form"
          onSubmit={(event) => {
            event.preventDefault();
            setFeedback(null);
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <label className="block">
              <span className="field-label">Code</span>
              <input
                className="field uppercase"
                value={code}
                data-testid="discount-code"
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="field-label">Kind</span>
              <select
                className="field"
                value={kind}
                data-testid="discount-kind"
                onChange={(event) => setKind(event.target.value)}
              >
                {KINDS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">
                {kind === 'percentage' ? 'Percent (0–100)' : kind === 'fixed' ? 'Amount off' : 'Nothing to set'}
              </span>
              <input
                className="field"
                value={value}
                data-testid="discount-value"
                disabled={kind === 'free_shipping'}
                placeholder={kind === 'percentage' ? '10' : '2500'}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="field-label">Minimum basket</span>
              <input
                className="field"
                value={minimumSubtotalMajor}
                data-testid="discount-minimum"
                placeholder="50000"
                onChange={(event) => setMinimumSubtotalMajor(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="field-label">Maximum redemptions (blank is unlimited)</span>
              <input
                className="field"
                type="number"
                min={0}
                value={maxRedemptions}
                data-testid="discount-max-redemptions"
                onChange={(event) => setMaxRedemptions(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-3 text-sm pt-6">
              <input
                type="checkbox"
                checked={isActive}
                data-testid="discount-active"
                onChange={(event) => setIsActive(event.target.checked)}
              />
              Available to use
            </label>
            <label className="block">
              <span className="field-label">Starts</span>
              <input
                className="field"
                type="datetime-local"
                value={startsAt}
                data-testid="discount-starts-at"
                onChange={(event) => setStartsAt(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="field-label">Ends</span>
              <input
                className="field"
                type="datetime-local"
                value={endsAt}
                data-testid="discount-ends-at"
                onChange={(event) => setEndsAt(event.target.value)}
              />
            </label>
          </div>
          <button
            type="submit"
            className={`${adminButtonClass} mt-6`}
            data-testid="discount-save"
            disabled={save.isPending}
          >
            Save code
          </button>
        </form>
        {feedback?.tone === 'error' ? <ErrorNote testId="discount-error">{feedback.text}</ErrorNote> : null}
        {feedback?.tone === 'ok' ? <OkNote testId="discount-ok">{feedback.text}</OkNote> : null}
      </Panel>
    </AdminPage>
  );
}
