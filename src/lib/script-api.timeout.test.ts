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

/**
 * A 401 is not one thing, and treating it as one signed people out mid-stream.
 *
 * Brien's Orders screen, 7 Sep: "Sign in with Google to continue. [NO_TOKEN]"
 * over a summary that had loaded and a sync that had just succeeded. He was
 * signed in the whole time. NO_TOKEN is only reachable when the request
 * carried no credential at all, and this client refuses to send one without
 * it, so the body was lost in the redirect Apps Script answers with. The
 * retry built for exactly that was unreachable, because a JSON reply returns
 * before it and a 401 is valid JSON.
 */
describe('a 401 that means the request lost its credential', () => {
  const live = () => 'header.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig'

  beforeEach(() => {
    vi.stubEnv('VITE_APPS_SCRIPT_URL', 'https://script.google.com/macros/s/test/exec')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('retries as a GET carrying the credential, and succeeds', async () => {
    const seen: { method: string; url: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ method: String(init.method), url })
        // The POST loses its body in the redirect, exactly as observed.
        if (init.method === 'POST') {
          return new Response(JSON.stringify({ _status: 401, error: 'Sign in with Google to continue.', code: 'NO_TOKEN' }), { status: 200 })
        }
        return new Response(JSON.stringify({ _status: 200, total_orders: 17 }), { status: 200 })
      }),
    )
    const mod = await import('./script-api')
    mod.setIdToken(live())

    const out = await mod.call<{ total_orders: number }>('orderSummary', { body: { shop_id: 'HZ' } })
    expect(out.total_orders).toBe(17)
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET'])
    // The credential must actually be on the retry, or it is the same request.
    expect(seen[1]!.url).toContain('id_token=')
  })

  it('when both legs lose it, does not tell a signed-in person to sign in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ _status: 401, error: 'Sign in with Google to continue.', code: 'NO_TOKEN' }), { status: 200 }),
      ),
    )
    const mod = await import('./script-api')
    mod.setIdToken(live())

    const err = await mod.call('orderSummary', { body: {} }).then(() => null, (e: unknown) => e) as InstanceType<typeof mod.ScriptError>
    expect(err.code).toBe('CREDENTIAL_LOST_IN_TRANSIT')
    expect(err.message).not.toMatch(/Sign in with Google/)
    expect(err.message).toMatch(/orderSummary/)
    expect(err.message).toMatch(/still good/)
    // And it must NOT be read as a reason to throw the session away.
    expect(err.isCredentialDead).toBe(false)
  })

  it('a genuinely dead session is still a reason to sign out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ _status: 401, error: 'Your sign-in has expired.', code: 'SESSION_EXPIRED' }), { status: 200 }),
      ),
    )
    const mod = await import('./script-api')
    mod.setIdToken(live())
    const err = await mod.call('orderSummary', { body: {} }).then(() => null, (e: unknown) => e) as InstanceType<typeof mod.ScriptError>
    expect(err.code).toBe('SESSION_EXPIRED')
    expect(err.isCredentialDead).toBe(true)
  })

  it('a timeout is never a reason to sign out', async () => {
    // The bug behind "the app times out after a while and forces us to log in
    // again": one slow request on factory wifi discarded a good 14-hour
    // session, because the bootstrap treated every failure as a dead session.
    const mod = await import('./script-api')
    const timeout = new mod.ScriptError(0, 'Timed out', 'TIMEOUT')
    expect(timeout.isCredentialDead).toBe(false)
    expect(timeout.isAuthError).toBe(false)
    const unreachable = new mod.ScriptError(401, 'Could not reach Google', 'GOOGLE_UNREACHABLE')
    expect(unreachable.isCredentialDead).toBe(false)
    const misconfigured = new mod.ScriptError(401, 'no client id', 'BACKEND_NOT_CONFIGURED')
    expect(misconfigured.isCredentialDead).toBe(false)
  })
})

/**
 * A message that overstates what happened is still a wrong message.
 *
 * Both of these were introduced while fixing wrong messages, which is exactly
 * how they get in: the fix is written for the case in front of you and asserts
 * something about a case you did not have.
 */
