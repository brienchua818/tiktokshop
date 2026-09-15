import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retryRead } from './api'
import { ScriptError } from './script-api'

/**
 * The reads that gate the app must survive a slow Apps Script.
 *
 * Measured against the live deployment on 15 Sep, six consecutive `ping`
 * calls — one statement, no Sheet, no network — returned in 1.1s, 1.2s, 1.9s,
 * 2.3s, 8.0s and 15.6s, and `whoami` twice exceeded 40s. One of those blips on
 * the boot check is what left Brien on a sign-in screen that would not sign
 * him in. Nothing in the backend explains it, so the client's only defence is
 * to ask again — and these tests pin both halves of that: it retries what is
 * worth retrying, and it does NOT retry what is not.
 */
describe('retryRead', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const timeout = () => new ScriptError(0, 'no reply after 25s', 'TIMEOUT')

  /** Drive the fake clock until the promise settles, so the backoff elapses. */
  async function settle<T>(p: Promise<T>): Promise<T | unknown> {
    const outcome = p.then(
      (v) => ({ ok: true, v }),
      (e: unknown) => ({ ok: false, e }),
    )
    await vi.advanceTimersByTimeAsync(10_000)
    const r = (await outcome) as { ok: boolean; v?: T; e?: unknown }
    if (!r.ok) throw r.e
    return r.v as T
  }

  it('calls once when the read succeeds', async () => {
    const read = vi.fn().mockResolvedValue('ok')
    expect(await settle(retryRead(read))).toBe('ok')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('recovers from two timeouts and returns the third answer', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValue('ok')
    expect(await settle(retryRead(read))).toBe('ok')
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('gives up after three attempts and rethrows the last error', async () => {
    const read = vi.fn().mockRejectedValue(timeout())
    await expect(settle(retryRead(read))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('retries a 5xx, which is the backend failing rather than refusing', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new ScriptError(502, 'bad gateway', 'NOT_JSON'))
      .mockResolvedValue('ok')
    expect(await settle(retryRead(read))).toBe('ok')
    expect(read).toHaveBeenCalledTimes(2)
  })

  // The other half. Retrying a refusal cannot change it and only delays
  // telling the person what to do about it — a signed-out phone should reach
  // the sign-in screen at once, not three seconds later.
  it('does not retry a 401, and surfaces it immediately', async () => {
    const read = vi.fn().mockRejectedValue(new ScriptError(401, 'expired', 'SESSION_EXPIRED'))
    await expect(settle(retryRead(read))).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 403, which is the allowlist and not a transport fault', async () => {
    const read = vi.fn().mockRejectedValue(new ScriptError(403, 'pending', 'AWAITING_APPROVAL'))
    await expect(settle(retryRead(read))).rejects.toMatchObject({ code: 'AWAITING_APPROVAL' })
    expect(read).toHaveBeenCalledTimes(1)
  })
})
