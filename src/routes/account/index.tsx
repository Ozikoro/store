import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Package, LogOut } from 'lucide-react';
import { StoreLayout, PageIntro, Notice } from '@/store/layout';
import { storeHead } from '@/store/head';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/money';
import { ORDER_STATUS_LABELS, type OrderStatus } from '@/lib/order-state';
import { getAccount, signIn, signUp, signOut } from '@/server/store';

export const Route = createFileRoute('/account/')({
  loader: () => getAccount(),
  head: () =>
    storeHead({
      title: 'Account',
      description: 'Your Ozikoro Store account: order history, delivery details and password.',
      path: '/account',
    }),
  component: Account,
});

function Account() {
  const account = Route.useLoaderData();
  return (
    <StoreLayout>
      {account.signedIn ? <SignedIn account={account} /> : <SignedOut />}
    </StoreLayout>
  );
}

type AccountData = Awaited<ReturnType<typeof getAccount>>;

function SignedOut() {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const payload = {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      };
      const result =
        mode === 'signin'
          ? await signIn({ data: payload })
          : await signUp({
              data: {
                ...payload,
                name: String(form.get('name') ?? ''),
                phone: String(form.get('phone') ?? ''),
                marketingOptIn: false,
              },
            });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(true);
      // A full reload, so the server re-renders the header and the order list
      // with the new session rather than a stale client cache.
      window.location.assign('/account');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageIntro
        eyebrow="Your account"
        title={mode === 'signin' ? 'Welcome back' : 'Create an account'}
        description="Sign in to see your orders, track deliveries and keep your delivery details."
      />
      <div className="site-container border-t border-border pt-10 max-w-md">
        <div className="flex gap-2 mb-8">
          <Button
            variant={mode === 'signin' ? 'filterActive' : 'filter'}
            onClick={() => setMode('signin')}
            data-testid="tab-signin"
          >
            Sign in
          </Button>
          <Button
            variant={mode === 'register' ? 'filterActive' : 'filter'}
            onClick={() => setMode('register')}
            data-testid="tab-register"
          >
            Register
          </Button>
        </div>

        <form className="grid gap-5" onSubmit={onSubmit} data-testid="account-form">
          {mode === 'register' && (
            <label className="text-sm grid gap-2">
              Name
              <input name="name" className="field" data-testid="account-name" />
            </label>
          )}
          <label className="text-sm grid gap-2">
            Email
            <input required type="email" name="email" className="field" data-testid="account-email" />
          </label>
          <label className="text-sm grid gap-2">
            Password
            <input
              required
              type="password"
              name="password"
              minLength={8}
              className="field"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              data-testid="account-password"
            />
          </label>
          {error && <Notice>{error}</Notice>}
          {done && <Notice tone="success">Signed in. Redirecting…</Notice>}
          <Button type="submit" disabled={busy} data-testid="account-submit">
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="text-xs text-muted-foreground mt-6">
          You can also check out as a guest — an account is not required to buy. Registering afterwards claims the
          orders you placed with the same email address.
        </p>
      </div>
    </>
  );
}

function SignedIn({ account }: { account: Extract<AccountData, { signedIn: true }> }) {
  const [busy, setBusy] = useState(false);

  async function onSignOut() {
    setBusy(true);
    await signOut();
    window.location.assign('/');
  }

  return (
    <>
      <PageIntro
        eyebrow="Your account"
        title={`Hello${account.name ? `, ${account.name.split(' ')[0]}` : ''}.`}
        description={account.email}
      />

      <div className="site-container border-t border-border pt-10">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
          <h2 className="font-display text-3xl flex items-center gap-3">
            <Package size={22} className="text-primary-strong" aria-hidden /> Your orders
          </h2>
          <div className="flex gap-3">
            {account.isStaff && (
              <Button asChild variant="outline">
                <Link to="/admin">Admin</Link>
              </Button>
            )}
            <Button variant="outline" onClick={onSignOut} disabled={busy} data-testid="sign-out">
              <LogOut size={15} /> Sign out
            </Button>
          </div>
        </div>

        {account.orders.length === 0 ? (
          <div className="border border-border p-10 text-center" data-testid="no-orders">
            <p className="font-display text-2xl">No orders yet.</p>
            <p className="text-muted-foreground mt-2">
              When you place an order it will appear here with its status and tracking.
            </p>
            <Button asChild className="mt-6">
              <Link to="/shop">Browse the store</Link>
            </Button>
          </div>
        ) : (
          <div className="border-t border-border">
            {account.orders.map((order) => (
              <div
                key={order.number}
                className="border-b border-border py-6 flex flex-wrap justify-between gap-4 items-center"
                data-testid={`order-${order.number}`}
              >
                <div>
                  <p className="font-display text-2xl">{order.number}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {new Date(order.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString('en-NG', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-5">
                  <span
                    className={`text-xs uppercase tracking-widest font-semibold ${
                      order.status === 'delivered' ? 'text-muted-foreground' : 'text-primary-strong'
                    }`}
                  >
                    {ORDER_STATUS_LABELS[order.status as OrderStatus] ?? order.status}
                  </span>
                  <span className="font-medium">{formatMoney(order.totalMinor, order.currency)}</span>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/account/orders/$number" params={{ number: order.number }}>
                      View
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-8">
          Need to change something on an order?{' '}
          <Link to="/contact" className="underline">
            Contact us
          </Link>{' '}
          with the order number.
        </p>
      </div>
    </>
  );
}
