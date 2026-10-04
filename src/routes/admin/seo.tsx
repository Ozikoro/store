import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AdminPage, Panel, ErrorNote } from '@/store/admin-layout';
import { Button } from '@/components/ui/button';
import { getSeoAdmin, saveSeoSettings, recordSeoSubmission } from '@/server/seo';
import type { SeoAdminData } from '@/server/seo';

/**
 * SEO, in the admin.
 *
 * WHY THIS SCREEN EXISTS
 *
 * A search-engine verification code arrives by email, after a deploy, and
 * changes when a property is re-created. Putting one in the repository would mean
 * a code change and a deploy to paste six characters — which in practice means it
 * never gets set, and the site never gets verified, and nobody can see what a
 * crawler sees. So the codes live in the database and this is where they are
 * pasted.
 *
 * WHAT IS ON IT, and why each part is here rather than somewhere else:
 *
 *   verification codes   the thing only the owner can obtain
 *   publisher details    because the structured data has to follow a changed
 *                        address or email without a deploy
 *   the crawler files    a link to the sitemap and robots.txt, so the owner can
 *                        check them himself rather than taking this screen's word
 *   where to submit      the one step that actually gets a site listed, which
 *                        cannot be automated because it needs the owner's account
 *                        with each engine
 */
export const Route = createFileRoute('/admin/seo')({
  staticData: {
    seo: {
      title: 'SEO',
      description: 'Search-engine settings for the Ozikoro Store.',
      kind: 'private',
      noindex: true,
    },
  },
  /**
   * The loader catches its own failure.
   *
   * `getSeoAdmin` checks `content:write` and throws an AuthorizationError for a
   * signed-out visitor. Letting that escape the loader produced a 500 on a page
   * whose whole job is to show a form — every other admin route returns 200 with
   * its own gate, and this one was the outlier. A refusal is a normal outcome of
   * asking, not a server fault.
   */
  loader: async () => {
    try {
      return { data: await getSeoAdmin(), error: null as string | null };
    } catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error.message : 'The SEO settings could not be loaded.',
      };
    }
  },
  component: SeoScreen,
});

function groupOf(key: string): 'verify' | 'org' | 'seo' {
  if (key.startsWith('verify.')) return 'verify';
  if (key.startsWith('org.')) return 'org';
  return 'seo';
}

function SeoScreen() {
  const loaded = Route.useLoaderData();
  if (!loaded.data) {
    return (
      <AdminPage title="SEO" description="Search-engine settings for the Ozikoro Store.">
        <ErrorNote>{loaded.error ?? 'Not authorised.'}</ErrorNote>
      </AdminPage>
    );
  }
  return <SeoForm data={loaded.data} />;
}

