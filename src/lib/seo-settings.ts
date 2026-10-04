/**
 * SEO settings: read them, write them, and say what each one becomes in the head.
 *
 * WHY THIS IS A MODULE AND NOT A COLUMN LIST
 *
 * The set of search engines is not closed. Yandex and Bing issue verification
 * codes today; Baidu and Naver exist. A schema migration to add a verification
 * code is a schema migration for a string a person pastes into a form, so the
 * settings live in one key/value table and this module is the only thing that
 * knows what the keys mean.
 *
 * READ PATH
 *
 * The head is generated on every server render, so `allSeoSettings()` is on the
 * hot path. It is one indexed read of about twenty rows, which is cheaper than
 * the alternative of a cached copy that can go stale between a save and the next
 * crawl — and a verification code that is stale is a verification that fails.
 */

import { db, tryDb } from './env';
import { randomToken } from './crypto';
import { recordAudit, type AuditActor } from './audit';

export type SettingKind = 'text' | 'meta-name' | 'none';

export interface SettingRow {
  key: string;
  value: string;
  kind: SettingKind;
  label: string;
  help: string;
  updated_at: string;
}

/**
 * The verification codes, as `meta name` -> `content`.
 *
 * The names are fixed by each engine and are NOT taken from the key, because
 * several of them do not follow a pattern (`msvalidate.01`,
 * `p:domain_verify`, `facebook-domain-verification`). A settings screen that
 * derived the tag name from a label would emit a tag that no engine recognises,
 * which fails silently and looks like the engine's fault.
 */
const VERIFICATION_TAGS: Record<string, string> = {
  'verify.google': 'google-site-verification',
  'verify.yandex': 'yandex-verification',
  'verify.bing': 'msvalidate.01',
  'verify.pinterest': 'p:domain_verify',
  'verify.facebook': 'facebook-domain-verification',
  'verify.baidu': 'baidu-site-verification',
};

export interface SeoSettings {
  /** name -> content, for `<meta name content>` in the head. */
  verification: Array<{ name: string; content: string }>;
  titleSuffix: string;
  defaultDescription: string;
  noindexAdmin: boolean;
  robotsExtra: string;
  organisation: {
    legalName: string;
    email: string;
    country: string;
    locality: string;
    founding: string;
  };
  /** Raw values, for the settings screen to render. */
  raw: Record<string, string>;
}

export const FALLBACK_SETTINGS: SeoSettings = {
  verification: [],
  titleSuffix: ' | Ozikoro Store',
  defaultDescription:
    'Thoughtfully made apparel, books, prints and artefacts from Ozikoro. Naira checkout, shipping across Nigeria.',
  noindexAdmin: true,
  robotsExtra: '',
  organisation: {
    legalName: 'Ozi Ikoro Limited',
    email: 'hello@ozikoro.com',
    country: 'NG',
    locality: 'Lagos',
    founding: '',
  },
  raw: {},
};

/**
 * Every verification tag for the head.
 *
 * A code is trimmed and an empty one is dropped, so clearing a field in the
 * admin removes the tag rather than publishing `<meta content="">` — which some
 * engines read as a failed verification and others as a claim.
 */
export function verificationMeta(settings: SeoSettings): Array<{ name: string; content: string }> {
  const tags = [...settings.verification];

  // The engine the schema does not name: a person supplies both halves.
  const otherName = (settings.raw['verify.other_name'] ?? '').trim();
  const otherValue = (settings.raw['verify.other_value'] ?? '').trim();
  if (otherName && otherValue) {
    // The name is validated as a tag name. A value containing a quote or an
    // angle bracket would otherwise break out of the attribute and inject markup
    // into every page's head.
    if (/^[a-zA-Z][a-zA-Z0-9._:-]{2,60}$/.test(otherName)) {
      tags.push({ name: otherName, content: otherValue });
    } else {
      console.error('[seo] refusing a verification tag name that is not a tag name:', otherName);
    }
  }

  return tags.filter((tag) => tag.content.length > 0);
}

