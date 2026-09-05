import { currentUser, type SessionPayload } from './session'
import { verifyIdToken } from './google-auth'

/**
 * Shared HTTP helpers for the functions.
 *
 * Two rules enforced here rather than remembered in each handler:
 * every endpoint requires a session, and no internal error text ever reaches
 * the browser.
 */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

export function unauthorised(): Response {
  return json({ error: 'Not signed in.' }, 401)
}

/**
 * Log the real error, return a safe one.
 *
 * Handlers that talk to TikTok pass `detail` through deliberately, because
 * TikTok's rejection text is exactly what the operator needs to see. Anything
 * else — a database error, a missing env var — is logged and replaced.
 */
export function serverError(error: unknown, safeMessage = 'Something went wrong.'): Response {
  console.error('[tikshop]', error)
  return json({ error: safeMessage }, 500)
}

export interface Authed {
  user: SessionPayload
}

/**
 * Wrap a handler so it only runs for a signed-in company account.
 *
 * This is the single gate. Forgetting it on one endpoint is how the previous
 * app's backend ended up open, so it is applied by default rather than
 * remembered per file.
 */
export function withAuth(
  handler: (request: Request, ctx: Authed) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    // currentUser() is INSIDE the try. It can throw — a missing SESSION_SECRET
    // makes it throw — and an escaped throw is handled by the platform, which
    // returns the full stack trace and server file paths to the caller. That
    // is information disclosure, and it is precisely the class of mistake this
    // app exists to stop making.
    try {
      const user = currentUser(request)
      if (!user) return unauthorised()
      return await handler(request, { user })
    } catch (error) {
      return serverError(error)
    }
  }
}

/** Identity established from a Google ID token, rather than a session cookie. */
export interface IdentifiedUser {
  email: string
  name: string
}

/**
 * How long an allowlist answer is trusted before it is checked again.
 *
 * Short enough that revoking someone takes effect within a livestream, long
 * enough that a burst of pushes does not make a round trip each time. Cached
 * per Lambda instance, so it is at worst a few minutes stale on one warm
 * instance.
 */
const APPROVAL_TTL_MS = 5 * 60_000
const approvals = new Map<string, { approved: boolean; checked: number }>()

function appsScriptUrl(): string | undefined {
  // VITE_ prefixed so the frontend build sees it too; read under both names so
  // renaming one does not silently break the other.
  return process.env.APPS_SCRIPT_URL || process.env.VITE_APPS_SCRIPT_URL
}

/**
 * Is this person allowed to act, according to the Apps Script allowlist?
 *
 * The allowlist lives in the Sheet and is the single authority on who may do
 * anything — so these functions ask it rather than keeping a second copy that
 * could drift.
 *
 * It matters here specifically because these are the AI endpoints. A valid
 * Google ID token proves only that someone has a Google account, and every
 * one of these calls costs real money: without this check, anyone who found
 * the URL could run up the model bill.
 */
async function isApproved(idToken: string, email: string): Promise<boolean> {
  const cached = approvals.get(email)
  if (cached && Date.now() - cached.checked < APPROVAL_TTL_MS) return cached.approved

  const base = appsScriptUrl()
  if (!base) {
    // Fails CLOSED, for the same reason the audience check does: a backend
    // that cannot check permission must not assume it.
    console.error('[tikshop] APPS_SCRIPT_URL is unset; cannot check the allowlist')
    return false
  }

  try {
    const response = await fetch(`${base}?action=whoami`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ id_token: idToken }),
      redirect: 'follow',
    })
    const payload = (await response.json()) as { approved?: boolean; _status?: number }
    const approved = payload._status === undefined && payload.approved === true
    approvals.set(email, { approved, checked: Date.now() })
    return approved
  } catch (error) {
    console.error('[tikshop] allowlist check failed', error)
    return false
  }
}

/**
 * Authenticate with a Google ID token, and require an approved account.
 *
 * The Apps Script backend is the app's identity authority. These functions are
 * the AI calls, which live here only because the model API keys do — so they
 * verify the token themselves and then defer to the allowlist for permission.
 *
 * The token arrives in the body rather than a header, for the same reason the
 * Apps Script client puts it there: a header would trigger a CORS preflight,
 * and the two clients should not diverge over something so easy to forget.
 */
export function withIdToken(
  handler: (
    request: Request,
    ctx: { user: IdentifiedUser },
    body: Record<string, unknown>,
  ) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    // Everything inside the try, including reading the body: an escaped throw
    // is handled by the platform, which returns the stack trace and server
    // paths to the caller.
    try {
      let body: Record<string, unknown> = {}
      try {
        const text = await request.text()
        if (text) body = JSON.parse(text) as Record<string, unknown>
      } catch {
        return json({ error: 'Expected a JSON body.' }, 400)
      }

      const idToken = body.id_token as string | undefined
      const user = await verifyIdToken(idToken)
      if (!user || !idToken) return unauthorised()

      if (!(await isApproved(idToken, user.email))) {
        // Deliberately explicit: someone waiting for approval should know that
        // is what is happening, not see a generic refusal.
        return json(
          {
            error: `${user.email} is not approved to use this app yet. Ask Brien to approve the account.`,
          },
          403,
        )
      }

      return await handler(request, { user }, body)
    } catch (error) {
      return serverError(error)
    }
  }
}

/** Require a specific HTTP method. */
export function methodNotAllowed(allowed: string): Response {
  return json({ error: `Method not allowed. Use ${allowed}.` }, 405, { allow: allowed })
}

/** Read a required query parameter. */
export function requireParam(request: Request, name: string): string {
  const value = new URL(request.url).searchParams.get(name)
  if (!value) throw new HttpError(`Missing required parameter: ${name}`, 400)
  return value
}

/** An error carrying the status to return. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Convert a thrown HttpError into its response; rethrow anything else. */
export function toResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status)
  throw error
}
