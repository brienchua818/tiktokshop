import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/**
 * Sessions.
 *
 * The app this replaces "authenticated" by comparing a hardcoded password in
 * the browser and setting `localStorage.tikshop_authed = "1"`. Anyone could
 * read the password out of the public bundle, or skip the check entirely by
 * setting that one value in a console.
 *
 * Here the session is a signed token in an HTTP-only cookie. The browser
 * cannot read it, cannot forge it without the server secret, and cannot
 * extend its own expiry.
 */

const COOKIE_NAME = 'tikshop_session'

/** Seven days. Long enough not to interrupt a livestream, short enough to matter. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/** Only accounts on this domain may sign in. */
export const ALLOWED_DOMAIN = 'sheldonglobal.com'

export interface SessionPayload {
  email: string
  name: string
  picture: string | null
  /** Expiry as epoch seconds. */
  exp: number
}

function secret(): string {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < 32) {
    throw new Error(
      'SESSION_SECRET is missing or shorter than 32 characters. Generate one with: openssl rand -hex 32',
    )
  }
  return value
}

function signPayload(encoded: string): string {
  return createHmac('sha256', secret()).update(encoded).digest('base64url')
}

/** Build a signed session token. */
export function createSession(
  user: { email: string; name: string; picture: string | null },
  now: number = Date.now(),
): string {
  const payload: SessionPayload = {
    email: user.email,
    name: user.name,
    picture: user.picture,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${signPayload(encoded)}`
}

/**
 * Verify a token and return its payload, or null.
 *
 * Returns null rather than throwing for every rejection reason — an expired
 * cookie and a forged one are both simply "not signed in", and distinguishing
 * them for the caller would leak which is which.
 */
export function verifySession(token: string | undefined, now: number = Date.now()): SessionPayload | null {
  if (!token) return null

  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, signature] = parts as [string, string]

  const expected = signPayload(encoded)
  // Constant-time compare, so response timing cannot be used to guess a
  // signature byte by byte.
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
  } catch {
    return null
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null
  if (!isAllowedEmail(payload.email)) return null

  return payload
}

/**
 * Domain check.
 *
 * Case-insensitive, and matches the domain exactly — `@sheldonglobal.com.evil`
 * and `@notsheldonglobal.com` must both fail, which a naive `endsWith` would
 * not catch.
 */
export function isAllowedEmail(email: string | undefined | null): boolean {
  if (!email) return false
  const at = email.lastIndexOf('@')
  if (at < 1) return false
  return email.slice(at + 1).toLowerCase() === ALLOWED_DOMAIN
}

/** Cookie header for a new session. */
export function sessionCookie(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    // Lax rather than Strict: the Google sign-in redirect is a cross-site
    // navigation back to us, and Strict would drop the cookie on arrival.
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ')
}

/** Cookie header that clears the session. */
export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/** Pull our cookie out of a request's Cookie header. */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE_NAME) return rest.join('=')
  }
  return undefined
}

/** The signed-in user for a request, or null. */
export function currentUser(request: Request): SessionPayload | null {
  return verifySession(readSessionCookie(request))
}

/** Random state value for the OAuth round trip. */
export function randomState(): string {
  return randomBytes(16).toString('base64url')
}
