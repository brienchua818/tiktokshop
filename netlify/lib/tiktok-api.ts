import { buildSignedRequest } from './tiktok-sign'

/**
 * Calling TikTok's business APIs.
 *
 * Two behaviours here are not optional given how this app is used:
 *
 * 1. TikTok returns HTTP 200 with a non-zero `code` for business failures. A
 *    naive `response.ok` check treats a rejected listing as a success, which
 *    is how a SKU silently fails to appear. Every call goes through
 *    `unwrap()`.
 *
 * 2. Rate limits are allocated dynamically per app x shop, and at three shops
 *    we sit near the bottom of the range — roughly one write per second. So
 *    writes are retried with backoff on throttling, and callers push through
 *    a serial queue rather than firing in parallel.
 */

/** Throttled: HTTP 429, or business code 36009002. */
const RATE_LIMITED_CODE = 36009002
/** Timestamp outside the accepted [-5min, +30s] window. */
export const INVALID_TIMESTAMP_CODE = 36009004
/** Daily product-listing allowance exhausted. */
export const LISTING_LIMIT_CODE = 12052093

export class TikTokApiError extends Error {
  constructor(
    /** TikTok's business code. 0 means success. */
    readonly code: number,
    /** TikTok's own message, shown to the user verbatim. */
    readonly detail: string,
    readonly httpStatus: number,
    readonly requestId?: string,
  ) {
    super(`TikTok error ${code}: ${detail}`)
    this.name = 'TikTokApiError'
  }

  /** True when retrying later could plausibly succeed. */
  get isRetryable(): boolean {
    return this.code === RATE_LIMITED_CODE || this.httpStatus === 429 || this.httpStatus >= 500
  }

  /** True when the shop has used up its daily listing allowance. */
  get isDailyLimit(): boolean {
    return this.code === LISTING_LIMIT_CODE
  }
}

interface Envelope<T> {
  code: number
  message: string
  data: T
  request_id?: string
}

export interface CallOptions {
  path: string
  method: 'GET' | 'POST' | 'PUT'
  appKey: string
  appSecret: string
  accessToken: string
  shopCipher?: string
  query?: Record<string, string | number | undefined>
  json?: unknown
  /** Total attempts, including the first. Only retryable failures are retried. */
  maxAttempts?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Make one signed call, retrying only on throttling and server errors.
 *
 * A rejected listing is never retried — it would fail identically and burn
 * part of the daily allowance doing so.
 */
export async function call<T>(opts: CallOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4
  let lastError: TikTokApiError | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Re-sign every attempt: the signature covers `timestamp`, which only
    // stays valid for a few minutes. Reusing it would eventually fail with
    // 36009004 instead of succeeding.
    const request = buildSignedRequest({
      path: opts.path,
      method: opts.method,
      appKey: opts.appKey,
      appSecret: opts.appSecret,
      accessToken: opts.accessToken,
      ...(opts.shopCipher ? { shopCipher: opts.shopCipher } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.json !== undefined ? { json: opts.json } : {}),
    })

    let response: Response
    try {
      response = await fetch(request.url, {
        method: opts.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      })
    } catch (cause) {
      // A dropped connection on factory Wi-Fi. Retryable, and the reason
      // every create carries an idempotency key.
      lastError = new TikTokApiError(-1, `Network error: ${(cause as Error).message}`, 0)
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw lastError
    }

    const text = await response.text()
    let payload: Envelope<T>
    try {
      payload = JSON.parse(text) as Envelope<T>
    } catch {
      lastError = new TikTokApiError(
        -1,
        `Non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`,
        response.status,
      )
      if (lastError.isRetryable && attempt < maxAttempts) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw lastError
    }

    if (payload.code === 0) {
      return payload.data
    }

    lastError = new TikTokApiError(
      payload.code,
      payload.message || 'no message',
      response.status,
      payload.request_id,
    )

    if (lastError.isRetryable && attempt < maxAttempts) {
      await sleep(backoffMs(attempt, response.headers.get('retry-after')))
      continue
    }
    throw lastError
  }

  throw lastError ?? new TikTokApiError(-1, 'Request failed with no error recorded', 0)
}

/**
 * Exponential backoff with jitter, honouring Retry-After when TikTok sends it.
 * Jitter matters because three shops refreshing or pushing at once would
 * otherwise retry in lockstep.
 */
export function backoffMs(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10)
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 60_000)
    }
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000)
  return base + Math.floor(Math.random() * 500)
}

/**
 * Run tasks strictly one at a time with a minimum gap between them.
 *
 * Product creation goes through this. At roughly one write per second, firing
 * 200 SKUs in parallel would trip the rate limiter and turn a livestream's
 * work into a pile of retryable failures.
 */
export async function serialise<T>(
  tasks: readonly (() => Promise<T>)[],
  minGapMs = 1000,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = []
  for (const [index, task] of tasks.entries()) {
    if (index > 0) await sleep(minGapMs)
    try {
      results.push({ status: 'fulfilled', value: await task() })
    } catch (reason) {
      // One rejected SKU must not abandon the rest of the queue.
      results.push({ status: 'rejected', reason })
    }
  }
  return results
}
