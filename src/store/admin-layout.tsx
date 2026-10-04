/**
 * The admin shell and the small pieces of UI the admin pages share.
 *
 * The shell is the only place that decides whether the admin surface renders at
 * all. `getAdminSession` re-resolves the actor on the server, so a customer who
 * types /admin sees the not-authorised panel — and, more importantly, the child
 * routes never mount, so none of their server functions are reachable from an
 * unauthorised browser. The server functions are guarded independently; this is
 * presentation, not the security boundary.
 *
 * Nav items are gated on the capability the matching server function requires,
 * read from the same `roles.ts` table the server enforces. A fulfilment user
 * sees Orders; a content manager sees Products; a store admin sees everything.
 */

import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { getAdminSession } from '@/server/admin';
import { can, type Capability } from '@/lib/roles';

interface NavItem {
  label: string;
  to:
    | '/admin'
    | '/admin/orders'
    | '/admin/products'
    | '/admin/discounts'
    | '/admin/audit'
    | '/admin/permissions';
  capability: Capability;
}

const NAV: readonly NavItem[] = [
  { label: 'Dashboard', to: '/admin', capability: 'dashboard:read' },
  { label: 'Orders', to: '/admin/orders', capability: 'orders:read:all' },
  { label: 'Products', to: '/admin/products', capability: 'catalog:read' },
  { label: 'Discounts', to: '/admin/discounts', capability: 'catalog:write' },
  { label: 'Audit', to: '/admin/audit', capability: 'dashboard:read' },
  // Only a super admin sees this link, and only a super admin can call the
  // functions behind it. The link is convenience; the check is the server's.
  { label: 'Permissions', to: '/admin/permissions', capability: 'permissions:write' },
];

export function useAdminSession() {
  return useQuery({
    queryKey: ['admin', 'session'],
    queryFn: () => getAdminSession(),
    staleTime: 60_000,
    retry: false,
  });
}

export function AdminShell({ children }: { children: ReactNode }) {
  const session = useAdminSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (session.isPending) {
    return (
      <div className="site-container py-24" data-testid="admin-loading">
        <p className="eyebrow mb-3">Admin</p>
        <p className="text-muted-foreground">Checking your access…</p>
      </div>
    );
  }

  if (session.isError || !session.data.staff) {
    return (
      <div className="site-container py-24 max-w-xl" data-testid="admin-not-authorised">
        <p className="eyebrow mb-3">Admin</p>
        <h1 className="font-display text-4xl">Not authorised</h1>
        <p className="text-muted-foreground mt-4 leading-relaxed">
          This part of the store is for staff accounts. If you believe you should have access, ask an owner to give
          your account a staff role, then sign in again.
        </p>
        <div className="flex flex-wrap gap-4 mt-8 text-xs">
          <Link to="/account" className="underline">
            Go to your account
          </Link>
          <Link to="/" className="underline">
            Back to the store
          </Link>
        </div>
      </div>
    );
  }

  const role = session.data.role;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-ink text-ink-foreground">
        <div className="site-container flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="flex items-baseline gap-4">
            <span className="font-display text-2xl">ozikoro<span className="text-primary">.</span></span>
            <span className="text-[10px] uppercase tracking-[0.3em] text-ink-muted">Admin</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-ink-muted">
            <span data-testid="admin-session-email">{session.data.email || session.data.name}</span>
            <span className="uppercase tracking-widest" data-testid="admin-session-role">
              {role.replace(/_/g, ' ')}
            </span>
            <Link to="/" className="underline hover:text-ink-foreground">
              View store
            </Link>
          </div>
        </div>
        <nav className="site-container flex flex-wrap gap-5 pb-3 text-[12px] font-medium" data-testid="admin-nav">
          {NAV.filter((item) => can(role, item.capability)).map((item) => {
            const active = item.to === '/admin' ? pathname === '/admin' || pathname === '/admin/' : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                data-testid={`admin-nav-${item.label.toLowerCase()}`}
                className={active ? 'text-primary' : 'text-ink-muted hover:text-ink-foreground'}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="pb-24">{children}</main>
    </div>
  );
}

export function AdminPage({
  eyebrow = 'Admin',
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="site-container pt-10">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-border pb-6">
        <div>
          <p className="eyebrow mb-3">{eyebrow}</p>
          <h1 className="font-display text-4xl md:text-5xl leading-[1.08]" data-testid="admin-page-title">
            {title}
          </h1>
          {description ? <p className="text-muted-foreground max-w-2xl mt-4 leading-relaxed">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
      </div>
      <div className="pt-8">{children}</div>
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
  testId,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`border border-border bg-card p-6 ${className}`} data-testid={testId}>
      {title || actions ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-5">
          <div>
            {title ? <h2 className="font-display text-2xl">{title}</h2> : null}
            {description ? <p className="text-xs text-muted-foreground mt-1">{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId?: string;
}) {
  return (
    <div className="border border-border bg-card p-5" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
      <p className="font-display text-3xl mt-3">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground mt-2">{hint}</p> : null}
    </div>
  );
}

export function ErrorNote({
  children,
  testId = 'admin-error',
  tone = 'error',
}: {
  children: ReactNode;
  testId?: string;
  /** `success` is for a change that worked; the default is for one that did not. */
  tone?: 'error' | 'success';
}) {
  if (!children) return null;
  const classes =
    tone === 'success'
      ? 'border-primary-strong/50 bg-primary/10 text-foreground'
      : 'border-destructive text-destructive';
  return (
    <p className={`text-sm border px-3 py-2 mt-3 ${classes}`} data-testid={testId} role="status">
      {children}
    </p>
  );
}

export function OkNote({ children, testId = 'admin-ok' }: { children: ReactNode; testId?: string }) {
  if (!children) return null;
  return (
    <p className="text-sm border border-border px-3 py-2 mt-3" data-testid={testId}>
      {children}
    </p>
  );
}

export const adminButtonClass =
  'inline-flex h-10 items-center justify-center border border-foreground bg-foreground px-4 text-xs font-semibold uppercase tracking-widest text-background disabled:opacity-50';

export const adminQuietButtonClass =
  'inline-flex h-10 items-center justify-center border border-border px-4 text-xs font-semibold uppercase tracking-widest hover:border-foreground disabled:opacity-50';

export const adminLinkClass = 'text-xs underline underline-offset-4 hover:text-primary';

/** SQLite writes `datetime('now')` as UTC without a zone; make it explicit. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-NG', { dateStyle: 'medium' });
}
