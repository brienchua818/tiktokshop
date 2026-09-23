import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retryRead, LIGHT_READ, HEAVY_READ, type ReadPlan } from './api'
import { ScriptError } from './script-api'

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
    // 1s to fail + 0.5s to succeed — not 8s for the hedge timer.
    expect(r.at).toBeLessThan(3_000)
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

  it('a refusal on the hedge is final too, not waited on', async () => {
    const { read } = scripted([
      { after: 60_000, fail: timeout() },
      { after: 100, fail: new ScriptError(401, 'expired', 'SESSION_EXPIRED') },
    ])
    const r = await timed(retryRead(read))
    expect((r.e as ScriptError).code).toBe('SESSION_EXPIRED')
    expect(r.at).toBeLessThan(10_000)
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
