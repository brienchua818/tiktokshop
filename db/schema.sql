-- TikShop schema. Postgres (Netlify DB / Neon).
--
-- Two things drive the shape here:
--
-- 1. Shops are rows, not constants. The app it replaces was hardcoded to one
--    shop; this one serves three and takes a fourth without a code change.
--    Credentials live per shop because TikTok binds a Seller Developer app to
--    a single shop, so each brand has its own app key pair.
--
-- 2. The SKU identifier counter must be transactional. Two people adding SKUs
--    seconds apart during a livestream must get A1 and A2, never two A1s.

BEGIN;

CREATE TABLE IF NOT EXISTS shops (
  shop_id                   TEXT PRIMARY KEY,
  -- Brand label the team actually uses. The UI shows this, not the shop id.
  brand                     TEXT        NOT NULL UNIQUE,
  tiktok_handle             TEXT        NOT NULL,
  -- Legal entity the shop trades under. Nullable: Painting Matters' entity is
  -- not yet recorded in the vault, and a blank is honest where a guess is not.
  entity                    TEXT,

  -- Per-shop TikTok app credentials. The secret and both tokens are stored
  -- encrypted (AES-256-GCM) and are only ever decrypted inside a function.
  app_key                   TEXT,
  app_secret_enc            TEXT,
  -- TikTok's opaque per-shop identifier. Fetched, never hardcoded.
  shop_cipher               TEXT,
  access_token_enc          TEXT,
  refresh_token_enc         TEXT,
  -- Absolute instants. TikTok returns epoch seconds, which is easy to
  -- misread as a duration; converting on write means the column cannot lie.
  access_token_expires_at   TIMESTAMPTZ,
  refresh_token_expires_at  TIMESTAMPTZ,

  -- Set once the shop has completed the authorise flow.
  authorised                BOOLEAN     NOT NULL DEFAULT FALSE,
  -- New shops are capped at 100 product uploads a day during probation,
  -- rising to 1000. Tracked so the cap never surprises anyone mid-livestream.
  daily_listing_cap         INTEGER     NOT NULL DEFAULT 100,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A factory livestream. One row per stream, keyed by TikTok's listing id.
CREATE TABLE IF NOT EXISTS listings (
  listing_id    TEXT PRIMARY KEY,
  shop_id       TEXT        NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
  product_name  TEXT,
  -- Which factory this was filmed at. The vault notes nobody records this
  -- today; capturing it here answers an open question in Sourcing Model.md.
  supplier      TEXT,
  -- Defaults applied to every SKU in this stream, so nobody types a weight
  -- 200 times. Weight is mandatory to TikTok, in kilograms.
  default_weight_kg  NUMERIC(10,3),
  archived      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listings_shop_idx ON listings (shop_id, archived, created_at DESC);

-- The SKU identifier counter, one row per (listing, prefix).
-- Incremented with UPDATE ... RETURNING inside a transaction, which is what
-- makes a collision impossible under concurrency.
CREATE TABLE IF NOT EXISTS identifier_counters (
  listing_id  TEXT    NOT NULL REFERENCES listings(listing_id) ON DELETE CASCADE,
  prefix      TEXT    NOT NULL,
  next_seq    INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  PRIMARY KEY (listing_id, prefix)
);

-- CREATE TYPE has no IF NOT EXISTS, so guard it to keep this file re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'draft_status') THEN
    CREATE TYPE draft_status AS ENUM ('queued', 'uploading', 'pushed', 'failed');
  END IF;
END
$$;

-- A SKU being built. Created locally on the device first, so a dropped
-- connection cannot lose it, then reconciled here.
CREATE TABLE IF NOT EXISTS drafts (
  draft_id            UUID PRIMARY KEY,
  listing_id          TEXT         NOT NULL REFERENCES listings(listing_id) ON DELETE CASCADE,
  shop_id             TEXT         NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,

  -- Sequential identifier, e.g. "A1". Becomes TikTok's seller_sku, which
  -- forbids spaces and caps at 50 characters.
  identifier          TEXT         NOT NULL,
  -- TikTok requires 25-255 characters for Singapore, English only.
  title               TEXT         NOT NULL,
  variant_name        TEXT,
  price               NUMERIC(12,2) NOT NULL CHECK (price > 0),
  stock               INTEGER      NOT NULL CHECK (stock BETWEEN 1 AND 99999),
  weight_kg           NUMERIC(10,3) NOT NULL CHECK (weight_kg > 0),
  -- Centimetres, the only unit TikTok accepts for Singapore.
  length_cm           NUMERIC(10,2),
  width_cm            NUMERIC(10,2),
  height_cm           NUMERIC(10,2),
  include_dims_in_title BOOLEAN    NOT NULL DEFAULT FALSE,

  -- Our own archive copy, for thumbnails and for the small derivative the
  -- vision model reads.
  cloudinary_url      TEXT,
  -- TikTok's image reference. Product payloads can only cite this.
  tiktok_image_uri    TEXT,
  -- Resolved from title plus photo via categories/recommend.
  category_id         TEXT,

  status              draft_status NOT NULL DEFAULT 'queued',
  -- TikTok's actual rejection text. Shown verbatim: a generic error is what
  -- makes the current app frustrating to use.
  error               TEXT,
  -- Makes a timed-out create safe to retry without duplicating the product.
  idempotency_key     UUID         NOT NULL,
  tiktok_product_id   TEXT,

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  pushed_at           TIMESTAMPTZ,

  -- One identifier per listing. Catches a bad reconcile as a constraint
  -- violation rather than as two products sharing a SKU on TikTok.
  UNIQUE (listing_id, identifier)
);

CREATE INDEX IF NOT EXISTS drafts_queue_idx ON drafts (listing_id, status, created_at);
CREATE INDEX IF NOT EXISTS drafts_shop_pushed_idx ON drafts (shop_id, pushed_at);

-- Who signed in and when. The app being replaced has no notion of a user at
-- all, so no action could be attributed to anyone.
CREATE TABLE IF NOT EXISTS sessions_log (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT        NOT NULL,
  event       TEXT        NOT NULL,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_log_email_idx ON sessions_log (email, created_at DESC);

COMMIT;
