// @vitest-environment happy-dom
/**
 * The sender's own guarantees, against a queue held in memory.
 *
 * The stream tests (runner.stream.test.tsx) drive the real screen; these pin
 * the rules the sender has to keep whatever drives it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { drainQueue, isDraining, kickQueue, onQueueChange, startQueueRunner, type RunnerDeps } from './runner'
import { afterAttempt, type QueuedDraft } from './queue'

function draft(i: number, over: Partial<QueuedDraft> = {}): QueuedDraft {
  return {
    draft_id: `d${i}`, listing_id: 'L1', stream_id: 'L1', continues_from: null, shop_id: 'HZ',
    identifier: `A${i}`, title: 't', variant_name: null, price: '1', stock: 1, weight_kg: '1',
    dimensions: null, include_dims_in_title: false, image_preview: null, tiktok_image_uri: null,
    tiktok_attribute_image_uri: null, status: 'queued', error: null, idempotency_key: `k${i}`,
    created_at: `2026-10-17T03:00:${String(i).padStart(2, '0')}Z`, attempts: 0, retryAfter: 0, settled: false,
    ...over,
  }
}

/** A queue in memory, pushed by a fake that records concurrency. */
function world(rows: QueuedDraft[], pushMs = 5) {
  const store = new Map(rows.map((d) => [d.draft_id, d]))
  const state = { inflight: 0, peak: 0, pushed: [] as string[], online: true, now: Date.now(), fail: new Set<string>(), throwOn: new Set<string>() }
  const deps: RunnerDeps = {
    drafts: async () => [...store.values()].map((d) => ({ ...d })),
    revive: async () => 0,
    online: () => state.online,
    now: () => state.now,
    push: async (d) => {
      if (state.throwOn.has(d.identifier)) { state.throwOn.delete(d.identifier); throw new Error('IndexedDB write failed') }
      store.set(d.draft_id, { ...store.get(d.draft_id)!, status: 'uploading', uploading_at: state.now })
      state.inflight++
      state.peak = Math.max(state.peak, state.inflight)
      await new Promise((r) => setTimeout(r, pushMs))
      state.inflight--
      const cur = store.get(d.draft_id)!
      if (state.fail.has(d.identifier)) {
        state.fail.delete(d.identifier)
        store.set(d.draft_id, afterAttempt(cur, { ok: false, error: 'Load failed', retryable: true }, state.now))
        return
      }
      state.pushed.push(d.identifier)
      store.set(d.draft_id, afterAttempt(cur, { ok: true, tiktokProductId: 'L1', listingId: 'L1' }, state.now))
    },
  }
  return { store, state, deps }
}

const idle = async () => { for (let i = 0; i < 400 && isDraining(); i++) await new Promise((r) => setTimeout(r, 5)) }
afterEach(async () => { await idle(); vi.useRealTimers() })

describe('the sender', () => {
  it('pushes every due SKU, oldest first, one at a time per listing', async () => {
    const w = world(Array.from({ length: 12 }, (_, i) => draft(i + 1)))
    await drainQueue(w.deps)
    expect(w.state.pushed).toEqual(Array.from({ length: 12 }, (_, i) => `A${i + 1}`))
    expect(w.state.peak).toBe(1)
  })

  it('a kick during a pass never starts a second push; the pass picks up what was added', async () => {
    const w = world([draft(1), draft(2)], 20)
    const pass = drainQueue(w.deps)
    await new Promise((r) => setTimeout(r, 5))
    w.store.set('d3', draft(3))                       // saved mid-push
    for (let i = 0; i < 5; i++) await drainQueue(w.deps)  // kicks while busy
    await pass
    await idle()
    expect(w.state.pushed).toEqual(['A1', 'A2', 'A3'])
    expect(w.state.peak).toBe(1)
  })

  it('is never left marked busy, even when a push throws', async () => {
    const w = world([draft(1), draft(2)])
    w.state.throwOn.add('A1')
    await expect(drainQueue(w.deps)).rejects.toThrow('IndexedDB write failed')
    expect(isDraining()).toBe(false)
    await drainQueue(w.deps)                          // the next pass still runs
    expect(w.state.pushed).toEqual(['A1', 'A2'])
  })

  it('two listings are pushed side by side in turn, never two on one listing', async () => {
    const rows = [1, 2, 3].map((i) => draft(i)).concat([4, 5].map((i) => draft(i, { listing_id: 'L2', stream_id: 'L2' })))
    const w = world(rows)
    await drainQueue(w.deps)
    expect(w.state.pushed.sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5'])
    expect(w.state.peak).toBe(1)
  })

  it('a SKU for a listing that is not on screen is pushed too, continuation drafts included', async () => {
    const w = world([draft(1, { listing_id: null, stream_id: 'cont-1', continues_from: 'L1' })])
    await drainQueue(w.deps)
    expect(w.state.pushed).toEqual(['A1'])
  })

  it('does nothing while offline, and nothing parked or out of attempts is touched', async () => {
    const w = world([draft(1), draft(2, { status: 'failed', retryAfter: Number.MAX_SAFE_INTEGER, attempts: 1 }), draft(3, { status: 'failed', attempts: 5 })])
    w.state.online = false
    await drainQueue(w.deps)
    expect(w.state.pushed).toEqual([])
    w.state.online = true
    await drainQueue(w.deps)
    expect(w.state.pushed).toEqual(['A1'])
  })

  it('tells the screens when it has pushed, and stays quiet when it has not', async () => {
    const w = world([draft(1)])
    const heard = vi.fn()
    const stop = onQueueChange(heard)
    await drainQueue(w.deps)
    const after = heard.mock.calls.length
    expect(after).toBeGreaterThan(0)
    await drainQueue(w.deps)                          // nothing due
    expect(heard.mock.calls.length).toBe(after)       // no refresh storm
    stop()
  })
})

describe('the heartbeat', () => {
  it('sends a retry when its wait runs out, with nobody touching the phone', async () => {
    const w = world([draft(1)], 1)
    w.state.fail.add('A1')
    const stop = startQueueRunner(w.deps)
    await new Promise((r) => setTimeout(r, 50))
    expect(w.state.pushed).toEqual([])               // first attempt failed, retry due in 5 s
    w.state.now += 5_500                               // the wait runs out
    await new Promise((r) => setTimeout(r, 2_300))    // within one heartbeat
    stop()
    expect(w.state.pushed).toEqual(['A1'])
  }, 10_000)

  it('starts again when the connection comes back', async () => {
    const w = world([draft(1)], 1)
    w.state.online = false
    const stop = startQueueRunner(w.deps)
    await new Promise((r) => setTimeout(r, 20))
    expect(w.state.pushed).toEqual([])
    w.state.online = true
    window.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 50))
    stop()
    expect(w.state.pushed).toEqual(['A1'])
  })

  it('kickQueue never throws, whatever the pass does', async () => {
    const w = world([draft(1)])
    w.state.throwOn.add('A1')
    expect(() => kickQueue(w.deps)).not.toThrow()
    await idle()
    expect(isDraining()).toBe(false)
  })
})

