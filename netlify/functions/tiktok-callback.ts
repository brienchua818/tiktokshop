import { exchangeAuthCode } from '../lib/tiktok-auth'
import { verifyState } from '../lib/oauth-state'
import { saveShopTokens } from '../lib/db'
import { hasDatabase, saveTokens } from '../lib/store'
import { appCredentials, findShop, isConfigured } from '../lib/shops-config'
import { call } from '../lib/tiktok-api'

/**
 * Where TikTok sends the shop owner back after they approve the app.
 *
 * This is the URL registered in Partner Center as the app's Redirect URL:
 *   https://sheldon-tikshop.netlify.app/api/tiktok-callback
 *
 * It runs WITHOUT a session on purpose — the browser arriving here is coming
 * back from TikTok and may not carry our cookie through the cross-site
 * redirect. The signed `state` is what authenticates the request instead, and
 * it is also what tells us which of the three shops this is for.
 */
export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  // A rejection still redirects here, with code=null&error=auth_denied.
  if (error || !code || code === 'null') {
    return redirect(`/?tiktok=denied`)
  }

  const shopId = verifyState(url.searchParams.get('state'))
  if (!shopId) {
    // Either forged, or the shop owner took more than five minutes. Both mean
    // start again rather than guess which shop this belongs to.
    return redirect('/?tiktok=expired')
  }

  try {
    if (!findShop(shopId) || !isConfigured(shopId)) {
      return redirect('/?tiktok=unconfigured')
    }
    const { appKey, appSecret } = appCredentials(shopId)

    const tokens = await exchangeAuthCode({
      appKey,
      appSecret,
      // Single-use, and expires 30 minutes after issue.
      authCode: code,
    })

    // The token is per seller account, so ask TikTok which shops it covers and
    // take the cipher. Never hardcode it — the docs say so explicitly.
    const shops = await call<{ shops: { cipher: string; id: string; name: string }[] }>({
      path: '/authorization/202309/shops',
      method: 'GET',
      appKey,
      appSecret,
      accessToken: tokens.access_token,
    })

    const cipher = shops.shops[0]?.cipher ?? null

    // TikTok returns absolute epoch SECONDS, not durations.
    const accessExpiry = new Date(tokens.access_token_expire_in * 1000)
    const refreshExpiry = new Date(tokens.refresh_token_expire_in * 1000)

    if (hasDatabase()) {
      await saveShopTokens(shopId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: accessExpiry,
        refreshTokenExpiresAt: refreshExpiry,
        shopCipher: cipher,
      })
    } else {
      await saveTokens(shopId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: accessExpiry.toISOString(),
        refreshTokenExpiresAt: refreshExpiry.toISOString(),
        shopCipher: cipher,
      })
    }

    return redirect('/?tiktok=connected')
  } catch (cause) {
    console.error('[tikshop] TikTok callback failed', cause)
    return redirect('/?tiktok=failed')
  }
}

/** Send the browser back to the app rather than showing it raw JSON. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
}
