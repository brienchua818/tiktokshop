import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createSession,
  verifySession,
  isAllowedEmail,
  sessionCookie,
  clearCookie,
  readSessionCookie,
  currentUser,
} from './session'

/**
 * The app this replaces had no real authentication at all, so these tests
 * carry the weight of the thing that fixes it.
 */

const original = process.env.SESSION_SECRET

beforeAll(() => {
  process.env.SESSION_SECRET = 'a'.repeat(64)
})
afterAll(() => {
  if (original === undefined) delete process.env.SESSION_SECRET
  else process.env.SESSION_SECRET = original
})

const user = { email: 'brienchua@sheldonglobal.com', name: 'Brien Chua', picture: null }

describe('createSession / verifySession', () => {
  it('round-trips a signed-in user', () => {
    const payload = verifySession(createSession(user))
    expect(payload?.email).toBe(user.email)
    expect(payload?.name).toBe('Brien Chua')
  })

  it('rejects a missing token', () => {
    expect(verifySession(undefined)).toBeNull()
    expect(verifySession('')).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(verifySession('garbage')).toBeNull()
    expect(verifySession('a.b.c')).toBeNull()
  })

  it('rejects a tampered payload — the whole point of signing it', () => {
    const token = createSession(user)
    const [, signature] = token.split('.') as [string, string]
    const forged = Buffer.from(
      JSON.stringify({ email: 'attacker@evil.com', name: 'x', picture: null, exp: 9_999_999_999 }),
      'utf8',
    ).toString('base64url')
    expect(verifySession(`${forged}.${signature}`)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = createSession(user)
    process.env.SESSION_SECRET = 'b'.repeat(64)
    try {
      expect(verifySession(token)).toBeNull()
    } finally {
      process.env.SESSION_SECRET = 'a'.repeat(64)
    }
  })

  it('rejects an expired session', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    expect(verifySession(createSession(user, eightDaysAgo))).toBeNull()
  })

  it('accepts a session issued six days ago', () => {
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000
    expect(verifySession(createSession(user, sixDaysAgo))).not.toBeNull()
  })

  it('rejects a validly signed token for a non-company address', () => {
    // Defence in depth: even if a token were minted for an outside address,
    // verification refuses it.
    const outsider = createSession({ email: 'someone@gmail.com', name: 'x', picture: null })
    expect(verifySession(outsider)).toBeNull()
  })
})

describe('isAllowedEmail', () => {
  it('accepts a company address, case-insensitively', () => {
    expect(isAllowedEmail('brienchua@sheldonglobal.com')).toBe(true)
    expect(isAllowedEmail('Brien.Chua@SheldonGlobal.COM')).toBe(true)
  })

  it('refuses a personal account', () => {
    expect(isAllowedEmail('brienchua@gmail.com')).toBe(false)
  })

  it('refuses lookalike domains that a naive endsWith would allow', () => {
    expect(isAllowedEmail('a@sheldonglobal.com.evil.com')).toBe(false)
    expect(isAllowedEmail('a@notsheldonglobal.com')).toBe(false)
    expect(isAllowedEmail('a@evil.com?x=sheldonglobal.com')).toBe(false)
  })

  it('refuses malformed or empty addresses', () => {
    expect(isAllowedEmail('')).toBe(false)
    expect(isAllowedEmail(null)).toBe(false)
    expect(isAllowedEmail(undefined)).toBe(false)
    expect(isAllowedEmail('no-at-sign')).toBe(false)
    expect(isAllowedEmail('@sheldonglobal.com')).toBe(false)
  })

  it('uses the last @ so an address cannot smuggle a domain in the local part', () => {
    expect(isAllowedEmail('sheldonglobal.com@evil.com')).toBe(false)
  })
})

describe('cookies', () => {
  it('marks the session cookie HttpOnly and Secure so scripts cannot read it', () => {
    const cookie = sessionCookie('token123')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
  })

  it('clears with an immediate expiry', () => {
    expect(clearCookie()).toContain('Max-Age=0')
  })

  it('reads its own cookie out of a header with others present', () => {
    const request = new Request('https://x.test/api/me', {
      headers: { cookie: 'other=1; tikshop_session=abc.def; another=2' },
    })
    expect(readSessionCookie(request)).toBe('abc.def')
  })

  it('returns undefined when no cookie header is present', () => {
    expect(readSessionCookie(new Request('https://x.test/api/me'))).toBeUndefined()
  })

  it('resolves the current user from a request', () => {
    const token = createSession(user)
    const request = new Request('https://x.test/api/me', {
      headers: { cookie: sessionCookie(token).split(';')[0]! },
    })
    expect(currentUser(request)?.email).toBe(user.email)
  })

  it('treats a request with no cookie as signed out', () => {
    expect(currentUser(new Request('https://x.test/api/me'))).toBeNull()
  })
})