describe('a push that never finishes', () => {
  it('holds the sender no longer than the watchdog; other listings carry on', async () => {
    const w = world([draft(1), draft(2, { listing_id: 'L2', stream_id: 'L2' })], 1)
    const realPush = w.deps.push
    w.deps.push = (d) => (d.identifier === 'A1' ? new Promise<void>(() => {}) : realPush(d))
    w.deps.watchdogMs = 50
    await drainQueue(w.deps)
    expect(isDraining()).toBe(false)
    expect(w.state.pushed).toEqual(['A2'])
  })
})

describe('a read of the queue that never answers', () => {
  it('fails the pass instead of holding the sender; the next pass reads again and pushes', async () => {
    const w = world([draft(1), draft(2)], 1)
    const realDrafts = w.deps.drafts
    let first = true
    w.deps.drafts = () => (first ? ((first = false), new Promise<QueuedDraft[]>(() => {})) : realDrafts())
    w.deps.readDeadlineMs = 50
    await expect(drainQueue(w.deps)).rejects.toThrow(/Reading the queue/)
    expect(isDraining()).toBe(false)
    await drainQueue(w.deps)
    expect(w.state.pushed).toEqual(['A1', 'A2'])
  })

  it('a check for stalled uploads that never answers is skipped, and the pass carries on', async () => {
    const w = world([draft(1)], 1)
    w.deps.revive = () => new Promise<number>(() => {})
    w.deps.readDeadlineMs = 50
    await drainQueue(w.deps)
    expect(isDraining()).toBe(false)
    expect(w.state.pushed).toEqual(['A1'])
  })
})

describe('signing out', () => {
  it('ends the pass after the push in flight; the rest wait for the next person, untouched', async () => {
    const w = world([draft(1), draft(2), draft(3)], 20)
    const stop = startQueueRunner(w.deps)
    await new Promise((r) => setTimeout(r, 5))       // A1 in flight
    stop()                                            // what signing out does
    await idle()
    expect(w.state.pushed).toEqual(['A1'])
    expect([...w.store.values()].map((d) => `${d.identifier}:${d.status}:${d.attempts}`)).toEqual(['A1:pushed:1', 'A2:queued:0', 'A3:queued:0'])
    const again = startQueueRunner(w.deps)           // the next person signs in
    await new Promise((r) => setTimeout(r, 100))
    again()
    await idle()
    expect(w.state.pushed).toEqual(['A1', 'A2', 'A3'])
  })
})

describe('with Web Locks', () => {
  it('a kick while this tab is sending is remembered, not dropped', async () => {
    let held = false
    const locks = {
      request: async (_n: string, _o: unknown, cb: (l: unknown) => unknown) => {
        if (held) return cb(null)
        held = true
        try { return await cb({}) } finally { held = false }
      },
    }
    const nav = navigator as unknown as { locks?: unknown }
    const had = Object.getOwnPropertyDescriptor(nav, 'locks')
    Object.defineProperty(nav, 'locks', { value: locks, configurable: true })
    try {
      const w = world([draft(1)], 5)
      const realDrafts = w.deps.drafts
      let reads = 0
      w.deps.drafts = async () => {
        const rows = await realDrafts()
        // A2 is saved just after the read that finds the queue empty — the
        // last moment before the pass would end. Its kick gets no lock.
        if (++reads === 2) {
          w.store.set('d2', draft(2))
          kickQueue(w.deps)
        }
        return rows
      }
      kickQueue(w.deps)
      await new Promise((r) => setTimeout(r, 50))
      await idle()
      expect(w.state.pushed).toEqual(['A1', 'A2'])
    } finally {
      if (had) Object.defineProperty(nav, 'locks', had)
      else delete nav.locks
    }
  })
})
