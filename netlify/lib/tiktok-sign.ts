import { createHmac } from 'node:crypto'

/**
 * TikTok Shop request signing.
 *
 * Transcribed from https://partner.tiktokshop.com/docv2/page/sign-your-api-request
 * and https://partner.tiktokshop.com/docv2/page/common-parameters
 *
 * The algorithm is unusual in three ways that are easy to get wrong, so each is
 * called out below: the path is prepended, parameters are concatenated with no
 * separators at all, and the whole string is wrapped in the app secret at both
 * ends.
 *
 * This module runs only on the server. The app secret must never reach the
 * browser — that mistake is precisely what made the app this replaces
 * insecure.
 */

export const API_HOST = 'https://open-api.tiktokglobalshop.com'

/** Token exchange and refresh live on a different host and are NOT signed. */
export const AUTH_HOST = 'https://auth.tiktok-shops.com'

/** Seller consent entry point for non-US markets, Singapore included. */
export const AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize'

/**
 * Parameters excluded from the signature. `sign` obviously cannot sign itself;
 * `access_token` is excluded by the spec (for 202309+ it travels as the
 * `x-tts-access-token` header rather than a query parameter anyway).
 */
const EXCLUDED_FROM_SIGNATURE = new Set(['sign', 'access_token'])

export interface SignInput {
  /** Path exactly as it follows the host, e.g. "/authorization/202309/shops". */
  path: string
  /** Query parameters, excluding `sign`. Include `app_key` and `timestamp`. */
  query: Record<string, string | number | undefined>
  /**
   * The exact request body bytes that will be sent, or undefined for GET.
   * Must be byte-identical to what goes on the wire — re-serialising later
   * with different key order or spacing invalidates the signature.
   */
  body?: string
  /**
   * True for multipart/form-data requests, such as product image upload.
   * The body is omitted from the signature in that case.
   */
  isMultipart?: boolean
  appSecret: string
}

/**
 * Build the string that gets HMAC'd. Exported for testing — the intermediate
 * value is the part worth asserting on, since a wrong signature otherwise
 * surfaces only as an opaque 401 from TikTok.
 */
export function buildSignatureBase(input: SignInput): string {
  const { path, query, body, isMultipart, appSecret } = input

  // 1 & 2: drop excluded and undefined keys, then sort ascending by key.
  const keys = Object.keys(query)
    .filter((k) => !EXCLUDED_FROM_SIGNATURE.has(k) && query[k] !== undefined)
    .sort()

  // 3: concatenate as {key}{value} with NO separators — no "=", no "&".
  let joined = ''
  for (const key of keys) {
    joined += `${key}${String(query[key])}`
  }

  // 4: the request path is prepended.
  let base = `${path}${joined}`

  // 5: the raw body is appended, except for multipart uploads.
  if (body !== undefined && !isMultipart) {
    base += body
  }

  // 6: wrap with the app secret at both ends.
  return `${appSecret}${base}${appSecret}`
}

/** Lowercase hex HMAC-SHA256, keyed by the app secret. */
export function sign(input: SignInput): string {
  return createHmac('sha256', input.appSecret)
    .update(buildSignatureBase(input), 'utf8')
    .digest('hex')
}

/**
 * TikTok expects a 10-digit Unix timestamp in SECONDS, not milliseconds, and
 * accepts it only within [now - 5 minutes, now + 30 seconds]. Outside that
 * window every call fails with 36009004 "Invalid timestamp".
 */
export function timestampSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000)
}

export interface SignedRequest {
  url: string
  headers: Record<string, string>
  body?: string
}

/**
 * Assemble a fully signed request. Callers should not construct URLs by hand —
 * the signature depends on the exact query set, so building it in one place is
 * what keeps signing and sending in step.
 */
export function buildSignedRequest(opts: {
  path: string
  method: 'GET' | 'POST' | 'PUT'
  appKey: string
  appSecret: string
  accessToken: string
  /** Omit for endpoints that are not shop-scoped, e.g. image upload. */
  shopCipher?: string
  query?: Record<string, string | number | undefined>
  /** Plain object; serialised here so the signed and sent bytes match. */
  json?: unknown
  isMultipart?: boolean
  now?: number
}): SignedRequest {
  const body = opts.json === undefined ? undefined : JSON.stringify(opts.json)

  const query: Record<string, string | number | undefined> = {
    ...opts.query,
    app_key: opts.appKey,
    timestamp: timestampSeconds(opts.now),
  }
  if (opts.shopCipher) {
    query.shop_cipher = opts.shopCipher
  }

  const signature = sign({
    path: opts.path,
    query,
    body,
    isMultipart: opts.isMultipart,
    appSecret: opts.appSecret,
  })

  const search = new URLSearchParams()
  for (const key of Object.keys(query).sort()) {
    const value = query[key]
    if (value !== undefined) search.set(key, String(value))
  }
  search.set('sign', signature)

  const headers: Record<string, string> = {
    'x-tts-access-token': opts.accessToken,
  }
  if (body !== undefined && !opts.isMultipart) {
    headers['content-type'] = 'application/json'
  }

  const result: SignedRequest = {
    url: `${API_HOST}${opts.path}?${search.toString()}`,
    headers,
  }
  if (body !== undefined) result.body = body
  return result
}
