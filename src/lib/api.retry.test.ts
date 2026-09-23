import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retryRead, LIGHT_READ, HEAVY_READ, type ReadPlan } from './api'
import { ScriptError, setIdToken, setSessionToken } from './script-api'

/**
 * The reads that gate the app must survive a slow Apps Script.
 *
 * Measured against the live deployment, `ping` — one statement, no Sheet, no
 * network — answers in 1.5-2s nearly every time and draws a spike of 11-31s
 * now and then, independently per request. `whoami` has also been seen
 * uniformly slow, over 40s. The client's defence has to handle BOTH, and the
 * first attempt at one (abandon at 8s, start again) handled the spike and broke
 * the uniformly slow case outright. These pin all of it.
 */
const timeout = () => new ScriptError(0, 'no reply', 'TIMEOUT')

/** A read whose Nth call answers after a delay, or fails. Records each call's deadline. */
function scripted(steps: Array<{ after: number; ok?: unknown; fail?: unknown }>) {
  const deadlines: number[] = []
  let n = 0
  const read = vi.fn((ms: number) => {
    deadlines.push(ms)
    const step = steps[Math.min(n, steps.length - 1)]!
    n++
    return new Promise((resolve, reject) => {
      setTimeout(() => (step.fail !== undefined ? reject(step.fail) : resolve(step.ok)), step.after)
    })
  })
  return { read, deadlines }
}

/** Run `p` on the fake clock and report what it settled to and WHEN. */
async function timed<T>(p: Promise<T>, maxMs = 200_000) {
  const t0 = Date.now()
  let out: { ok: boolean; v?: unknown; e?: unknown; at: number } | null = null
  p.then(
    (v) => (out = { ok: true, v, at: Date.now() - t0 }),
    (e: unknown) => (out = { ok: false, e, at: Date.now() - t0 }),
  )
  for (let spent = 0; spent < maxMs && !out; spent += 250) await vi.advanceTimersByTimeAsync(250)
  return out!
}

