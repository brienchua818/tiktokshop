import { neon } from '@neondatabase/serverless'
import { encryptSecret, decryptSecret, needsRefresh } from './crypto'
import { refreshAccessToken } from './tiktok-auth'

/**
 * Database access. Netlify DB (Neon serverless Postgres) over HTTP.
 *
 * Every function here runs server-side only. The browser has no database
 * credentials and no direct access — it calls /api/* and nothing else.
 */

export type Sql = ReturnType<typeof neon>

let cached: Sql | undefined

export function sql(): Sql {
  if (cached) return cached
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Provision Netlify DB and set it as an env var.')
  }
  cached = neon(url)
  return cached
}

/** Reset the cached client. Tests only. */
export function resetDbCache(): void {
  cached = undefined
}

/**
 * Narrow the driver's row type.
 *
 * The Neon HTTP driver returns a union covering array-mode and full-result
 * shapes, so indexing it directly does not typecheck. Every query here uses
 * the default object-row mode, so narrowing once in one place beats a cast at
 * each call site.
 */
async function rows<T>(query: Promise<unknown>): Promise<T[]> {
  return (await query) as T[]
}

export interface ShopRow {
  shop_id: string
  brand: string
  tiktok_handle: string
  entity: string | null
  app_key: string | null
  app_secret_enc: string | null
  shop_cipher: string | null
  access_token_enc: string | null
  refresh_token_enc: string | null
  access_token_expires_at: string | null
  refresh_token_expires_at: string | null
  authorised: boolean
  daily_listing_cap: number
}

/**
 * Shops the UI may show. Deliberately excludes every encrypted column — the
 * browser has no business receiving them even in a shape it cannot read.
 */
export async function listShopsForClient(): Promise<
  Pick<ShopRow, 'shop_id' | 'brand' | 'tiktok_handle' | 'entity' | 'authorised' | 'daily_listing_cap'>[]
> {
  const db = sql()
  return rows(db`
    SELECT shop_id, brand, tiktok_handle, entity, authorised, daily_listing_cap
    FROM shops
    ORDER BY brand
  `)
}

/** Full row including secrets. Server-side callers only. */
export async function getShop(shopId: string): Promise<ShopRow | null> {
  const db = sql()
  const found = await rows<ShopRow>(db`SELECT * FROM shops WHERE shop_id = ${shopId}`)
  return found[0] ?? null
}

/**
 * Allocate the next SKU identifier for a listing.
 *
 * This is a single statement on purpose. Two people adding SKUs during the
 * same livestream must get A1 and A2 — never two A1s — and a read-then-write
 * pair cannot guarantee that under concurrency. `INSERT ... ON CONFLICT DO
 * UPDATE ... RETURNING` makes the read, the increment and the write one atomic
 * operation, so no transaction or lock is needed and it works over Neon's
 * HTTP driver.
 *
 * The counter is also self-healing, matching the behaviour of the app being
 * replaced: on first use for a (listing, prefix) it seeds from the highest
 * identifier already present in drafts, and `floor` lets the caller raise that
 * with the highest identifier already live on TikTok. So a fresh device, or a
 * listing that already has variations, still continues the sequence rather
 * than restarting at 1.
 *
 * @param floor Highest sequence already used on TikTok, if known. The seed is
 *              never lower than this.
 * @returns the allocated sequence number, e.g. 1 for "A1"
 */
export async function allocateIdentifier(
  listingId: string,
  prefix: string,
  floor = 0,
): Promise<number> {
  const db = sql()
  const allocated = await rows<{ seq: number }>(db`
    INSERT INTO identifier_counters (listing_id, prefix, next_seq)
    VALUES (
      ${listingId},
      ${prefix},
      GREATEST(
        COALESCE(
          (
            SELECT MAX(
              CAST(SUBSTRING(identifier FROM '^' || ${prefix} || '([0-9]+)$') AS INTEGER)
            )
            FROM drafts
            WHERE listing_id = ${listingId}
              AND identifier ~ ('^' || ${prefix} || '[0-9]+$')
          ),
          0
        ),
        ${floor}
      ) + 2
    )
    ON CONFLICT (listing_id, prefix)
    DO UPDATE SET next_seq = identifier_counters.next_seq + 1
    RETURNING next_seq - 1 AS seq
  `)
  const seq = allocated[0]?.seq
  if (seq === undefined) {
    throw new Error(`Failed to allocate an identifier for listing ${listingId}`)
  }
  return seq
}

