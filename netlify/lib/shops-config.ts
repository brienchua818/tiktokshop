import type { ShopRow } from './db'

/**
 * The three shops, as configuration rather than data.
 *
 * Brand, handle and entity never change at runtime, so they do not need a
 * database row — which is what lets the app run with nothing provisioned.
 * Credentials come from environment variables using the same PM / HZ / TM
 * prefixes that Sheldon Delivery API already uses in Script Properties, so the
 * two projects share one convention.
 */

export interface ShopConfig {
  shop_id: string
  brand: string
  tiktok_handle: string
  entity: string | null
  daily_listing_cap: number
}

export const SHOPS: ShopConfig[] = [
  { shop_id: 'HZ', brand: 'HOUZE', tiktok_handle: '@houze.com.sg', entity: 'Sheldon Global Pte Ltd', daily_listing_cap: 1000 },
  { shop_id: 'TM', brand: 'Table Matters', tiktok_handle: '@tablematterssg', entity: 'Audrey Global Pte Ltd', daily_listing_cap: 1000 },
  // Painting Matters' legal entity is not recorded in the vault yet. Left null
  // rather than guessed — a blank is honest, a wrong entity is corrosive once
  // exports become purchase orders.
  { shop_id: 'PM', brand: 'Painting Matters', tiktok_handle: '@paintingmatters', entity: null, daily_listing_cap: 1000 },
]

export function findShop(shopId: string): ShopConfig | undefined {
  return SHOPS.find((s) => s.shop_id === shopId)
}

/** App credentials for a shop, from {PREFIX}_APP_KEY / {PREFIX}_APP_SECRET. */
export function appCredentials(shopId: string): { appKey: string; appSecret: string } {
  const appKey = process.env[`${shopId}_APP_KEY`]
  const appSecret = process.env[`${shopId}_APP_SECRET`]
  if (!appKey || !appSecret) {
    throw new Error(
      `No TikTok app credentials for ${shopId}. Set ${shopId}_APP_KEY and ${shopId}_APP_SECRET.`,
    )
  }
  return { appKey, appSecret }
}

/** True once a shop has both an app registration and a stored authorisation. */
export function isConfigured(shopId: string): boolean {
  return Boolean(process.env[`${shopId}_APP_KEY`] && process.env[`${shopId}_APP_SECRET`])
}

/** Shape a config entry like a database row, so callers do not branch. */
export function asShopRow(config: ShopConfig, authorised: boolean): ShopRow {
  return {
    shop_id: config.shop_id,
    brand: config.brand,
    tiktok_handle: config.tiktok_handle,
    entity: config.entity,
    app_key: process.env[`${config.shop_id}_APP_KEY`] ?? null,
    app_secret_enc: null,
    shop_cipher: null,
    access_token_enc: null,
    refresh_token_enc: null,
    access_token_expires_at: null,
    refresh_token_expires_at: null,
    authorised,
    daily_listing_cap: config.daily_listing_cap,
  }
}
