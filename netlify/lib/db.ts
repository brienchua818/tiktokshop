import { neon } from '@neondatabase/serverless'

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
