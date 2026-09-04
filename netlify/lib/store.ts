import { getStore } from '@netlify/blobs'
import { encryptSecret, decryptSecret } from './crypto'

/**
 * Durable server-side storage, without needing a database provisioned.
 *
 * Only two things genuinely need to live on the server: TikTok tokens, and the
 * list of factory streams. Everything else has a better source of truth:
 *
 *   - SKU identifiers come from TikTok's own product list plus the device's
 *     local queue, which is what makes the counter self-healing anyway;
 *   - duplicate pushes are prevented by TikTok's `idempotency_key`, which it
 *     honours server-side;
 *   - the daily allowance is derived from products created today.
 *
 * So Netlify Blobs is enough. Its 60-second eventual consistency was the
 * reason to reject it for the identifier counter, but tokens change weekly and
 * streams a few times a day — neither cares. Postgres remains supported and is
 * used automatically when DATABASE_URL is set; this is the path that works
 * with nothing to provision.
 */

const TOKENS = 'tikshop-tokens'
const LISTINGS = 'tikshop-listings'

/** True when a Postgres URL is configured, in which case db.ts is used instead. */
export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  /** ISO instants. TikTok gives epoch seconds; converted at the boundary. */
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string
  shopCipher: string | null
  updatedAt: string
}

/**
 * Tokens are encrypted before they are written, exactly as in the database
 * path. Blob storage is private to the site, but a second layer costs nothing
 * and means an accidental exposure is not immediately a working credential.
 */
export async function saveTokens(shopId: string, tokens: Omit<StoredTokens, 'updatedAt'>): Promise<void> {
  const store = getStore(TOKENS)
  await store.set(
    shopId,
    encryptSecret(JSON.stringify({ ...tokens, updatedAt: new Date().toISOString() })),
  )
}

export async function loadTokens(shopId: string): Promise<StoredTokens | null> {
  const store = getStore(TOKENS)
  const blob = await store.get(shopId, { type: 'text' })
  if (!blob) return null
  try {
    return JSON.parse(decryptSecret(blob)) as StoredTokens
  } catch (error) {
    // A decryption failure means TOKEN_ENCRYPTION_KEY changed. Treat the shop
    // as unauthorised rather than crashing — it needs reconnecting, and saying
    // so is more useful than a stack trace.
    console.error(`[tikshop] Could not read tokens for ${shopId}; reauthorisation needed`, error)
    return null
  }
}

export interface StoredListing {
  listing_id: string
  shop_id: string
  product_name: string | null
  supplier: string | null
  default_weight_kg: string | null
  created_at: string
}

export async function listStoredListings(shopId: string): Promise<StoredListing[]> {
  const store = getStore(LISTINGS)
  const blob = await store.get(shopId, { type: 'json' })
  if (!blob) return []
  return (blob as StoredListing[]).slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** Add a stream, or return the existing entry. Idempotent. */
export async function addStoredListing(
  shopId: string,
  listingId: string,
): Promise<StoredListing> {
  const store = getStore(LISTINGS)
  const existing = await listStoredListings(shopId)
  const found = existing.find((l) => l.listing_id === listingId)
  if (found) return found

  const listing: StoredListing = {
    listing_id: listingId,
    shop_id: shopId,
    product_name: null,
    supplier: null,
    default_weight_kg: null,
    created_at: new Date().toISOString(),
  }
  await store.setJSON(shopId, [listing, ...existing])
  return listing
}