export async function allSeoSettings(): Promise<SeoSettings> {
  if (!tryDb()) return FALLBACK_SETTINGS;

  const result = await db().prepare('SELECT key, value, kind, label, help, updated_at FROM settings').all<SettingRow>();
  const rows = result.results ?? [];
  if (!rows.length) return FALLBACK_SETTINGS;

  const raw: Record<string, string> = {};
  for (const row of rows) raw[row.key] = row.value;

  const verification: Array<{ name: string; content: string }> = [];
  for (const [key, name] of Object.entries(VERIFICATION_TAGS)) {
    const value = (raw[key] ?? '').trim();
    if (value) verification.push({ name, content: value });
  }

  return {
    verification,
    titleSuffix: raw['seo.title_suffix'] ?? FALLBACK_SETTINGS.titleSuffix,
    defaultDescription: raw['seo.default_description'] || FALLBACK_SETTINGS.defaultDescription,
    // Only the literal '0' turns it off. A blank value must not silently expose
    // the admin to an index because a form field was cleared.
    noindexAdmin: raw['seo.noindex_admin'] !== '0',
    robotsExtra: raw['seo.robots_extra'] ?? '',
    organisation: {
      legalName: raw['org.legal_name'] || FALLBACK_SETTINGS.organisation.legalName,
      email: raw['org.email'] || FALLBACK_SETTINGS.organisation.email,
      country: raw['org.country'] || FALLBACK_SETTINGS.organisation.country,
      locality: raw['org.locality'] || FALLBACK_SETTINGS.organisation.locality,
      founding: raw['org.founding'] ?? '',
    },
    raw,
  };
}

/** Every setting row, for the admin screen, in a stable order. */
export async function settingsForAdmin(): Promise<SettingRow[]> {
  const result = await db()
    .prepare(
      `SELECT key, value, kind, label, help, updated_at FROM settings
        ORDER BY
          CASE
            WHEN key LIKE 'verify.%' THEN 0
            WHEN key LIKE 'org.%' THEN 1
            ELSE 2
          END, key`
    )
    .all<SettingRow>();
  return result.results ?? [];
}

/**
 * Write settings, one audited batch.
 *
 * An unknown key is refused rather than inserted. Without that check a typo in a
 * form would create a row that nothing reads, and the person would be told their
 * setting was saved.
 */
export async function saveSettings(
  values: Record<string, string>,
  actor: AuditActor | null
): Promise<{ saved: number; rejected: string[] }> {
  const known = await db().prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const existing = new Map((known.results ?? []).map((row) => [row.key, row.value]));

  const rejected: string[] = [];
  let saved = 0;

  for (const [key, value] of Object.entries(values)) {
    if (!existing.has(key)) {
      rejected.push(key);
      continue;
    }
    // Everything is stored as text. The value is trimmed because a pasted
    // verification code routinely arrives with a trailing space, and a trailing
    // space makes it invalid while looking correct.
    const trimmed = value.trim();
    if (existing.get(key) === trimmed) {
      // Nothing changed: do not write, and do not audit. An audit row for a
      // no-op is noise in the one log that is supposed to be worth reading.
      saved += 1;
      continue;
    }
    await db()
      .prepare(`UPDATE settings SET value = ?2, updated_at = datetime('now') WHERE key = ?1`)
      .bind(key, trimmed)
      .run();
    await recordAudit({
      actor,
      action: 'seo.setting_changed',
      entity: 'setting',
      entityId: key,
      before: { value: existing.get(key) ?? '' },
      after: { value: trimmed },
    });
    saved += 1;
  }

  return { saved, rejected };
}

/**
 * Where the site has been submitted, so it is not done twice or forgotten.
 *
 * Not crawled automatically: submitting a sitemap requires the owner's account
 * with each engine, and a store that pretended to do it would be lying about the
 * one step that actually gets a site listed.
 */
export async function recordSubmission(input: { engine: string; url: string; note: string }): Promise<void> {
  await db()
    .prepare('INSERT INTO seo_submissions (id, engine, url, note) VALUES (?1, ?2, ?3, ?4)')
    .bind(`sub_${randomToken(10)}`, input.engine.slice(0, 60), input.url.slice(0, 300), input.note.slice(0, 500))
    .run();
}

export async function submissions(): Promise<
  Array<{ id: string; engine: string; url: string; submitted_at: string; note: string }>
> {
  const result = await db()
    .prepare('SELECT * FROM seo_submissions ORDER BY submitted_at DESC LIMIT 50')
    .all<{ id: string; engine: string; url: string; submitted_at: string; note: string }>();
  return result.results ?? [];
}
