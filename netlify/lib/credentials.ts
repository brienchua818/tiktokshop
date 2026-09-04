import { appCredentials, findShop, isConfigured } from './shops-config'
import { hasDatabase, loadTokens, saveTokens } from './store'
import { shopCredentials as dbShopCredentials } from './db'
import { refreshAccessToken } from './tiktok-auth'
import { needsRefresh } from './crypto'

/**
 * Credentials ready to call TikTok with.
 *
 * One entry point for both storage paths: Postgres when DATABASE_URL is set,
 * Netlify Blobs otherwise. Handlers do not branch — they ask for credentials
 * and get them.
 */

export interface Credentials {
  appKey: string
  appSecret: string
  accessToken: string
  shopCipher: string | undefined
  brand: string
}

export async function credentialsFor(shopId: string): Promise<Credentials> {
  if (hasDatabase()) return dbShopCredentials(shopId)

  const shop = findShop(shopId)
  if (!shop) throw new Error(`Unknown shop: ${shopId}`)
  if (!isConfigured(shopId)) {
    throw new Error(`${shop.brand} has no TikTok app credentials configured.`)
  }

  const { appKey, appSecret } = appCredentials(shopId)
  const stored = await loadTokens(shopId)
  if (!stored) {
    throw new Error(`${shop.brand} is not connected to TikTok yet.`)
  }

  let accessToken = stored.accessToken
  let shopCipher = stored.shopCipher ?? undefined

  if (needsRefresh(new Date(stored.accessTokenExpiresAt))) {
    if (new Date(stored.refreshTokenExpiresAt).getTime() < Date.now()) {
      // Past this point only a fresh authorisation recovers the shop; there is
      // no programmatic route back.
      throw new Error(
        `${shop.brand}'s TikTok authorisation has expired. It needs to be reconnected.`,
      )
    }
    const refreshed = await refreshAccessToken({
      appKey,
      appSecret,
      refreshToken: stored.refreshToken,
    })
    // Both tokens are persisted: TikTok issues a new refresh token every time,
    // and keeping the old one silently breaks the shop a week later.
    await saveTokens(shopId, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      accessTokenExpiresAt: new Date(refreshed.access_token_expire_in * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(refreshed.refresh_token_expire_in * 1000).toISOString(),
      shopCipher: stored.shopCipher,
    })
    accessToken = refreshed.access_token
    shopCipher = stored.shopCipher ?? undefined
  }

  return { appKey, appSecret, accessToken, shopCipher, brand: shop.brand }
}

/** Whether a shop has a usable authorisation, without throwing. */
export async function isAuthorised(shopId: string): Promise<boolean> {
  try {
    if (!isConfigured(shopId)) return false
    if (hasDatabase()) {
      await dbShopCredentials(shopId)
      return true
    }
    return (await loadTokens(shopId)) !== null
  } catch {
    return false
  }
}