function SeoForm({ data }: { data: SeoAdminData }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.settings.map((row) => [row.key, row.value]))
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const set = (key: string, value: string) => setValues((old) => ({ ...old, [key]: value }));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveSeoSettings({ data: { values } });
      setMessage(
        result.ok
          ? { tone: 'success' as const, text: 'Saved. The change is live on the next request — no deploy needed.' }
          : { tone: 'error' as const, text: result.error }
      );
    } catch (error) {
      setMessage({ tone: 'error' as const, text: error instanceof Error ? error.message : 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  async function noteSubmission(engine: string, url: string) {
    await recordSeoSubmission({ data: { engine, url, note: '' } });
    setMessage({ tone: 'success' as const, text: `Recorded that ${engine} was submitted.` });
  }

  const verification = data.settings.filter((row) => groupOf(row.key) === 'verify');
  const organisation = data.settings.filter((row) => groupOf(row.key) === 'org');
  const behaviour = data.settings.filter((row) => groupOf(row.key) === 'seo');

  return (
    <AdminPage
      title="SEO"
      description="Verification codes, publisher details and the crawler files."
    >
      {message && <ErrorNote tone={message.tone === "success" ? "success" : "error"}>{message.text}</ErrorNote>}

      <Panel title="Search-engine verification">
        <p className="text-sm text-muted-foreground mb-6">
          Each search engine gives you an <code className="text-foreground">&lt;meta&gt;</code> tag to paste
          into your site. <strong className="text-foreground">Paste only the content value</strong>, not the
          whole tag — the field already knows the tag's name. A trailing space will invalidate it, so values
          are trimmed on save.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          {verification.map((row) => (
            <label key={row.key} className="text-sm grid gap-2">
              {row.label}
              <input
                className="field font-mono text-xs"
                value={values[row.key] ?? ''}
                placeholder={row.key.startsWith('verify.other') ? undefined : 'paste the content value'}
                onChange={(event) => set(row.key, event.target.value)}
                data-testid={`seo-${row.key.replace(/\./g, '-')}`}
              />
              <span className="text-xs text-muted-foreground leading-relaxed">{row.help}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-6">
          The tag is emitted on every page, because a search engine fetches whichever URL it was given and it
          is not always the home page. Clearing a field removes the tag rather than publishing an empty one.
        </p>
      </Panel>

      <Panel title="The publisher">
        <p className="text-sm text-muted-foreground mb-6">
          These appear in the Organization structured data that every page carries. Nothing here is invented:
          a blank field is omitted rather than guessed.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          {organisation.map((row) => (
            <label key={row.key} className="text-sm grid gap-2">
              {row.label}
              <input
                className="field"
                value={values[row.key] ?? ''}
                onChange={(event) => set(row.key, event.target.value)}
                data-testid={`seo-${row.key.replace(/\./g, '-')}`}
              />
              <span className="text-xs text-muted-foreground leading-relaxed">{row.help}</span>
            </label>
          ))}
        </div>
      </Panel>

      <Panel title="Titles and indexing">
        <div className="grid gap-5">
          {behaviour.map((row) => (
            <label key={row.key} className="text-sm grid gap-2">
              {row.label}
              {row.key === 'seo.robots_extra' ? (
                <textarea
                  rows={4}
                  className="field h-auto py-3 font-mono text-xs"
                  value={values[row.key] ?? ''}
                  onChange={(event) => set(row.key, event.target.value)}
                  data-testid={`seo-${row.key.replace(/\./g, '-')}`}
                />
              ) : row.key === 'seo.noindex_admin' ? (
                <select
                  className="field"
                  value={values[row.key] === '0' ? '0' : '1'}
                  onChange={(event) => set(row.key, event.target.value)}
                  data-testid="seo-noindex-admin"
                >
                  <option value="1">On — keep the admin out of search results</option>
                  <option value="0">Off — allow the admin to be indexed (not recommended)</option>
                </select>
              ) : (
                <input
                  className="field"
                  value={values[row.key] ?? ''}
                  onChange={(event) => set(row.key, event.target.value)}
                  data-testid={`seo-${row.key.replace(/\./g, '-')}`}
                />
              )}
              <span className="text-xs text-muted-foreground leading-relaxed">{row.help}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-8">
          <Button onClick={save} disabled={busy} data-testid="seo-save">
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Saved settings apply immediately; nothing is rebuilt.
          </span>
        </div>
      </Panel>

      <Panel title="What a crawler reads">
        <div className="grid gap-4 sm:grid-cols-2">
          <a
            href={data.sitemapUrl}
            target="_blank"
            rel="noreferrer"
            className="border border-border p-5 hover:border-foreground"
            data-testid="seo-sitemap-link"
          >
            <p className="font-medium">Sitemap</p>
            <p className="text-xs text-muted-foreground mt-1 font-mono">{data.sitemapUrl}</p>
            <p className="text-xs text-muted-foreground mt-2">
              Generated from the live catalogue, so a product added here appears without a deploy. Private
              pages are excluded.
            </p>
          </a>
          <a
            href={data.robotsUrl}
            target="_blank"
            rel="noreferrer"
            className="border border-border p-5 hover:border-foreground"
            data-testid="seo-robots-link"
          >
            <p className="font-medium">robots.txt</p>
            <p className="text-xs text-muted-foreground mt-1 font-mono">{data.robotsUrl}</p>
            <p className="text-xs text-muted-foreground mt-2">
              Keeps crawlers out of the admin, the cart, the checkout, the account pages and the payment
              callback.
            </p>
          </a>
        </div>
      </Panel>

      <Panel title="Where to submit it">
        <p className="text-sm text-muted-foreground mb-6">
          Submitting the sitemap is the step that actually gets a site listed, and it needs your account with
          each engine — so it cannot be automated here, and this screen does not pretend otherwise.
        </p>
        <div className="grid gap-4">
          {data.places.map((place) => (
            <div key={place.engine} className="border border-border p-5 flex flex-wrap justify-between gap-4">
              <div className="max-w-xl">
                <p className="font-medium">{place.engine}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{place.note}</p>
              </div>
              <div className="flex items-center gap-3">
                <Button asChild variant="outline" size="sm">
                  <a href={place.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => noteSubmission(place.engine, data.sitemapUrl)}
                  data-testid={`seo-mark-${(place.engine.split(' ')[0] ?? place.engine).toLowerCase()}`}
                >
                  Mark done
                </Button>
              </div>
            </div>
          ))}
        </div>
        {data.submissions.length > 0 && (
          <div className="mt-6 border-t border-border pt-5">
            <p className="eyebrow mb-3">Recorded submissions</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              {data.submissions.map((submission) => (
                <li key={submission.id}>
                  {submission.engine} · {submission.submitted_at}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </AdminPage>
  );
}
