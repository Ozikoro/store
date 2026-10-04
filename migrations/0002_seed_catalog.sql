-- Ozikoro Store — the launch catalogue.
--
-- These are the nine products the store was designed around, plus four
-- collections, three discount codes and the store's own policy pages as
-- content rows.
--
-- Every variant carries a real SKU and a stock count. The design preview showed
-- "preview item · availability to be confirmed" because there was no inventory;
-- this is the inventory, and an owner changes these numbers in the admin.
--
-- Money is in kobo. 18500 naira is 1850000.

PRAGMA foreign_keys = ON;

INSERT INTO collections (id, slug, title, description, image_url, position, is_visible) VALUES
  ('col_apparel',  'apparel',            'Apparel',             'Everyday pieces with a story to tell.',        '/media/apparel.jpg',     1, 1),
  ('col_books',    'books-publications', 'Books & Publications', 'Ideas worth holding on to.',                   '/media/book.jpg',        2, 1),
  ('col_prints',   'prints-posters',     'Prints & Posters',    'Art for spaces that mean something.',           '/media/print.jpg',       3, 1),
  ('col_art',      'art-artefacts',      'Art & Artefacts',     'Ikenga, sculptures and carved works.',          '/media/ikenga.jpg',      4, 1)
ON CONFLICT(id) DO NOTHING;

INSERT INTO products (
  id, slug, title, category, collection_id, description, details, image_url, image_alt,
  price_minor, currency, status, is_featured, position, seo_title, seo_description, made_to_order
) VALUES
  ('prd_heritage_tee', 'ozikoro-heritage-tee', 'Ozikoro Heritage Tee', 'Apparel', 'col_apparel',
   'A considered everyday essential, made to carry culture forward. Cut from substantial cotton with a relaxed, comfortable fit.',
   '["100% heavyweight cotton","Relaxed unisex fit","Machine wash cold; wash inside out","Screen-printed Ozikoro mark"]',
   '/media/apparel.jpg', 'Ozikoro Heritage Tee in natural cotton',
   1850000, 'NGN', 'active', 1, 1,
   'Ozikoro Heritage Tee — heavyweight cotton, unisex',
   'A heavyweight cotton tee carrying the Ozikoro mark. Relaxed unisex fit, sizes S to XL. Ships from Lagos.', 0),

  ('prd_reader', 'the-ozikoro-reader', 'The Ozikoro Reader', 'Books & Publications', 'col_books',
   'A collection of essays and perspectives exploring language, history and cultural knowledge.',
   '["Hardcover · 224 pages","Edited by Ozikoro","First edition · English","Sewn binding, printed in Nigeria"]',
   '/media/book.jpg', 'The Ozikoro Reader hardcover on a plain ground',
   2400000, 'NGN', 'active', 1, 2,
   'The Ozikoro Reader — essays on language and cultural knowledge',
   'A hardcover collection of essays on language, history and cultural knowledge, edited by Ozikoro. First edition.', 0),

  ('prd_land_memory', 'land-and-memory-print', 'Land & Memory Print', 'Prints & Posters', 'col_prints',
   'An archival-inspired study of place and memory, printed on richly textured paper.',
   '["Archival pigment print","Unframed; ships carefully rolled","Printed on 310gsm textured cotton rag"]',
   '/media/print.jpg', 'Land & Memory archival print',
   1600000, 'NGN', 'active', 1, 3,
   'Land & Memory — archival pigment print',
   'An archival pigment print on 310gsm cotton rag, in A2 and A3. Rolled and shipped from Lagos.', 0),

  ('prd_hoodie', 'everyday-hoodie', 'Everyday Hoodie', 'Apparel', 'col_apparel',
   'An easy layer with a quietly expressive detail. Designed for comfort and made to last.',
   '["Heavyweight cotton blend","Relaxed unisex fit","Machine wash cold","Brushed inner fleece"]',
   '/media/hoodie.jpg', 'Everyday Hoodie in charcoal',
   3400000, 'NGN', 'active', 1, 4,
   'Everyday Hoodie — heavyweight cotton blend, unisex',
   'A heavyweight brushed-fleece hoodie with a relaxed unisex fit, sizes S to XL. Ships from Lagos.', 0),

  ('prd_notes', 'notes-on-culture', 'Notes on Culture', 'Books & Publications', 'col_books',
   'A thoughtful collection of writing on the stories and ideas that shape us.',
   '["Softcover · 168 pages","Published by Ozikoro","English","Illustrated throughout"]',
   '/media/journal.jpg', 'Notes on Culture softcover',
   1950000, 'NGN', 'active', 1, 5,
   'Notes on Culture — illustrated softcover',
   'An illustrated softcover collection of writing on the stories and ideas that shape us. Published by Ozikoro.', 0),

  ('prd_belonging', 'forms-of-belonging', 'Forms of Belonging', 'Prints & Posters', 'col_prints',
   'A graphic exploration of identity and belonging, printed with care for the spaces we inhabit.',
   '["Archival pigment print","Unframed","Printed on 310gsm textured cotton rag"]',
   '/media/poster.jpg', 'Forms of Belonging archival print',
   1450000, 'NGN', 'active', 0, 6,
   'Forms of Belonging — archival pigment print',
   'A graphic study of identity and belonging, printed as an archival pigment print in A2 and A3.', 0),

  ('prd_ikenga', 'ikenga-carved-figure', 'Ikenga Carved Figure', 'Art & Artefacts', 'col_art',
   'A hand-carved Ikenga figure with sweeping ram horns, honouring strength, achievement and the personal drive to move forward.',
   '["Hand-carved hardwood","Each piece is unique; carving details vary","Finished with natural oil","Certificate of provenance included"]',
   '/media/ikenga.jpg', 'Hand-carved Ikenga figure with ram horns',
   28500000, 'NGN', 'active', 1, 7,
   'Ikenga Carved Figure — hand-carved hardwood',
   'A hand-carved hardwood Ikenga figure, made to order by a carver in the south-east. Each piece is unique.', 1),

  ('prd_bronze', 'bronze-heritage-head', 'Bronze Heritage Head', 'Art & Artefacts', 'col_art',
   'A cast bronze head inspired by classical West African metalwork traditions, finished with a warm aged patina.',
   '["Lost-wax cast bronze","Approx. 32 cm tall","Hand-finished patina","Certificate of provenance included"]',
   '/media/bronze-head.jpg', 'Cast bronze heritage head with aged patina',
   42000000, 'NGN', 'active', 1, 8,
   'Bronze Heritage Head — lost-wax cast bronze',
   'A lost-wax cast bronze head with an aged patina, inspired by classical West African metalwork. Approx. 32 cm tall.', 1),

  ('prd_mother_child', 'mother-and-child-sculpture', 'Mother & Child Sculpture', 'Art & Artefacts', 'col_art',
   'A tender carved wood sculpture celebrating care, lineage and the bonds that carry families forward.',
   '["Hand-carved hardwood","Approx. 50 cm tall","Polished natural finish","Certificate of provenance included"]',
   '/media/wood-figure.jpg', 'Carved wood mother and child sculpture',
   19500000, 'NGN', 'active', 0, 9,
   'Mother & Child Sculpture — hand-carved hardwood',
   'A hand-carved hardwood mother and child sculpture, approx. 50 cm tall, made to order.', 1)
