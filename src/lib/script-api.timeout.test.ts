import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A stalled request must end, and must end as "outcome unknown".
 *
 * On 7 Sep "Checking…" sat for two minutes and the screen with it, because a
 * fetch with no deadline waits for ever. Every call now carries one; a write
 * that hits it is not reported as failed, because the backend may have
 * finished it — the queue asks before assuming.
 */
describe('call() gives up on a stalled request', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_APPS_SCRIPT_URL', 'https://script.google.com/macros/s/test/exec')
    vi.resetModules()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('rejects with TIMEOUT, status 0, retryable and outcome-unknown', async () => {
    // A fetch that never answers but does honour abort, as browsers do.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
      ),
    )
    const mod = await import('./script-api')
    mod.setIdToken('header.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig')

    const pending = mod.call('listingState', { body: {}, timeoutMs: 5_000 })
    const outcome = pending.then(() => 'resolved', (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_100)
    const err = (await outcome) as InstanceType<typeof mod.ScriptError>
    expect(err).toBeInstanceOf(mod.ScriptError)
    expect(err.code).toBe('TIMEOUT')
    expect(err.status).toBe(0)
    expect(err.isRetryable).toBe(true)
    expect(err.isOutcomeUnknown).toBe(true)
    expect(err.message).toMatch(/5s/)
  })

  it('does not fire the deadline on a request that answered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ _status: 200, ok: true }), { status: 200 })),
    )
    const mod = await import('./script-api')
    mod.setIdToken('header.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig')
    const result = await mod.call<{ ok: boolean }>('ping', { anonymous: true, timeoutMs: 1_000 })
    expect(result.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000) // nothing should throw or leak
  })
})

describe('backend session token', () => {
  afterEach(() => vi.unstubAllEnvs())

  function token(expMs: number) {
    const body = btoa(JSON.stringify({ e: 'brienchua@sheldonglobal.com', n: 'Brien', x: expMs }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return body + '.deadbeef'
  }

  it('reads how long a session has left, and treats junk as expired', async () => {
    const mod = await import('./script-api')
    const now = 1_700_000_000_000
    expect(mod.sessionMsLeft(token(now + 60_000), now)).toBe(60_000)
    expect(mod.sessionMsLeft(token(now - 1), now)).toBe(0)
    expect(mod.sessionMsLeft('not-a-token', now)).toBe(0)
    expect(mod.sessionMsLeft(null, now)).toBe(0)
  })

  it('a live session counts as a credential even with no Google token', async () => {
    const mod = await import('./script-api')
    mod.setIdToken(null)
    mod.setSessionToken(token(Date.now() + 3_600_000))
    expect(mod.hasCredential()).toBe(true)
    mod.setSessionToken(token(Date.now() - 1))
    expect(mod.hasCredential()).toBe(false)
    mod.setSessionToken(null)
  })
})
