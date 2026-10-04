-- SEO settings, editable from the admin.
--
-- WHY A TABLE AND NOT A BUILD-TIME CONSTANT
--
-- Search-engine verification codes are issued by Google, Yandex, Bing and others
-- and are the ONLY thing that lets their crawlers talk to a site's owner about
-- it. They arrive by email, after a deploy, and they change when a property is
-- re-created. Putting them in the repository would mean a code change and a
-- deploy to paste six characters, which in practice means they never get set.
--
-- The same argument applies to the publisher's details: a phone number or an
-- address changes without the code changing, and the structured data has to
-- follow it.
--
-- ONE ROW, KEY/VALUE, RATHER THAN A COLUMN PER SETTING. The set of search
-- engines is not closed — Yandex and Bing today, Baidu or Naver tomorrow — and a
-- schema migration to add a verification code is a schema migration for a string
-- a person pastes into a form.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  -- Which <head> element this value becomes, so the head builder does not need
  -- a lookup table of its own and an unknown key cannot silently become a meta
  -- tag nobody meant to publish.
  --
  --   none       stored but not emitted (a note, a switch)
  --   meta-name  <meta name="<the key minus its prefix>" content="…">
  --   text       emitted by hand; robots.txt, or a JSON-LD field
  kind        TEXT NOT NULL DEFAULT 'text',
  -- Human label and help, so the admin screen is generated from the schema
  -- rather than hand-maintained beside it. A new setting appears in the form by
  -- being inserted here.
  label       TEXT NOT NULL DEFAULT '',
  help        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The settings the store's head and robots.txt understand.
INSERT INTO settings (key, value, kind, label, help) VALUES
  ('verify.google',    '', 'meta-name', 'Google Search Console',
   'Paste the content value from the HTML tag Google gives you. It looks like a short string, not a whole tag.'),
  ('verify.yandex',    '', 'meta-name', 'Yandex Webmaster',
   'Yandex gives a <meta name="yandex-verification"> tag. Paste only the content value.'),
  ('verify.bing',      '', 'meta-name', 'Bing Webmaster Tools',
   'Bing gives a <meta name="msvalidate.01"> tag. Paste only the content value.'),
  ('verify.pinterest', '', 'meta-name', 'Pinterest',
   'Pinterest gives a <meta name="p:domain_verify"> tag. Paste only the content value.'),
  ('verify.facebook',  '', 'meta-name', 'Facebook / Meta',
   'The content value of the facebook-domain-verification tag.'),
  ('verify.baidu',     '', 'meta-name', 'Baidu',
   'The content value of the baidu-site-verification tag.'),
  ('verify.other_name',  '', 'text', 'Another verification: the name',
   'For an engine not listed above. Enter the tag''s name, for example "naver-site-verification".'),
  ('verify.other_value', '', 'text', 'Another verification: the value',
   'The content value that goes with the name above.'),

  ('org.legal_name', 'Ozi Ikoro Limited', 'text', 'Publisher legal name',
   'Used in the Organization structured data and in the sitemap.'),
  ('org.email',      'hello@ozikoro.com', 'text', 'Contact email',
   'Published in the structured data so a search engine can reach a person.'),
  ('org.country',    'NG', 'text', 'Country code',
   'Two letters, used for the store''s address in structured data.'),
  ('org.locality',   'Lagos', 'text', 'City',
   'The city the store operates from.'),
  ('org.founding',   '', 'text', 'Founded',
   'Optional. A year, for example 2026. Left blank, nothing is claimed.'),

  ('seo.title_suffix',    ' | Ozikoro Store', 'text', 'Title suffix',
   'Appended to a page title when it does not already name the store.'),
  ('seo.default_description', 'Thoughtfully made apparel, books, prints and artefacts from Ozikoro. Naira checkout, shipping across Nigeria.',
   'text', 'Default description',
   'Used when a page has none of its own.'),
  ('seo.noindex_admin', '1', 'text', 'Keep admin out of search results',
   'Leave on. A private workspace has no business in an index.'),
  ('seo.robots_extra', '', 'text', 'Extra robots.txt rules',
   'Appended verbatim. For a rule this screen does not cover.')
ON CONFLICT(key) DO NOTHING;

-- Search engines a person wants to be listed with, for the sitemap's
-- announcement list in the admin. Not crawled automatically; this is a record of
-- where the site has been submitted, so it is not done twice or forgotten.
CREATE TABLE IF NOT EXISTS seo_submissions (
  id          TEXT PRIMARY KEY,
  engine      TEXT NOT NULL,
  url         TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  note        TEXT NOT NULL DEFAULT ''
);