describe('retryRead', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a healthy read is one request, answered at once', async () => {
    const { read } = scripted([{ after: 2_000, ok: 'ok' }])
    const r = await timed(retryRead(read))
    expect(r.v).toBe('ok')
    expect(read).toHaveBeenCalledTimes(1)
  })

  /**
   * The spike. The first request hangs, as a cold start does; a fresh one
   * lands at once. Waiting it out used to cost the full 25s.
   */
  it('a spike is rescued by the hedge, in about eight seconds', async () => {
    const { read } = scripted([{ after: 60_000, fail: timeout() }, { after: 500, ok: 'fresh' }])
    const r = await timed(retryRead(read))
    expect(r.v).toBe('fresh')
    expect(r.at).toBeLessThan(10_000)
    expect(r.at).toBeGreaterThanOrEqual(LIGHT_READ.hedgeMs)
  })

  /**
   * The case abandon-and-retry broke. Every reply takes twenty seconds. The
   * first request must be allowed to land, not thrown away at eight.
   */
  it('a uniformly slow backend still answers, because nothing is abandoned', async () => {
    const { read } = scripted([{ after: 20_000, ok: 'slow but fine' }])
    const r = await timed(retryRead(read))
    expect(r.ok).toBe(true)
    expect(r.v).toBe('slow but fine')
    expect(r.at).toBeLessThan(21_000)
  })

  it('a fast failure sends the hedge at once rather than waiting for it', async () => {
    const { read } = scripted([
      { after: 1_000, fail: new ScriptError(502, 'bad gateway', 'NOT_JSON') },
      { after: 500, ok: 'ok' },
    ])
    const r = await timed(retryRead(read))
    expect(r.v).toBe('ok')
    // 1s to fail + 0.5s to succeed — not 8s for the hedge timer, and not
    // the 1s pause a whole new attempt would cost either.
    expect(r.at).toBeLessThan(2_000)
  })

  it('does not retry a 401, and surfaces it immediately', async () => {
    const { read } = scripted([{ after: 100, fail: new ScriptError(401, 'expired', 'SESSION_EXPIRED') }])
    const r = await timed(retryRead(read))
    expect(r.ok).toBe(false)
    expect((r.e as ScriptError).code).toBe('SESSION_EXPIRED')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 403, which is the allowlist and not a transport fault', async () => {
    const { read } = scripted([{ after: 100, fail: new ScriptError(403, 'pending', 'AWAITING_APPROVAL') }])
    const r = await timed(retryRead(read))
    expect((r.e as ScriptError).code).toBe('AWAITING_APPROVAL')
    expect(read).toHaveBeenCalledTimes(1)
  })

  /**
   * Several 401s describe the trip, not the person. One of those on the hedge
   * used to fail a read the original request was about to answer.
   */
  it.each(['CREDENTIAL_LOST_IN_TRANSIT', 'GOOGLE_UNREACHABLE'])(
    'a %s on the hedge does not throw away the original, which answers',
    async (code) => {
      const { read } = scripted([
        { after: 12_000, ok: 'original' },
        { after: 500, fail: new ScriptError(401, 'transient', code) },
      ])
      const r = await timed(retryRead(read))
      expect(r.ok).toBe(true)
      expect(r.v).toBe('original')
      expect(r.at).toBeLessThan(13_000)
    },
  )

  it('a verdict on the hedge is final at once, not waited on', async () => {
    // An expired session does not become valid by waiting for a stuck twin;
    // waiting only makes the person hear it later.
    const { read } = scripted([
      { after: 60_000, fail: timeout() },
      { after: 100, fail: new ScriptError(401, 'expired', 'SESSION_EXPIRED') },
    ])
    const r = await timed(retryRead(read))
    expect((r.e as ScriptError).code).toBe('SESSION_EXPIRED')
    expect(r.at).toBeLessThan(10_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a verdict on one credential does not end a twin sent with another', async () => {
    // The session was dropped from the hedge in its last minute, so the hedge
    // went with only a stale Google token and was refused. The original,
    // which carried the session, is about to answer — and renew it.
    setIdToken('google-token-a')
    const { read } = scripted([
      { after: 12_000, ok: 'renewed' },
      { after: 700, fail: new ScriptError(401, 'expired', 'TOKEN_REJECTED') },
    ])
    const p = retryRead(read)
    setTimeout(() => setIdToken('google-token-b'), 4_000)   // differs by the time the hedge goes
    const r = await timed(p)
    setIdToken(null)
    expect(r.ok).toBe(true)
    expect(r.v).toBe('renewed')
  })

  it('a refusal of the PERSON is final at once, even after a token renewal', async () => {
    // Blocked is blocked, whichever token asked. Waiting for the stuck twin
    // only made a blocked person hear it 16s later.
    setIdToken('google-token-a')
    const { read } = scripted([
      { after: 9_000, fail: new ScriptError(403, 'blocked', 'ACCOUNT_BLOCKED') },
      { after: 60_000, fail: timeout() },
    ])
    const p = retryRead(read)
    setTimeout(() => setIdToken('google-token-b'), 4_000)
    const r = await timed(p)
    setIdToken(null)
    expect((r.e as ScriptError).code).toBe('ACCOUNT_BLOCKED')
    expect(r.at).toBeLessThan(10_000)
  })

  it('a refused request that carried MORE than its twin is final at once', async () => {
    // The original carried session + token and was refused; the hedge carries
    // only the token. It cannot do better, so nobody waits for it.
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    setSessionToken(b64({ e: 'a@x.com', n: 'a', x: Date.now() + 65_000 }) + '.sig')   // drops off at 5s
    setIdToken('google-token-a')
    const { read } = scripted([
      { after: 9_000, fail: new ScriptError(401, 'expired', 'TOKEN_REJECTED') },
      { after: 60_000, fail: timeout() },
    ])
    const r = await timed(retryRead(read))
    setSessionToken(null)
    setIdToken(null)
    expect((r.e as ScriptError).code).toBe('TOKEN_REJECTED')
    expect(r.at).toBeLessThan(10_000)
  })

  it('a trip refusal is reported if its twin fails too, and is not retried', async () => {
    const { read } = scripted([
      { after: 12_000, fail: timeout() },
      { after: 100, fail: new ScriptError(401, 'lost', 'CREDENTIAL_LOST_IN_TRANSIT') },
    ])
    const r = await timed(retryRead(read))
    expect((r.e as ScriptError).code).toBe('CREDENTIAL_LOST_IN_TRANSIT')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a refusal on the only request in flight is final at once', async () => {
    const { read } = scripted([{ after: 100, fail: new ScriptError(401, 'expired', 'SESSION_EXPIRED') }])
    const r = await timed(retryRead(read))
    expect(r.at).toBeLessThan(1_000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('after a refusal no hedge is sent', async () => {
    // The first request is refused before the hedge is due: asking again
    // cannot change a verdict on the credential.
    const { read } = scripted([{ after: 3_000, fail: new ScriptError(403, 'pending', 'AWAITING_APPROVAL') }])
    await timed(retryRead(read))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('each request is given the time the plan says', async () => {
    // Pinned because the deadlines are the whole promise of the table above:
    // a mutant with a 1s budget passed every other test here.
    const { read, deadlines } = scripted([{ after: 60_000, fail: timeout() }, { after: 500, ok: 'fresh' }])
    await timed(retryRead(read))
    expect(deadlines[0]).toBe(LIGHT_READ.deadlineMs)
    expect(deadlines[1]).toBe(LIGHT_READ.deadlineMs - LIGHT_READ.hedgeMs)
  })

  it('a fast failure relaunches with the full budget, not the hedge remainder', async () => {
    const { read, deadlines } = scripted([
      { after: 1_000, fail: new ScriptError(502, 'bad gateway', 'NOT_JSON') },
      { after: 500, ok: 'ok' },
    ])
    await timed(retryRead(read))
    expect(deadlines[1]).toBe(LIGHT_READ.deadlineMs)
  })

  it('no hedge is sent once the first request has answered', async () => {
    const { read } = scripted([{ after: 5_000, ok: 'ok' }])
    await timed(retryRead(read))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a hedge in flight does not end the attempt when the original fails', async () => {
    // Original fails at 10s (after the hedge went out at 8s); the hedge lands at 14s.
    const { read } = scripted([{ after: 10_000, fail: timeout() }, { after: 6_000, ok: 'hedge' }])
    const r = await timed(retryRead(read))
    expect(r.v).toBe('hedge')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a dead backend gives up well inside the old 78 seconds', async () => {
    const { read } = scripted([{ after: 90_000, fail: timeout() }])
    // Each request times out at its own deadline, as `call` does.
    const deadlined = vi.fn((ms: number) =>
      new Promise((_, reject) => setTimeout(() => reject(timeout()), ms)),
    )
    void read
    const r = await timed(retryRead(deadlined))
    expect(r.ok).toBe(false)
    expect(r.at).toBeLessThan(78_000)
    // And it really waited: two full attempts plus the pause between them.
    expect(r.at).toBeGreaterThanOrEqual(2 * LIGHT_READ.deadlineMs)
  })

  it('the heavy read hedges later, so honest work is not doubled', () => {
    expect(HEAVY_READ.hedgeMs).toBeGreaterThanOrEqual(20_000)
    expect(HEAVY_READ.hedgeMs).toBeGreaterThan(LIGHT_READ.hedgeMs)
  })

  it('a heavy read that answers before its hedge is one request', async () => {
    const { read } = scripted([{ after: 12_000, ok: 'state' }])
    const r = await timed(retryRead(read, HEAVY_READ as ReadPlan))
    expect(r.v).toBe('state')
    expect(read).toHaveBeenCalledTimes(1)
  })
})