/**
 * How many products this shop has pushed today, in Singapore time.
 *
 * TikTok caps new shops at 100 uploads a day during probation. Surfacing the
 * remaining allowance is the difference between planning around the cap and
 * hitting it at SKU 101 mid-broadcast.
 */
export async function listingsUsedToday(shopId: string): Promise<number> {
  const db = sql()
  const counted = await rows<{ used: number }>(db`
    SELECT COUNT(*)::int AS used
    FROM drafts
    WHERE shop_id = ${shopId}
      AND status = 'pushed'
      AND pushed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Singapore')
                          AT TIME ZONE 'Asia/Singapore'
  `)
  return counted[0]?.used ?? 0
}

/**
 * Store a shop's tokens after authorisation or refresh.
 *
 * Both tokens are written every time. TikTok issues a NEW refresh token on
 * every refresh, and keeping the old one is a bug that only surfaces a week
 * later when the access token lapses and the stale refresh token cannot renew
 * it — by which point the shop has silently stopped working.
 */
export async function saveShopTokens(
  shopId: string,
  tokens: {
    accessToken: string
    refreshToken: string
    accessTokenExpiresAt: Date
    refreshTokenExpiresAt: Date
    shopCipher: string | null
  },
): Promise<void> {
  const db = sql()
  await db`
    UPDATE shops SET
      access_token_enc         = ${encryptSecret(tokens.accessToken)},
      refresh_token_enc        = ${encryptSecret(tokens.refreshToken)},
      access_token_expires_at  = ${tokens.accessTokenExpiresAt.toISOString()},
      refresh_token_expires_at = ${tokens.refreshTokenExpiresAt.toISOString()},
      shop_cipher              = COALESCE(${tokens.shopCipher}, shop_cipher),
      authorised               = TRUE,
      updated_at               = now()
    WHERE shop_id = ${shopId}
  `
}

/**
 * Credentials ready to call TikTok with, refreshing the access token first if
 * it is close to expiry.
 *
 * Refreshing early rather than on failure matters here: discovering an expired
 * token is a mid-livestream problem, and the retry would cost a listing slot.
 */
export async function shopCredentials(shopId: string): Promise<{
  appKey: string
  appSecret: string
  accessToken: string
  shopCipher: string | undefined
  brand: string
}> {
  const shop = await getShop(shopId)
  if (!shop) throw new Error(`Unknown shop: ${shopId}`)
  if (!shop.app_key || !shop.app_secret_enc) {
    throw new Error(`${shop.brand} has no TikTok app credentials configured.`)
  }
  if (!shop.refresh_token_enc || !shop.access_token_enc) {
    throw new Error(`${shop.brand} is not connected to TikTok yet.`)
  }

  const appSecret = decryptSecret(shop.app_secret_enc)
  const expiresAt = shop.access_token_expires_at ? new Date(shop.access_token_expires_at) : null

  let accessToken = decryptSecret(shop.access_token_enc)

  if (needsRefresh(expiresAt)) {
    const refreshExpiry = shop.refresh_token_expires_at
      ? new Date(shop.refresh_token_expires_at)
      : null
    if (refreshExpiry && refreshExpiry.getTime() < Date.now()) {
      // Once the refresh token lapses there is no programmatic way back —
      // the shop owner has to authorise again.
      throw new Error(
        `${shop.brand}'s TikTok authorisation has expired. It needs to be reconnected.`,
      )
    }

    const refreshed = await refreshAccessToken({
      appKey: shop.app_key,
      appSecret,
      refreshToken: decryptSecret(shop.refresh_token_enc),
    })
    await saveShopTokens(shopId, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      accessTokenExpiresAt: new Date(refreshed.access_token_expire_in * 1000),
      refreshTokenExpiresAt: new Date(refreshed.refresh_token_expire_in * 1000),
      shopCipher: null,
    })
    accessToken = refreshed.access_token
  }

  return {
    appKey: shop.app_key,
    appSecret,
    accessToken,
    shopCipher: shop.shop_cipher ?? undefined,
    brand: shop.brand,
  }
}

