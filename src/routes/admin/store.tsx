import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { AdminPage, Panel, ErrorNote, adminButtonClass } from '@/store/admin-layout';
import { Button } from '@/components/ui/button';
import { getStorefrontState, setStorefrontState } from '@/server/admin';

/**
 * The shop's visibility switch.
 *
 * WHY THIS IS ITS OWN SCREEN AND NOT A ROW ON THE SEO SETTINGS
 *
 * It is the only control in the admin that decides whether a stranger can spend
 * money. Putting it among the search-engine codes would bury the most consequential
 * switch on the site inside a page about metadata — and the person who needs it in
 * a hurry, with a stock problem at the wrong moment, would be looking for it in
 * the wrong place.
 *
 * IT REPORTS THE CONSEQUENCE, NOT JUST THE STATE. "The storefront is open" is a
 * fact about a database row. What somebody standing here needs to know is who can
 * see what: that closing the shop hides the products but does NOT stop the admin
 * working, does NOT stop a payment taken earlier from settling, and does NOT break
 * signing in to ozikoro.com. Every one of those would be a reasonable fear, and
 * stating them here is cheaper than a support conversation later.
 */
export const Route = createFileRoute('/admin/store')({
  staticData: {
    seo: {
      title: 'Storefront',
      description: 'Open or close the Ozikoro Store to the public.',
      kind: 'private',
      noindex: true,
    },
  },
  /**
   * The loader catches its own failure, like every other admin route: a refusal
   * is a normal outcome of asking, and it must render as a refusal rather than as
   * a 500 — a 500 on this screen reads as "the site is down".
   */
  loader: async () => {
    try {
      return { state: await getStorefrontState(), error: null as string | null };
    } catch (error) {
      return {
        state: null,
        error: error instanceof Error ? error.message : 'The storefront state could not be read.',
      };
    }
  },
  component: StorefrontScreen,
});

function StorefrontScreen() {
  const { state, error } = Route.useLoaderData();
  const [open, setOpen] = useState(state?.open ?? true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (error || !state) {
    return (
      <AdminPage title="Storefront">
        <ErrorNote>{error ?? 'The storefront state could not be read.'}</ErrorNote>
      </AdminPage>
    );
  }

  const changed = open !== state.open;

  async function save() {
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      const result = await setStorefrontState({ data: { open } });
      setNotice(
        result.open
          ? 'The shop is open. Visitors can see the storefront from their next request.'
          : 'The shop is closed. Visitors now see the coming-soon page.'
      );
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : 'That change could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminPage title="Storefront">
      <Panel title="Who can see the shop" testId="storefront-panel">
        <p className="text-sm text-muted-foreground leading-relaxed">
          While the shop is closed, a visitor sees a single coming-soon page. Nothing else about
          the store changes: the admin keeps working, a payment taken before the shop closed can
          still settle, and signing in to the other Ozikoro platforms is unaffected.
        </p>

        <div
          className="mt-6 flex items-center gap-3 rounded-md border border-border p-4"
          data-testid="storefront-state"
          data-open={state.open ? 'true' : 'false'}
        >
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 rounded-full ${state.open ? 'bg-emerald-500' : 'bg-amber-500'}`}
          />
          <span className="font-medium">
            {state.open ? 'Open to the public' : 'Closed — showing the coming-soon page'}
          </span>
        </div>

        <label className="mt-6 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={open}
            onChange={(event) => setOpen(event.target.checked)}
            className="mt-1"
            data-testid="storefront-toggle"
          />
          <span>
            <span className="font-medium">Let the public see the shop</span>
            <span className="mt-1 block text-muted-foreground">
              Clear this to hide the storefront behind the coming-soon page.
            </span>
          </span>
        </label>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button
            type="button"
            onClick={save}
            disabled={busy || !changed}
            data-testid="storefront-save"
            className={adminButtonClass}
          >
            {busy ? 'Saving…' : changed ? 'Save' : 'Saved'}
          </Button>
          <a
            href={state.previewPath}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline text-muted-foreground hover:text-foreground"
            data-testid="storefront-preview"
          >
            See what a visitor sees
          </a>
        </div>

        {notice ? (
          <p className="mt-4 text-sm text-emerald-700" data-testid="storefront-saved">
            {notice}
          </p>
        ) : null}
        {failure ? (
          <p className="mt-4 text-sm text-destructive" data-testid="storefront-failed">
            {failure}
          </p>
        ) : null}
      </Panel>
    </AdminPage>
  );
}
