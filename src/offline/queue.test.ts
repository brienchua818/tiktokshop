import { describe, it, expect } from 'vitest'
import {
  dueForPush,
  needsAttention,
  pendingCount,
  retryDelayMs,
  afterAttempt,
  MAX_AUTO_ATTEMPTS,
  type QueuedDraft,
} from './queue'

/**
 * These rules decide whether a livestream's SKUs survive a dropped connection,
 * and whether a retry can duplicate a product. Worth testing properly.
 */

let seq = 0
function draft(partial: Partial<QueuedDraft> = {}): QueuedDraft {
  seq += 1
  return {
    draft_id: `d${seq}`,
    listing_id: 'L1',
    shop_id: 'S1',
    identifier: `A${seq}`,
    title: 'Ceramic Serving Bowl White Glaze',
    variant_name: null,
    price: '18.90',
    stock: 12,
    weight_kg: '0.8',
    dimensions: null,
    include_dims_in_title: false,
    image_preview: null,
    tiktok_image_uri: null,
    status: 'queued',
    error: null,
    idempotency_key: `key-${seq}`,
    created_at: `2026-09-02T10:00:${String(seq).padStart(2, '0')}Z`,
    attempts: 0,
    retryAfter: 0,
    settled: false,
    ...partial,
  }
}

const NOW = 1_000_000

describe('dueForPush', () => {
  it('picks up a freshly queued item', () => {
    const d = draft()
    expect(dueForPush([d], NOW).map((x) => x.draft_id)).toEqual([d.draft_id])
  })

  it('never pushes a settled item again, whatever its status says', () => {
    // The guard against duplicating a product after a confusing reconnect.
    expect(dueForPush([draft({ settled: true, status: 'queued' })], NOW)).toEqual([])
  })

  it('never re-pushes something already pushed', () => {
    expect(dueForPush([draft({ status: 'pushed' })], NOW)).toEqual([])
  })

  it('skips an item already uploading, so a reconnect cannot double-push', () => {
    // Without this, a reconnect firing mid-push starts a second attempt for
    // the same SKU.
    expect(dueForPush([draft({ status: 'uploading' })], NOW)).toEqual([])
  })

  it('retries a failed item once its backoff has elapsed', () => {
    const d = draft({ status: 'failed', attempts: 1, retryAfter: NOW - 1 })
    expect(dueForPush([d], NOW)).toHaveLength(1)
  })

  it('leaves a failed item alone while its backoff is still running', () => {
    const d = draft({ status: 'failed', attempts: 1, retryAfter: NOW + 5000 })
    expect(dueForPush([d], NOW)).toEqual([])
  })

  it('stops retrying after the attempt limit and waits for a person', () => {
    const d = draft({ status: 'failed', attempts: MAX_AUTO_ATTEMPTS, retryAfter: 0 })
    expect(dueForPush([d], NOW)).toEqual([])
  })

  it('pushes oldest first, preserving the A1, A2, A3 order', () => {
    const third = draft({ draft_id: 'c', created_at: '2026-09-02T10:00:30Z' })
    const first = draft({ draft_id: 'a', created_at: '2026-09-02T10:00:10Z' })
    const second = draft({ draft_id: 'b', created_at: '2026-09-02T10:00:20Z' })
    expect(dueForPush([third, first, second], NOW).map((d) => d.draft_id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the array it is given', () => {
    const items = [
      draft({ draft_id: 'z', created_at: '2026-09-02T10:00:30Z' }),
      draft({ draft_id: 'y', created_at: '2026-09-02T10:00:10Z' }),
    ]
    dueForPush(items, NOW)
    expect(items.map((d) => d.draft_id)).toEqual(['z', 'y'])
  })
})

describe('afterAttempt', () => {
  it('settles an item on success so it can never push twice', () => {
    const next = afterAttempt(draft(), { ok: true, tiktokProductId: 'p1' }, NOW)
    expect(next.status).toBe('pushed')
    expect(next.settled).toBe(true)
    expect(next.error).toBeNull()
    expect(dueForPush([next], NOW + 1_000_000)).toEqual([])
  })

  it('schedules a retry for a retryable failure', () => {
    const next = afterAttempt(
      draft(),
      { ok: false, error: 'too many requests', retryable: true },
      NOW,
    )
    expect(next.status).toBe('failed')
    expect(next.attempts).toBe(1)
    expect(next.retryAfter).toBeGreaterThan(NOW)
    expect(next.settled).toBe(false)
  })

  it('parks a non-retryable rejection immediately rather than burning allowance', () => {
    const next = afterAttempt(
      draft(),
      { ok: false, error: 'The package weight of the product can not be zero.', retryable: false },
      NOW,
    )
    expect(next.retryAfter).toBe(Number.MAX_SAFE_INTEGER)
    expect(dueForPush([next], NOW + 10_000_000)).toEqual([])
  })

  it('keeps TikTok’s own wording, not a generic message', () => {
    const detail = "You haven't set the return warehouse for your shop."
    expect(afterAttempt(draft(), { ok: false, error: detail, retryable: false }, NOW).error).toBe(
      detail,
    )
  })

  it('counts attempts so the limit is reachable', () => {
    let d = draft()
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i += 1) {
      d = afterAttempt(d, { ok: false, error: 'network', retryable: true }, NOW)
    }
    expect(d.attempts).toBe(MAX_AUTO_ATTEMPTS)
    expect(dueForPush([d], NOW + 10_000_000)).toEqual([])
    expect(needsAttention([d])).toHaveLength(1)
  })
})

describe('retryDelayMs', () => {
  it('grows with each attempt', () => {
    expect(retryDelayMs(1)).toBe(2000)
    expect(retryDelayMs(2)).toBe(4000)
    expect(retryDelayMs(3)).toBe(8000)
  })

  it('caps at five minutes, since a livestream is finite', () => {
    expect(retryDelayMs(30)).toBe(300_000)
  })

  it('handles a zero or negative attempt count without going negative', () => {
    expect(retryDelayMs(0)).toBeGreaterThan(0)
  })
})

describe('needsAttention', () => {
  it('lists only items out of automatic attempts', () => {
    const stuck = draft({ status: 'failed', attempts: MAX_AUTO_ATTEMPTS })
    const retrying = draft({ status: 'failed', attempts: 1 })
    const fine = draft({ status: 'pushed', settled: true })
    expect(needsAttention([stuck, retrying, fine]).map((d) => d.draft_id)).toEqual([stuck.draft_id])
  })
})

describe('pendingCount', () => {
  it('counts unpushed work for the waiting indicator', () => {
    expect(
      pendingCount([
        draft({ status: 'queued' }),
        draft({ status: 'failed' }),
        draft({ status: 'pushed', settled: true }),
      ]),
    ).toBe(2)
  })

  it('is zero when everything has landed', () => {
    expect(pendingCount([draft({ status: 'pushed', settled: true })])).toBe(0)
  })
})
