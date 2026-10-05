import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AdminPage, ErrorNote, Panel, adminButtonClass, adminQuietButtonClass, formatDateTime } from '@/store/admin-layout';
import { getOutbox, retryMessage, flushOutbox } from '@/server/admin';
import type { OutboxRow } from '@/lib/mail';

/**
 * Outbound email, and whether any of it went.
 *
 * The store queues email without a provider configured. That is deliberate — a
 * message that is written down can be sent later, and one that was never written
 * down is gone — but it is also invisible, and a shop that has been silently
 * unable to email its customers looks identical to one that has nothing to say.
 *
 * So the header says which provider is in use BEFORE the list, because that is
 * the fact that changes what the rest of the page means.
 */
export const Route = createFileRoute('/admin/outbox')({
  staticData: {
    seo: {
      title: 'Outbox',
      description: 'Outbound email from the Ozikoro Store.',
      kind: 'private',
      noindex: true,
    },
  },
  /**
   * The loader catches its own failure.
   *
   * `getOutbox` checks `orders:read:all` and throws an AuthorizationError for a
   * signed-out visitor. Letting that escape the loader answers 500 on a page
   * whose job is to show a list — and 500 is what a monitoring check reports as
   * "the site is down". Every other admin route returns 200 with its own gate;
   * this one and `admin/seo` were the two exceptions, which is what a shared
   * pattern would have prevented.
   */
  loader: async () => {
    try {
      return { data: await getOutbox(), error: null as string | null };
    } catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error.message : 'The outbox could not be loaded.',
      };
    }
  },
  component: OutboxScreen,
});

function OutboxScreen() {
  const loaded = Route.useLoaderData();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loaded.data) {
    return (
      <AdminPage title="Outbox" description="Outbound email from the Ozikoro Store.">
        <ErrorNote>{loaded.error ?? 'Not authorised.'}</ErrorNote>
      </AdminPage>
    );
  }
  return <OutboxList data={loaded.data} note={note} setNote={setNote} busy={busy} setBusy={setBusy} />;
}

type OutboxData = NonNullable<ReturnType<typeof Route.useLoaderData>['data']>;

function OutboxList({
  data,
  note,
  setNote,
  busy,
  setBusy,
}: {
  data: OutboxData;
  note: string | null;
  setNote: (value: string | null) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {

  async function run(label: string, work: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setBusy(true);
    setNote(null);
    try {
      const result = await work();
      setNote(result.ok ? (result.message ?? `${label} done.`) : (result.error ?? `${label} failed.`));
    } catch (error) {
      setNote(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  }

  const { counts } = data;

  return (
    <AdminPage
      title="Outbox"
      description="Every message the store owes a customer, and whether it has gone."
    >
      {!data.configured && (
        <ErrorNote>
          No email provider is configured, so nothing is being sent. Messages are being recorded and
          will stay queued until a key is set — nothing is lost. Set <code>RESEND_API_KEY</code> on the
          Worker to begin delivery.
        </ErrorNote>
      )}

      {note && <ErrorNote tone="success">{note}</ErrorNote>}

      <Panel title="Provider">
        <div className="grid gap-3 sm:grid-cols-3 text-sm">
          <div>
            <p className="eyebrow">Provider</p>
            <p className="mt-1 font-mono">{data.provider}</p>
          </div>
          <div>
            <p className="eyebrow">From</p>
            <p className="mt-1 font-mono text-xs break-all">{data.from}</p>
          </div>
          <div>
            <p className="eyebrow">Queue</p>
            <p className="mt-1 font-mono text-xs">
              {counts.pending} pending · {counts.failed} failed · {counts.sent} sent
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-6">
          <button
            type="button"
            className={adminButtonClass}
            disabled={busy}
            data-testid="outbox-flush"
            onClick={() => run('Flush', () => flushOutbox())}
          >
            {busy ? 'Working…' : 'Try sending now'}
          </button>
          <span className="text-xs text-muted-foreground">
            Delivery also runs on its own whenever an order is paid.
          </span>
        </div>
      </Panel>

      <Panel className="mt-6" title="Messages" testId="outbox-table">
        {data.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="outbox-empty">
            Nothing has been queued yet. A confirmation is queued the moment a payment settles.
          </p>
        ) : (
          <ul className="text-sm">
            {data.messages.map((message: OutboxRow) => (
              <li key={message.id} className="border-t border-border py-4" data-testid={`outbox-row-${message.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-mono text-xs">{message.template}</span>
                  <span
                    className={
                      message.status === 'failed'
                        ? 'uppercase text-[11px] tracking-widest text-destructive'
                        : 'uppercase text-[11px] tracking-widest text-muted-foreground'
                    }
                  >
                    {message.status}
                    {message.attempts > 0 ? ` · ${message.attempts} attempt(s)` : ''}
                  </span>
                </div>
                <p className="mt-1">{message.subject}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  to {message.to_email} · {formatDateTime(message.created_at)}
                  {message.sent_at ? ` · sent ${formatDateTime(message.sent_at)}` : ''}
                </p>
                {message.last_error ? (
                  <p className="text-xs text-destructive mt-1 break-all">{message.last_error}</p>
                ) : null}
                {message.status === 'failed' || message.status === 'cancelled' ? (
                  <button
                    type="button"
                    className={`${adminQuietButtonClass} mt-2`}
                    disabled={busy}
                    data-testid={`outbox-retry-${message.id}`}
                    onClick={() => run('Retry', () => retryMessage({ data: { id: message.id } }))}
                  >
                    Queue another attempt
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </AdminPage>
  );
}
