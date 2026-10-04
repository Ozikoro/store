import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AdminPage, Panel, ErrorNote } from '@/store/admin-layout';
import { Button } from '@/components/ui/button';
import { listStaffAccounts, setStaffRole } from '@/server/admin';

/**
 * Who can do what.
 *
 * Only a super admin sees this, and only a super admin can change it — the
 * capability check is on the server function, not on the link that reaches it.
 *
 * Granting a role clears the account's sessions, so a promotion or a revocation
 * takes effect at the next sign-in rather than up to thirty days later.
 */
export const Route = createFileRoute('/admin/permissions')({
  loader: async () => {
    try {
      const staff = await listStaffAccounts();
      return { staff, error: null as string | null };
    } catch (error) {
      return { staff: [], error: error instanceof Error ? error.message : 'Could not load staff accounts.' };
    }
  },
  component: Permissions,
});

const ROLES = [
  { value: 'store_admin', label: 'Store admin', detail: 'Products, prices, inventory, collections, orders, refunds.' },
  { value: 'fulfilment', label: 'Fulfilment', detail: 'Orders and shipments. Cannot change prices or refund.' },
  { value: 'content_manager', label: 'Content manager', detail: 'Store pages and editorial content.' },
  { value: 'super_admin', label: 'Super admin', detail: 'Everything, including permissions and integrations.' },
  { value: 'customer', label: 'Customer', detail: 'Remove all staff access.' },
] as const;

function Permissions() {
  const initial = Route.useLoaderData();
  const [staff, setStaff] = useState(initial.staff);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    initial.error ? { tone: 'error', text: initial.error } : null
  );

  async function grant(email: string, role: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await setStaffRole({ data: { email, role } });
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.error });
        return;
      }
      setMessage({
        tone: 'ok',
        text: `${result.email} is now ${role === 'customer' ? 'a customer' : result.role.replace('_', ' ')}. Their sessions were cleared, so it applies at their next sign-in.`,
      });
      const refreshed = await listStaffAccounts();
      setStaff(refreshed);
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminPage title="Permissions" description="Who can do what in this store.">
      {message && <ErrorNote tone={message.tone === 'ok' ? 'success' : 'error'}>{message.text}</ErrorNote>}

      <Panel title="Grant a role">
        <p className="text-sm text-muted-foreground mb-5">
          The person must have an account first — ask them to register at{' '}
          <span className="text-foreground">/account</span>, then grant the role here. A role is recorded on the
          account and copied into their session when they sign in.
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void grant(String(form.get('email') ?? ''), String(form.get('role') ?? 'store_admin'));
          }}
        >
          <label className="text-sm grid gap-2 flex-1 min-w-56">
            Email
            <input required type="email" name="email" className="field" data-testid="grant-email" />
          </label>
          <label className="text-sm grid gap-2">
            Role
            <select name="role" className="field" data-testid="grant-role">
              {ROLES.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy} data-testid="grant-submit">
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </form>
        <dl className="mt-6 grid gap-2 text-xs text-muted-foreground">
          {ROLES.map((role) => (
            <div key={role.value} className="flex gap-3">
              <dt className="w-32 shrink-0 font-semibold text-foreground">{role.label}</dt>
              <dd>{role.detail}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title={`Staff accounts (${staff.length})`}>
        {staff.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-staff">
            Nobody holds a staff role yet.
          </p>
        ) : (
          <div className="border-t border-border">
            {staff.map((account) => (
              <div
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-4"
                data-testid={`staff-${account.email}`}
              >
                <div>
                  <p className="font-medium">{account.name || account.email}</p>
                  <p className="text-xs text-muted-foreground">{account.email}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs uppercase tracking-widest font-semibold text-primary-strong">
                    {account.role.replace('_', ' ')}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => grant(account.email, 'customer')}
                    data-testid={`revoke-${account.email}`}
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </AdminPage>
  );
}
