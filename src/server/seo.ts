/**
 * SEO settings, as server functions.
 *
 * `getSeoSettings` is called by the root loader on every request, so the head can
 * emit the verification codes without a second read. It is deliberately NOT a
 * server function the browser calls: the root loader result travels with the
 * server-rendered page, so there is one read per request rather than one per
 * navigation.
 */

import { createServerFn } from '@tanstack/react-start';
import { currentActor } from './actor';
import { readString } from './typed';
import {
  allSeoSettings,
  saveSettings,
  settingsForAdmin,
  FALLBACK_SETTINGS,
  recordSubmission,
  submissions,
  type SeoSettings,
  type SettingRow,
} from '../lib/seo-settings';
import { requireCapability } from '../lib/auth';

export const getSeoSettings = createServerFn({ method: 'GET' }).handler(async (): Promise<SeoSettings> => {
  try {
    return await allSeoSettings();
  } catch (error) {
    // A head that cannot read its settings is still a head. The fallbacks carry
    // the title suffix, the description and the organisation, so a database blip
    // costs the verification codes and nothing else.
    console.error('[seo] could not read the settings', error);
    return FALLBACK_SETTINGS;
  }
});

/** The admin screen's data: every setting row, plus where the site is submitted. */
export interface SeoAdminData {
  settings: SettingRow[];
  submissions: Awaited<ReturnType<typeof submissions>>;
  sitemapUrl: string;
  robotsUrl: string;
  /** A ready-to-check list, so the owner is not guessing at URLs. */
  places: Array<{ engine: string; url: string; note: string }>;
}

export const getSeoAdmin = createServerFn({ method: 'GET' }).handler(async (): Promise<SeoAdminData> => {
  const actor = await currentActor();
  requireCapability(actor, 'content:write');

  const [settings, submitted] = await Promise.all([settingsForAdmin(), submissions()]);
  return {
    settings,
    submissions: submitted,
    sitemapUrl: '/sitemap.xml',
    robotsUrl: '/robots.txt',
    places: [
      {
        engine: 'Google Search Console',
        url: 'https://search.google.com/search-console',
        note: 'Add a property, choose the HTML tag method, paste the value into the Google field above, then verify and submit /sitemap.xml.',
      },
      {
        engine: 'Yandex Webmaster',
        url: 'https://webmaster.yandex.ru/',
        note: 'Add the site, choose the meta tag method, paste the value into the Yandex field above.',
      },
      {
        engine: 'Bing Webmaster Tools',
        url: 'https://www.bing.com/webmasters',
        note: 'Bing can import directly from Search Console, which is faster than verifying twice.',
      },
      {
        engine: 'Google Merchant Center',
        url: 'https://merchants.google.com/',
        note: 'For product listings. A product feed is not generated yet; this is where it would be submitted.',
      },
    ],
  };
});

export const saveSeoSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    const values = (data['values'] ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string') out[key] = value;
    }
    return { values: out };
  })
  .handler(async ({ data }) => {
    const actor = await currentActor();
    requireCapability(actor, 'content:write');

    const result = await saveSettings(data['values'] ?? {}, {
      id: actor?.customerId ?? actor?.sessionId ?? '',
      email: actor?.email ?? '',
    });

    if (result.rejected.length) {
      // An unknown key is refused rather than created: without that, a typo
      // would be reported as saved and read by nothing.
      return { ok: false as const, error: `Unknown setting(s): ${result.rejected.join(', ')}` };
    }
    return { ok: true as const, saved: result.saved };
  });

export const recordSeoSubmission = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      engine: readString(data, 'engine').slice(0, 60),
      url: readString(data, 'url').slice(0, 300),
      note: readString(data, 'note').slice(0, 500),
    };
  })
  .handler(async ({ data }) => {
    const actor = await currentActor();
    requireCapability(actor, 'content:write');
    if (!data.engine) return { ok: false as const, error: 'Name the search engine.' };
    await recordSubmission(data);
    return { ok: true as const };
  });