export interface ListingRow {
  listing_id: string
  shop_id: string
  product_name: string | null
  supplier: string | null
  default_weight_kg: string | null
  created_at: string
}

/** Factory streams for a shop, newest first. */
export function listListings(shopId: string): Promise<ListingRow[]> {
  const db = sql()
  return rows<ListingRow>(db`
    SELECT listing_id, shop_id, product_name, supplier, default_weight_kg, created_at
    FROM listings
    WHERE shop_id = ${shopId} AND archived = FALSE
    ORDER BY created_at DESC
  `)
}

/**
 * Add a factory stream, or return the existing row.
 *
 * Idempotent on purpose: two people adding the same stream during setup should
 * not produce a duplicate-key error they have to interpret.
 */
export async function addListing(shopId: string, listingId: string): Promise<ListingRow> {
  const db = sql()
  const inserted = await rows<ListingRow>(db`
    INSERT INTO listings (listing_id, shop_id)
    VALUES (${listingId}, ${shopId})
    ON CONFLICT (listing_id) DO UPDATE SET archived = FALSE
    RETURNING listing_id, shop_id, product_name, supplier, default_weight_kg, created_at
  `)
  const row = inserted[0]
  if (!row) throw new Error(`Could not add listing ${listingId}`)
  return row
}

/** Record a pushed SKU, so the daily allowance count stays accurate. */
export async function recordPush(draft: {
  draftId: string
  listingId: string
  shopId: string
  identifier: string
  title: string
  variantName: string | null
  price: string
  stock: number
  weightKg: string
  dimensions: { length: string; width: string; height: string } | null
  tiktokImageUri: string
  idempotencyKey: string
  tiktokProductId: string
}): Promise<void> {
  const db = sql()
  await db`
    INSERT INTO drafts (
      draft_id, listing_id, shop_id, identifier, title, variant_name,
      price, stock, weight_kg, length_cm, width_cm, height_cm,
      tiktok_image_uri, status, idempotency_key, tiktok_product_id, pushed_at
    ) VALUES (
      ${draft.draftId}, ${draft.listingId}, ${draft.shopId}, ${draft.identifier},
      ${draft.title}, ${draft.variantName}, ${draft.price}, ${draft.stock},
      ${draft.weightKg}, ${draft.dimensions?.length ?? null},
      ${draft.dimensions?.width ?? null}, ${draft.dimensions?.height ?? null},
      ${draft.tiktokImageUri}, 'pushed', ${draft.idempotencyKey},
      ${draft.tiktokProductId}, now()
    )
    ON CONFLICT (draft_id) DO UPDATE SET
      status            = 'pushed',
      tiktok_product_id = EXCLUDED.tiktok_product_id,
      pushed_at         = now()
  `
}

/**
 * A previous push with this idempotency key, if any.
 *
 * The client retries a timed-out push with the same key. Checking here means a
 * retry returns the original product instead of creating a second one — the
 * exact failure bad factory Wi-Fi produces.
 */
export async function findPushByIdempotencyKey(key: string): Promise<{ tiktok_product_id: string | null } | null> {
  const db = sql()
  const found = await rows<{ tiktok_product_id: string | null }>(db`
    SELECT tiktok_product_id FROM drafts
    WHERE idempotency_key = ${key} AND status = 'pushed'
    LIMIT 1
  `)
  return found[0] ?? null
}

/**
 * Record a sign-in or a refused attempt.
 *
 * The app being replaced had no notion of a user, so no action could be
 * attributed to anyone. This is the minimum needed to answer "who listed
 * this?" later.
 */
export async function logSignIn(email: string, event: string): Promise<void> {
  const db = sql()
  await db`INSERT INTO sessions_log (email, event) VALUES (${email}, ${event})`
}
