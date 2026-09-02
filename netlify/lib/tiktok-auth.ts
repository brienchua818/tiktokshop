import { AUTH_HOST, AUTHORIZE_URL } from './tiktok-sign'

/**
 * TikTok Shop OAuth: exchanging an auth code for tokens, and refreshing them.
 *
 * These two calls are shaped unlike every other TikTok call and the
 * differences are all traps:
 *
 *   - they live on auth.tiktok-shops.com, not the API host;
 *   - they are NOT signed — no `sign`, no `timestamp`;
 *   - `app_secret` travels in the query string, so they may only ever run
 *     server-side;
 *   - `grant_type` is `authorized_code`, not the OAuth-standard
 *     `authorization_code`. The standard spelling fails.
 *
 * Reference:
 *   https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
 */

export interface TokenResponse {
  access_token: string
  /** Absolute epoch SECONDS, not a duration. */
  access_token_expire_in: number
  refresh_token: string
  /** Absolute epoch SECONDS. Equals the duration the seller granted. */
  refresh_token_expire_in: number
  open_id: string
  seller_name: string
  seller_base_region: string
  granted_scopes?: string[]
}

interface TikTokEnvelope<T> {
  code: number
  message: string
  data: T
  request_id?: string
}

/**
 * Build the consent URL a shop owner opens to authorise the app.
 *
 * `state` is not optional in practice — without it the callback cannot be tied
 * back to the shop that started the flow, which is how a CSRF becomes possible
 * and how, with three shops, tokens get filed against the wrong brand.
 */
export function buildAuthorizeUrl(serviceId: string, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('service_id', serviceId)
  url.searchParams.set('state', state)
  return url.toString()
}

async function callTokenEndpoint(
  path: '/api/v2/token/get' | '/api/v2/token/refresh',
  params: Record<string, string>,
): Promise<TokenResponse> {
  const url = new URL(`${AUTH_HOST}${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const response = await fetch(url, { method: 'GET' })
  const text = await response.text()

  let payload: TikTokEnvelope<TokenResponse>
  try {
    payload = JSON.parse(text) as TikTokEnvelope<TokenResponse>
  } catch {
    // Surface the body rather than a JSON parse error — TikTok occasionally
    // returns an HTML error page, and "unexpected token <" tells you nothing.
    throw new Error(`TikTok token endpoint returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`)
  }

  // A non-zero `code` is a failure even when the HTTP status is 200, which is
  // easy to miss and presents as a token that is simply undefined later.
  if (payload.code !== 0 || !payload.data?.access_token) {
    throw new Error(
      `TikTok token exchange failed (code ${payload.code}): ${payload.message || 'no message'}`,
    )
  }

  return payload.data
}

/**
 * Exchange the `code` from the authorise callback for tokens.
 *
 * The auth code is single-use and expires 30 minutes after issue, so a failure
 * here means restarting the consent flow rather than retrying.
 */
export function exchangeAuthCode(opts: {
  appKey: string
  appSecret: string
  authCode: string
}): Promise<TokenResponse> {
  return callTokenEndpoint('/api/v2/token/get', {
    app_key: opts.appKey,
    app_secret: opts.appSecret,
    auth_code: opts.authCode,
    grant_type: 'authorized_code',
  })
}

/**
 * Refresh an access token.
 *
 * The response carries a NEW refresh token as well, and it must be persisted.
 * Keeping the old one is a bug that only appears a week later, when the access
 * token lapses and the stale refresh token cannot renew it.
 *
 * Once the refresh token itself expires, only a fresh authorisation recovers
 * the shop — there is no programmatic route back.
 */
export function refreshAccessToken(opts: {
  appKey: string
  appSecret: string
  refreshToken: string
}): Promise<TokenResponse> {
  return callTokenEndpoint('/api/v2/token/refresh', {
    app_key: opts.appKey,
    app_secret: opts.appSecret,
    refresh_token: opts.refreshToken,
    grant_type: 'refresh_token',
  })
}
