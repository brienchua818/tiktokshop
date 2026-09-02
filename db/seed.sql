-- Seed the three shops.
--
-- shop_id deliberately uses the same prefixes as Sheldon Delivery API's Script
-- Properties — PM, HZ, TM — so credentials, tokens and env vars line up across
-- both projects instead of drifting into two conventions.
--
-- App keys and secrets are NOT here. They are set as environment variables
-- ({PREFIX}_APP_KEY, {PREFIX}_APP_SECRET, {PREFIX}_SERVICE_ID) and the secret
-- is written to app_secret_enc encrypted, never committed to a file.

INSERT INTO shops (shop_id, brand, tiktok_handle, entity, daily_listing_cap)
VALUES
  ('HZ', 'HOUZE',            '@houze.com.sg',    'Sheldon Global Pte Ltd', 1000),
  ('TM', 'Table Matters',    '@tablematterssg',  'Audrey Global Pte Ltd',  1000),
  -- Painting Matters' legal entity is not recorded in the vault yet. Left null
  -- rather than guessed: a blank is honest, a wrong entity is corrosive once
  -- exports become purchase orders.
  ('PM', 'Painting Matters', '@paintingmatters', NULL,                     1000)
ON CONFLICT (shop_id) DO UPDATE SET
  brand         = EXCLUDED.brand,
  tiktok_handle = EXCLUDED.tiktok_handle,
  updated_at    = now();