describe('the wording matches what actually happened', () => {
  const live = () => 'header.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig'

  beforeEach(() => {
    vi.stubEnv('VITE_APPS_SCRIPT_URL', 'https://script.google.com/macros/s/test/exec')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /**
   * A payload too big for a URL is retried as a POST, not abandoned.
   *
   * This used to assert the opposite — that a pushSku got ONE attempt and a
   * message saying so. That was the behaviour Brien hit on Painting Matters:
   * the one action with no recovery at all, stuck with nothing to do about it.
   * Not fitting in a URL is a reason to choose a different method, not a
   * reason to give up.
   */
  it('retries a too-big payload as a POST and says both attempts were made', async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () =>
      new Response(JSON.stringify({ _status: 401, error: 'Sign in with Google to continue.', code: 'NO_TOKEN' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('./script-api')
    mod.setIdToken(live())
    // A photo is far past the 6000-character URL ceiling, so the retry must be
    // a POST — and the photo must never appear in the query.
    const huge = { photo_base64: 'A'.repeat(8_000) }
    const err = await mod.call('pushSku', { body: huge }).then(() => null, (e: unknown) => e) as InstanceType<typeof mod.ScriptError>

    expect(err.code).toBe('CREDENTIAL_LOST_IN_TRANSIT')
    expect(err.message).toMatch(/both attempts/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' })
    expect(String(fetchMock.mock.calls[1]![0]).length).toBeLessThan(2_000)
  })

  it('tells a read it is safe to try again, and a write that it may have landed', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
      ),
    )
    const mod = await import('./script-api')
    mod.setIdToken(live())

    const read = mod.call('orderSummary', { body: {}, timeoutMs: 1_000 }).then(() => null, (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_100)
    const readErr = (await read) as InstanceType<typeof mod.ScriptError>
    expect(readErr.code).toBe('TIMEOUT')
    // A read changes nothing, so there is nothing to go and check.
    expect(readErr.message).toMatch(/Nothing was changed/)
    expect(readErr.message).not.toMatch(/may still have gone through/)
    expect(readErr.message).toMatch(/orderSummary/)

    const write = mod.call('pushSku', { body: {}, timeoutMs: 1_000 }).then(() => null, (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_100)
    const writeErr = (await write) as InstanceType<typeof mod.ScriptError>
    expect(writeErr.message).toMatch(/may still have gone through/)
    expect(writeErr.isOutcomeUnknown).toBe(true)
    vi.useRealTimers()
  })
})

/**
 * A 404 from the content host must not be reported as a sharing problem.
 *
 * Apps Script answers by redirecting to a one-time reply on
 * script.googleusercontent.com. A 404 there means the execution produced no
 * reply — the six-minute limit, or a crash. An unshared or missing deployment
 * is refused earlier, at script.google.com, before a content URL exists.
 *
 * On 15 Sep this told Brien the deployment was "probably not published to
 * Anyone" while `ping` was answering 200 anonymously in two seconds, sending
 * him to check something that was fine.
 */
describe('a page instead of data', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_APPS_SCRIPT_URL', 'https://script.google.com/macros/s/test/exec')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /**
   * `response.url` is what the diagnosis reads, and a hand-built Response has
   * an empty one — which sends every case down the generic branch. The first
   * version of this test passed that way without ever reaching the code it
   * claimed to cover, so the URL is set explicitly and the assertions name the
   * wording rather than only the code.
   */
  async function failWith(url: string, status: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        const res = new Response('<!doctype html><title>Error</title>', {
          status,
          headers: { 'content-type': 'text/html' },
        })
        Object.defineProperty(res, 'url', { value: url })
        return Promise.resolve(res)
      }),
    )
    const mod = await import('./script-api')
    mod.setIdToken('h.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.s')
    const err = (await mod
      .call('exportOrders', { body: {}, timeoutMs: 1_000 })
      .then(() => null, (e: unknown) => e)) as InstanceType<typeof mod.ScriptError>
    return err
  }

  it('reads a 404 from the content host as a job that never finished', async () => {
    const err = await failWith('https://script.googleusercontent.com/macros/echo?k=1', 404)
    expect(err.code).toBe('NOT_JSON')
    expect(err.message).toMatch(/six-minute limit/)
    expect(err.message).toMatch(/check before repeating it/)
    // It must NOT send anyone to look at the deployment.
    expect(err.message).not.toMatch(/published/)
    // A long job may have written part of its work.
    expect(err.isOutcomeUnknown).toBe(true)
  })

  it('still names the deployment for a 403 at the script host', async () => {
    // The other half: a real sharing problem must keep the advice that fits it,
    // or the fix above would have removed a useful message instead of a wrong one.
    const err = await failWith('https://script.google.com/macros/s/test/exec', 403)
    expect(err.code).toBe('NOT_JSON')
    expect(err.message).toMatch(/published/)
    expect(err.message).toMatch(/403/)
  })
})
