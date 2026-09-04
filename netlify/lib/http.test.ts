import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { withAuth, json, serverError } from './http'
import { createSession, sessionCookie } from './session'

/**
 * These exist because of a real bug found on the live deploy: a thrown error
 * inside the auth check escaped the handler, and the platform returned the
 * full stack trace and server file paths to the caller.
 *
 * That is information disclosure, and this app exists to stop making exactly
 * that class of mistake — so it gets a test rather than just a fix.
 */

const original = process.env.SESSION_SECRET

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (original === undefined) delete process.env.SESSION_SECRET
  else process.env.SESSION_SECRET = original
  vi.restoreAllMocks()
})

function requestWithCookie(cookie?: string): Request {
  return new Request('https://x.test/api/me', cookie ? { headers: { cookie } } : {})
}

describe('withAuth', () => {
  it('refuses an unauthenticated request', async () => {
    process.env.SESSION_SECRET = 'a'.repeat(64)
    const handler = withAuth(async () => json({ secret: 'data' }))
    const response = await handler(requestWithCookie())
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('secret')
  })

  it('lets a valid session through', async () => {
    process.env.SESSION_SECRET = 'a'.repeat(64)
    const token = createSession({
      email: 'brienchua@sheldonglobal.com',
      name: 'Brien',
      picture: null,
    })
    const handler = withAuth(async (_r, { user }) => json({ email: user.email }))
    const response = await handler(requestWithCookie(sessionCookie(token).split(';')[0]!))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ email: 'brienchua@sheldonglobal.com' })
  })

  it('never leaks a stack trace when the auth check itself throws', async () => {
    // The exact live failure: SESSION_SECRET unset, so verifying a cookie
    // throws inside the auth check.
    delete process.env.SESSION_SECRET
    const handler = withAuth(async () => json({ ok: true }))
    const response = await handler(requestWithCookie('tikshop_session=fake.signature'))

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe(JSON.stringify({ error: 'Something went wrong.' }))
    // The three things that must never reach a caller.
    expect(body).not.toContain('SESSION_SECRET')
    expect(body).not.toContain('/var/task')
    expect(body).not.toMatch(/at \w+ \(/)
  })

  it('never leaks a stack trace when the handler throws', async () => {
    process.env.SESSION_SECRET = 'a'.repeat(64)
    const token = createSession({
      email: 'brienchua@sheldonglobal.com',
      name: 'Brien',
      picture: null,
    })
    const handler = withAuth(async () => {
      throw new Error('DATABASE_URL is not set: postgres://user:password@host/db')
    })
    const response = await handler(requestWithCookie(sessionCookie(token).split(';')[0]!))

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).not.toContain('postgres://')
    expect(body).not.toContain('password')
  })
})

describe('serverError', () => {
  it('logs the real error but returns a safe one', async () => {
    const response = serverError(new Error('secret internal detail'))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret internal detail')
    expect(console.error).toHaveBeenCalled()
  })

  it('sets no-store so an error is never cached', () => {
    expect(serverError(new Error('x')).headers.get('cache-control')).toBe('no-store')
  })
})
