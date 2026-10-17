// @vitest-environment happy-dom
/**
 * What one push writes when it fails, on the real queue (fake-indexeddb).
 *
 * The sender retries the moment a wait runs out, so what a failure costs —
 * one of the five automatic attempts, or none — decides whether a Wi-Fi
 * outage or a sign-out leaves the queue moving or parks all of it.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// As in runner.stream.test.tsx: fake-indexeddb's structuredClone turns
// happy-dom's Blob into a plain object; a browser keeps the Blob itself.
vi.hoisted(() => {
  const orig = globalThis.structuredClone
  globalThis.structuredClone = ((v: unknown, o?: StructuredSerializeOptions) =>
    v instanceof Blob ? v : orig(v, o)) as typeof structuredClone
})

const ctl = vi.hoisted(() => ({
  push: null as null | (() => Promise<unknown>),
  state: null as null | (() => Promise<unknown>),
  thumb: null as null | (() => void),
}))

vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      pushDraft: vi.fn(() => ctl.push!()),
      listingState: vi.fn(() => (ctl.state ? ctl.state() : Promise.reject(new real.ApiError(0, 'No connection: Load failed')))),
    },
  }
})
vi.mock('../capture/camera', async (orig) => ({
  ...(await orig<typeof import('../capture/camera')>()),
  toSquareJpeg: async () => {
    ctl.thumb?.()
    throw new Error('no canvas in test')
  },
}))

import { ApiError } from '../lib/api'
import { pushOne, UNREACHED_RETRY_MS } from './push'
import {
  allDrafts, enqueue, getDraft, isStuck, MAX_AUTO_ATTEMPTS, PARKED, resetDevice, revivable, updateDraft,
  type QueuedDraft,
} from './queue'
import type { Draft } from '../types'

let n = 0
function draft(): Draft {
  n++
  return {
    draft_id: `p${n}`, listing_id: 'L1', stream_id: 'L1', continues_from: null, shop_id: 'HZ',
    identifier: `A${n}`, title: 'HOUZE live', variant_name: 'v', price: '9.90', stock: 1, weight_kg: '1',
    dimensions: null, include_dims_in_title: false, image_preview: null, tiktok_image_uri: null,
    tiktok_attribute_image_uri: null, status: 'queued', error: null, idempotency_key: `k${n}`,
    created_at: new Date(Date.UTC(2026, 9, 17, 3, 0, n)).toISOString(),
  }
}
const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
const row = async (id: string) => (await getDraft(id)) as QueuedDraft

beforeEach(async () => {
  for (const d of await allDrafts()) await updateDraft(d.draft_id, { status: 'pushed' })
  await resetDevice()
  ctl.push = null
  ctl.state = null
  ctl.thumb = null
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('a failed push', () => {
  it('that reached nobody costs none of the five attempts, however long the outage', async () => {
    const q = await enqueue(draft(), photo())
    ctl.push = () => Promise.reject(new ApiError(0, 'No connection: Load failed'))
    for (let i = 0; i < MAX_AUTO_ATTEMPTS * 3; i++) {
      const before = Date.now()
      await pushOne(await row(q.draft_id))
      const r = await row(q.draft_id)
      expect(r.attempts).toBe(0)
      expect(r.status).toBe('failed')
      expect(r.error).toMatch(/No connection/)
      expect(r.retryAfter).toBeGreaterThanOrEqual(before + UNREACHED_RETRY_MS)
    }
    expect(isStuck(await row(q.draft_id))).toBe(false)
  })

  it('that timed out still counts: it may have reached TikTok', async () => {
    const q = await enqueue(draft(), photo())
    ctl.push = () => Promise.reject(new ApiError(0, 'gave no reply after 120s', 'TIMEOUT'))
    await pushOne(await row(q.draft_id))
    expect((await row(q.draft_id)).attempts).toBe(1)
  })

  it('because nobody is signed in waits, says why, and is neither charged nor parked', async () => {
    const q = await enqueue(draft(), photo())
    ctl.push = () => Promise.reject(new ApiError(401, 'Sign in with Google to continue.', 'NO_CREDENTIAL_ON_DEVICE'))
    await pushOne(await row(q.draft_id))
    const r = await row(q.draft_id)
    expect(r.attempts).toBe(0)
    expect(r.retryAfter).toBeLessThan(PARKED)
    expect(r.error).toMatch(/Sign in/)
    expect(isStuck(r)).toBe(false)
  })

  it('never turns a SKU another attempt has put live back into a failed one', async () => {
    const q = await enqueue(draft(), photo())
    ctl.push = async () => {
      // The watchdog gave up on this push; a second one went through meanwhile.
      await updateDraft(q.draft_id, { status: 'pushed', settled: true, pushed_at: new Date().toISOString() })
      throw new ApiError(503, 'Service unavailable')
    }
    await pushOne(await row(q.draft_id))
    const r = await row(q.draft_id)
    expect(r.status).toBe('pushed')
    expect(r.settled).toBe(true)
  })
})

describe('an upload the app died during', () => {
  it('on its fifth attempt asks for a person, instead of sitting under "waiting" for good', async () => {
    const { reviveOrphanedUploads } = await import('./queue')
    const q = await enqueue(draft(), photo())
    await updateDraft(q.draft_id, { status: 'uploading', uploading_at: 1, attempts: MAX_AUTO_ATTEMPTS - 1 })
    await reviveOrphanedUploads()
    const r = await row(q.draft_id)
    expect(r.attempts).toBe(MAX_AUTO_ATTEMPTS)
    expect(isStuck(r)).toBe(true)
  })

  it('before its fifth goes back in the queue', async () => {
    const { reviveOrphanedUploads } = await import('./queue')
    const q = await enqueue(draft(), photo())
    await updateDraft(q.draft_id, { status: 'uploading', uploading_at: 1, attempts: 1 })
    await reviveOrphanedUploads()
    const r = await row(q.draft_id)
    expect([r.status, r.attempts, isStuck(r)]).toEqual(['queued', 2, false])
  })
})

describe('a long push', () => {
  it('keeps its claim through every long step, so it is never revived while still running', async () => {
    const t0 = Date.parse('2026-10-17T03:00:00Z')
    let clock = t0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const q = await enqueue(draft(), photo())
    const seen: number[] = []
    ctl.thumb = () => { clock = t0 + 100_000 }            // a slow photo on the phone
    ctl.push = async () => {
      seen.push(revivable(await allDrafts(), t0 + 200_000).length)
      clock = t0 + 240_000                                 // then the 120 s deadline
      throw new ApiError(0, 'gave no reply after 120s', 'TIMEOUT')
    }
    ctl.state = async () => {
      seen.push(revivable(await allDrafts(), t0 + 300_000).length)
      return { variants: [], checked_at: new Date(clock).toISOString() }
    }
    await pushOne(await row(q.draft_id))
    expect(seen).toEqual([0, 0])
  })
})
