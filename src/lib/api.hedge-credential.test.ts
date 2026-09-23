// @vitest-environment happy-dom
/**
 * A session in its last minute is left off a later request, so a hedge can go
 * out carrying less than the request it is hedging. The hedge's refusal must
 * not end a read that the original — carrying the session — would answer, and
 * renew. Found by the third speed review, 23 Sep; this is its reproduction,
 * through the real api.me, retryRead and call, against a fake backend.
 */
import { describe, it, expect, vi } from 'vitest'

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('hedge sent after session crosses the 60s live margin', () => {
  it('whoami with a session 65s from expiry and an hour-old Google token', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_APPS_SCRIPT_URL', 'https://script.example/exec')
    const sa = await import('./script-api')
    const { api } = await import('./api')
    const now = Date.now()
    sa.setSessionToken(b64({ e: 'a@x.com', n: 'a', x: now + 65_000 }) + '.sig')
    sa.setIdToken('h.' + b64({ exp: Math.floor(now / 1000) - 3600 }) + '.s') // expired Google token
    const sent: string[] = []
    // Fake backend: a live session is honoured (slowly: Apps Script spike);
    // an expired Google token alone is refused quickly by tokeninfo.
    ;(globalThis as any).fetch = vi.fn((_url: string, init: any) => {
      const body = JSON.parse(init.body)
      sent.push(body.session_token ? 'session+id' : 'id only')
      const reply = body.session_token
        ? { after: 12_000, json: { email: 'a@x.com', approved: true, session_token: b64({ e: 'a@x.com', n: 'a', x: now + 14 * 3600_000 }) + '.new' } }
        : { after: 700, json: { _status: 401, error: 'Your Google sign-in has expired. Sign in again.', code: 'TOKEN_REJECTED' } }
      return new Promise((res) => setTimeout(() => res({ status: 200, url: 'https://script.googleusercontent.com/x', text: async () => JSON.stringify(reply.json) }), reply.after))
    })
    let out: any = null
    api.me().then((v: unknown) => (out = { ok: true, v }), (e: unknown) => (out = { ok: false, e }))
    for (let i = 0; i < 400 && !out; i++) await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual(['session+id', 'id only'])   // the premise: they differed
    expect(out.ok).toBe(true)
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })
})
