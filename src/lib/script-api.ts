/**
 * Client for the Apps Script backend.
 *
 * The backend is a Google Apps Script web app, not a normal JSON API, and it
 * has three quirks that every call has to account for. They are handled once,
 * here, rather than at each call site.
 *
 * **1. The HTTP status is always 200.**
 * Apps Script's `ContentService` cannot set a status code, so the real one is
 * carried in the body as `_status`. Branching on `response.ok` would treat
 * "sign in first" and "TikTok refused this listing" as successes.
 *
 * **2. A POST must be a "simple request", or CORS blocks it.**
 * Apps Script does not answer the `OPTIONS` preflight that a
 * `Content-Type: application/json` POST triggers, so the browser refuses the
 * request before it is sent. Sending `text/plain` avoids the preflight
 * entirely, and the router parses the body as JSON regardless of what the
 * header claims.
 *
 * **3. Every call answers with a 302 to `script.googleusercontent.com`.**
 * `fetch` follows it, and a 302 turns a POST into a GET — which is exactly
 * what the echo URL expects. Verified end to end against the live deployment
 * before this was written.
 *
 * Everything is a POST, including reads. Not for correctness — the router
 * takes parameters from the query string or the body — but so the Google ID
 * token travels in the body rather than in a URL, and therefore stays out of
 * browser history, referrers and Google's own request logs.
 */

const BASE = import.meta.env.VITE_APPS_SCRIPT_URL as string | undefined

export class ScriptError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable code, where the backend sends one. */
    readonly code?: string | number,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ScriptError'
  }

  /** The session has expired or was never established. */
  get isAuthError(): boolean {
    return this.status === 401
  }

  /** Signed in, but not yet approved to act — a different thing from not signed in. */
  get isPending(): boolean {
    return this.status === 403
  }

  /** Retrying unchanged is the right response. */
  get isRetryable(): boolean {
    return this.status === 0 || this.code === 'LISTING_BUSY' || this.status >= 500
  }

  /** The stream has outgrown this listing and needs a continuation. */
  get isListingFull(): boolean {
    return this.code === 'LISTING_FULL'
  }
}

/**
 * The Google ID token.
 *
 * Held in memory, and mirrored to sessionStorage so a page reload does not
 * force a fresh sign-in prompt. Deliberately NOT localStorage: the token is a
 * bearer credential with about an hour's life, and it has no business
 * outliving the tab it was issued to.
 */
let idToken: string | null = null

const TOKEN_KEY = 'tikshop.id_token'

export function setIdToken(token: string | null): void {
  idToken = token
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // Private mode, or storage disabled. The in-memory copy still works for
    // this tab, which is the case that matters.
  }
}

export function getIdToken(): string | null {
  if (idToken) return idToken
  try {
    idToken = sessionStorage.getItem(TOKEN_KEY)
  } catch {
    idToken = null
  }
  return idToken
}

/** Seconds until the token expires, or 0 if it is gone or unreadable. */
export function tokenSecondsLeft(token = getIdToken()): number {
  if (!token) return 0
  try {
    // A JWT's middle segment is base64url-encoded JSON. Read `exp` rather than
    // waiting for a 401: re-prompting a second before a push is far better
    // than losing the push and re-prompting after.
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    const exp = Number(payload.exp)
    if (!Number.isFinite(exp)) return 0
    return Math.max(0, Math.floor(exp - Date.now() / 1000))
  } catch {
    return 0
  }
}

/** True when the token is gone, or close enough to expiry to be worth renewing. */
export function tokenNeedsRenewal(marginSeconds = 300): boolean {
  return tokenSecondsLeft() < marginSeconds
}

export interface CallOptions {
  /** Sent in the body alongside the token. */
  body?: Record<string, unknown>
  /** Skip the token — only `ping`, which is the health check. */
  anonymous?: boolean
}

/**
 * Call one backend action.
 *
 * `action` goes in the query string because the router reads it from there;
 * everything else goes in the body.
 */
export async function call<T>(action: string, options: CallOptions = {}): Promise<T> {
  if (!BASE) {
    throw new ScriptError(
      0,
      'The app is not pointed at a backend yet (VITE_APPS_SCRIPT_URL is unset). This is a deployment problem, not something you can fix here.',
    )
  }

  const token = options.anonymous ? undefined : getIdToken()
  if (!options.anonymous && !token) {
    throw new ScriptError(401, 'Sign in with Google to continue.')
  }

  let response: Response
  try {
    response = await fetch(`${BASE}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      // text/plain keeps this a "simple request" so no CORS preflight is
      // triggered — Apps Script would not answer one. The router parses the
      // body as JSON regardless of the declared type.
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...options.body, ...(token ? { id_token: token } : {}) }),
      // Explicit rather than relied upon: the 302 to script.googleusercontent.com
      // is how every Apps Script response is delivered.
      redirect: 'follow',
    })
  } catch (cause) {
    // "No signal" and "the server said no" are different problems: the first
    // is what the offline queue exists to absorb and must not read as an error.
    throw new ScriptError(0, `No connection: ${(cause as Error).message}`)
  }

  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // Apps Script serves an HTML page when a deployment is missing, or when
    // the script itself failed to load. Saying so beats a JSON parse error.
    throw new ScriptError(
      502,
      'The backend returned a page instead of data. The Apps Script deployment may be out of date or not published to "Anyone".',
    )
  }

  // Quirk 1: the real status is in the body.
  const status = Number(payload._status ?? 200)
  if (status >= 400) {
    throw new ScriptError(
      status,
      (payload.error as string) ?? `Request failed (${status}).`,
      payload.code as string | number | undefined,
      payload,
    )
  }

  return payload as T
}

/** Health check. The only action that needs no identity. */
export function ping(): Promise<{ ok: boolean; time: string }> {
  return call('ping', { anonymous: true })
}
