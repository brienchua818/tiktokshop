import { currentUser, type SessionPayload } from './session'

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