ON CONFLICT(id) DO NOTHING;

-- Variants. Apparel ships in four sizes; prints in two formats; books in one.
INSERT INTO product_variants (id, product_id, sku, title, price_minor, stock, weight_grams, position, is_active) VALUES
  ('var_tee_s',  'prd_heritage_tee', 'OZK-TEE-S',  'S',  1850000,  6, 250, 1, 1),
  ('var_tee_m',  'prd_heritage_tee', 'OZK-TEE-M',  'M',  1850000, 12, 260, 2, 1),
  ('var_tee_l',  'prd_heritage_tee', 'OZK-TEE-L',  'L',  1850000,  9, 275, 3, 1),
  ('var_tee_xl', 'prd_heritage_tee', 'OZK-TEE-XL', 'XL', 1850000,  4, 290, 4, 1),

  ('var_reader_hc', 'prd_reader', 'OZK-RDR-HC', 'Hardcover', 2400000, 24, 620, 1, 1),

  ('var_land_a2', 'prd_land_memory', 'OZK-LAM-A2', 'A2', 1600000, 8, 180, 1, 1),
  ('var_land_a3', 'prd_land_memory', 'OZK-LAM-A3', 'A3', 1100000, 11, 110, 2, 1),

  ('var_hood_s',  'prd_hoodie', 'OZK-HOD-S',  'S',  3400000, 5, 620, 1, 1),
  ('var_hood_m',  'prd_hoodie', 'OZK-HOD-M',  'M',  3400000, 8, 640, 2, 1),
  ('var_hood_l',  'prd_hoodie', 'OZK-HOD-L',  'L',  3400000, 7, 660, 3, 1),
  ('var_hood_xl', 'prd_hoodie', 'OZK-HOD-XL', 'XL', 3400000, 0, 680, 4, 1),

  ('var_notes_sc', 'prd_notes', 'OZK-NOC-SC', 'Softcover', 1950000, 30, 380, 1, 1),

  ('var_belong_a2', 'prd_belonging', 'OZK-FOB-A2', 'A2', 1450000, 6, 180, 1, 1),
  ('var_belong_a3', 'prd_belonging', 'OZK-FOB-A3', 'A3', 1000000, 2, 110, 2, 1),

  ('var_ikenga_one', 'prd_ikenga', 'OZK-IKG-01', 'One of a kind', 28500000, 1, 4200, 1, 1),

  ('var_bronze_one', 'prd_bronze', 'OZK-BRZ-01', 'One of a kind', 42000000, 1, 6500, 1, 1),

  ('var_mc_one', 'prd_mother_child', 'OZK-MCS-01', 'One of a kind', 19500000, 1, 5200, 1, 1)
ON CONFLICT(id) DO NOTHING;

-- A record of where the opening stock came from, so the ledger reconciles.
INSERT INTO inventory_movements (id, variant_id, delta, reason, note, actor_email)
SELECT 'inv_seed_' || v.id, v.id, v.stock, 'seed', 'opening stock', 'owner@ozikoro.com'
  FROM product_variants v
 WHERE v.stock > 0
   AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.variant_id = v.id);

-- Discount codes: one launch code, one free-shipping code, one dormant example.
INSERT INTO discounts (id, code, kind, value, minimum_subtotal_minor, max_redemptions, ends_at, is_active) VALUES
  ('dsc_launch10', 'LAUNCH10',    'percentage',    10, 0,       500,  '2027-01-31T23:59:59Z', 1),
  ('dsc_freeship', 'FREESHIPNG',  'free_shipping',  0, 5000000,  NULL, NULL,                   1),
  ('dsc_welcome',  'WELCOME5000', 'fixed',      500000, 2500000,  NULL, NULL,                   1)
ON CONFLICT(id) DO NOTHING;
