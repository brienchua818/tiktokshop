// @vitest-environment happy-dom
/**
 * The queue keeps pushing through a live stream.
 *
 * Brien, 17 Oct: "it keeps showing it as queued, and shows 'X waiting' ...
 * but nothing happens ... usually after we list 8-10 variations." The sender
 * was a React effect on the listing screen; a save or a refresh landing while
 * a push was in flight tore it down with its `working` flag stuck on. These
 * are the investigation's reproductions — every one stopped the old queue
 * (after 1, 5, 6 or 8 SKUs) — and every one must now push everything.
 *
 * Real: DraftQueue, the offline queue (src/offline/queue.ts) on a real
 * IndexedDB implementation (fake-indexeddb), React 19's real scheduler (NOT
 * act(): IS_REACT_ACT_ENVIRONMENT=false so renders/effects are scheduled the
 * way they are on a phone). Mocked: the network (api.*) and the canvas
 * thumbnail (best-effort, wrapped in try/catch in pushOne).
 *
 * Time is scaled: 1 ms here = SCALE ms on the phone.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useCallback, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

// fake-indexeddb clones values with the global structuredClone, which turns
// happy-dom's Blob into a plain object. A real browser stores the Blob itself;
// Blobs are immutable, so handing back the same instance is equivalent.
vi.hoisted(() => {
  const orig = globalThis.structuredClone
  globalThis.structuredClone = ((v: unknown, o?: StructuredSerializeOptions) =>
    v instanceof Blob ? v : orig(v, o)) as typeof structuredClone
})

const ctl = vi.hoisted(() => ({
  pushMs: 150,
  stateMs: 100,
  inflight: 0,
  peak: 0,
  pushes: [] as string[],
  starts: [] as { id: string; at: number }[],
  landed: [] as string[],
  failOnce: new Set<string>(),
  failKind: 'busy' as 'busy' | 'network',
  t0: 0,
  log: [] as string[],
}))

vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const variant = (id: string) => ({
    identifier: id, variant: id, price: '1', status: 'pushed', external: false,
    tiktok_sku_id: 'S' + id, image_url: '', created_at: new Date().toISOString(), created_by: 't',
    state: 'reviewing', buyable: false, on_tiktok: false, removed: false, stock_available: null,
  })
  return {
    ...real,
    api: {
      ...real.api,
      pushDraft: vi.fn(async (body: { identifier: string }) => {
        ctl.inflight++
        ctl.peak = Math.max(ctl.peak, ctl.inflight)
        ctl.starts.push({ id: body.identifier, at: Date.now() - ctl.t0 })
        ctl.log.push(`${Date.now() - ctl.t0}ms pushDraft START ${body.identifier}`)
        await sleep(ctl.pushMs)
        ctl.inflight--
        if (ctl.failOnce.has(body.identifier)) {
          ctl.failOnce.delete(body.identifier)
          ctl.log.push(`${Date.now() - ctl.t0}ms pushDraft FAIL(${ctl.failKind}) ${body.identifier}`)
          if (ctl.failKind === 'busy') throw new real.ApiError(409, 'Another push holds this listing', 'LISTING_BUSY')
          throw new TypeError('Load failed')
        }
        ctl.pushes.push(body.identifier)
        ctl.landed.push(body.identifier)
        ctl.log.push(`${Date.now() - ctl.t0}ms pushDraft DONE  ${body.identifier}`)
        return { mode: 'variation_added', listing_id: 'L1', product_id: 'L1', sku_id: 'S' + body.identifier }
      }),
      listingState: vi.fn(async (id: string) => {
        await sleep(ctl.stateMs)
        return {
          listing_id: id, title: 't', product_status: 'PENDING', audit_reasons: [],
          variations_on_tiktok: ctl.landed.length, removed_count: 0, max_skus: 100,
          variants: ctl.landed.map(variant), checked_at: new Date().toISOString(),
        }
      }),
      listedSkus: vi.fn(async () => []),
      listingAllowance: vi.fn(async () => ({ used: null, cap: 100, remaining: null })),
      reserveIdentifier: vi.fn(async (_l: string, p: string) => ({ prefix: p, seq: 1 })),
      removedVariations: vi.fn(async () => ({ variants: [], total: 0 })),
    },
  }
})
vi.mock('../capture/camera', async (orig) => ({
  ...(await orig<typeof import('../capture/camera')>()),
  toSquareJpeg: async () => {
    throw new Error('no canvas in test')
  },
}))

import DraftQueue from '../live-listing/DraftQueue'
import { startQueueRunner, isDraining, onQueueChange as onSenderChange } from './runner'
import { allDrafts, enqueue, removeDraft, resetDevice, type QueuedDraft } from './queue'
import type { Draft } from '../types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let created = 0
function draft(i: number): Draft {
  created++
  return {
    draft_id: `d${String(i).padStart(3, '0')}-${created}`,
    listing_id: 'L1', stream_id: 'L1', continues_from: null, shop_id: 'HZ',
    identifier: `BR${i}`, title: 'HOUZE live', variant_name: `thing ${i}`, price: '9.90', stock: 1,
    weight_kg: '1', dimensions: null, include_dims_in_title: false, image_preview: null,
    tiktok_image_uri: null, tiktok_attribute_image_uri: null, status: 'queued', error: null,
    idempotency_key: `k${i}-${created}`,
    created_at: new Date(Date.UTC(2026, 9, 17, 3, 0, 0) + i * 1000 + created).toISOString(),
  }
}
const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })

/**
 * ListingDetail's own wiring: the drafts state, refreshDrafts, the mount
 * effect and the subscription to the background sender.
 */
let handle: { refreshDrafts: () => Promise<void> } | null = null
function Parent({ onQueueChange }: { onQueueChange: () => void }) {
  const listing = { listing_id: 'L1' }
  const [drafts, setDrafts] = useState<QueuedDraft[]>([])
  const refreshDrafts = useCallback(async () => {
    const all = await allDrafts().catch(() => [] as QueuedDraft[])
    setDrafts(all.filter((d) => d.listing_id === listing.listing_id))
    onQueueChange()
  }, [listing.listing_id, onQueueChange])
  useEffect(() => {
    void refreshDrafts()
  }, [refreshDrafts])
  // As ListingDetail does: the sender runs in the background and says when it
  // has changed the queue.
  useEffect(() => onSenderChange(() => void refreshDrafts()), [refreshDrafts])
  handle = { refreshDrafts }
  return (
    <DraftQueue
      drafts={drafts}
      listingId={listing.listing_id}
      onChanged={refreshDrafts}
      onLive={() => {}}
      onDelete={async (id) => {
        await removeDraft(id)
        await refreshDrafts()
      }}
    />
  )
}

let root: Root | null = null
let stopRunner: (() => void) | null = null
const noop = () => {}
async function mount() {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  // What App does for a signed-in person.
  stopRunner = startQueueRunner()
  root.render(<Parent onQueueChange={noop} />)
  await sleep(30)
  return el
}

async function wipe() {
  // Settle everything to pushed so resetDevice's guard lets us clear.
  const { updateDraft } = await import('./queue')
  for (const d of await allDrafts()) await updateDraft(d.draft_id, { status: 'pushed' })
  await resetDevice()
}

async function snapshot(el: HTMLElement) {
  const all = await allDrafts()
  return {
    pushedOnTikTok: ctl.pushes.length,
    pushedIds: [...ctl.pushes],
    local: all.map((d) => `${d.identifier}:${d.status}`),
    queuedLeft: all.filter((d) => d.status !== 'pushed').map((d) => d.identifier),
    header: (el.textContent ?? '').includes('Uploading…') ? 'Uploading…' : 'idle',
  }
}

afterEach(async () => {
  stopRunner?.()
  stopRunner = null
  for (let i = 0; i < 200 && isDraining(); i++) await sleep(25)
})

beforeEach(async () => {
  root?.unmount()
  root = null
  await wipe()
  ctl.inflight = 0
  ctl.peak = 0
  ctl.pushes = []
  ctl.starts = []
  ctl.landed = []
  ctl.failOnce = new Set()
  ctl.log = []
  ctl.t0 = Date.now()
})


describe('the queue keeps pushing through a live stream (1 ms here ~ 100 ms on a phone)', () => {
  it('12 seeded, nobody touches anything: all 12 push', async () => {
    ctl.pushMs = 150
    for (let i = 1; i <= 12; i++) await enqueue(draft(i), photo())
    const el = await mount()
    await sleep(12 * 150 + 1500)
    const s = await snapshot(el)
    expect(s.pushedOnTikTok).toBe(12)
    expect(s.header).toBe('idle')
    expect(ctl.peak).toBe(1)
  }, 30_000)

  it('a SKU saved while the first push is in flight: all 13 push (the old queue stopped after 1)', async () => {
    ctl.pushMs = 150
    for (let i = 1; i <= 12; i++) await enqueue(draft(i), photo())
    const el = await mount()
    await sleep(75)
    expect(ctl.inflight).toBe(1)
    await enqueue(draft(13), photo())
    await handle!.refreshDrafts()
    await sleep(13 * 150 + 2500)
    const s = await snapshot(el)
    expect(s.pushedOnTikTok).toBe(13)
    expect(s.queuedLeft).toEqual([])
    expect(s.header).toBe('idle')
    expect(ctl.peak).toBe(1)
  }, 30_000)

  async function stream(n: number, pushMs: (i: number) => number, gapMs: (i: number) => number) {
    const el = await mount()
    for (let i = 1; i <= n; i++) {
      await sleep(gapMs(i))
      ctl.pushMs = pushMs(i)
      await enqueue(draft(i), photo())
      await handle!.refreshDrafts()
    }
    // Until everything has landed or a generous deadline passes.
    for (let t = 0; t < 400 && ctl.pushes.length < n; t++) await sleep(50)
    await sleep(300)
    return snapshot(el)
  }

  it('BR9 saved 10 s after BR8: all 12 push (the old queue stopped after 8)', async () => {
    const s = await stream(12, () => 170, (i) => (i === 9 ? 100 : 600))
    expect(s.pushedIds).toEqual(['BR1', 'BR2', 'BR3', 'BR4', 'BR5', 'BR6', 'BR7', 'BR8', 'BR9', 'BR10', 'BR11', 'BR12'])
    expect(s.header).toBe('idle')
    expect(ctl.peak).toBe(1)
  }, 90_000)

  it('BR8 takes 80 s to push: all 12 push (the old queue stopped after 8)', async () => {
    const s = await stream(12, (i) => (i === 8 ? 800 : 170), () => 600)
    expect(s.pushedOnTikTok).toBe(12)
    expect(s.header).toBe('idle')
    expect(ctl.peak).toBe(1)
  }, 90_000)

  it('SKUs saved faster than they push: all 12 push, one at a time (the old queue stopped after 1)', async () => {
    const s = await stream(12, () => 170, () => 120)
    expect(s.pushedOnTikTok).toBe(12)
    expect(ctl.peak).toBe(1)
  }, 90_000)

  it('BR5 takes 46 s: all 12 push (the old queue stopped after 5)', async () => {
    const s = await stream(12, (i) => (i === 5 ? 460 : 170), () => 300)
    expect(s.pushedOnTikTok).toBe(12)
  }, 90_000)

  it('the refresh icon tapped mid-push: all 12 push (the old queue stopped after 6)', async () => {
    ctl.stateMs = 50
    const el = await mount()
    for (let i = 1; i <= 12; i++) {
      await sleep(600)
      ctl.pushMs = 170
      await enqueue(draft(i), photo())
      await handle!.refreshDrafts()
      if (i === 6) {
        await sleep(20)
        const btn = el.querySelector('[aria-label="Check TikTok for this listing"]') as HTMLButtonElement
        btn.click()
      }
    }
    for (let t = 0; t < 400 && ctl.pushes.length < 12; t++) await sleep(50)
    await sleep(300)
    const s = await snapshot(el)
    ctl.stateMs = 100
    expect(s.pushedOnTikTok).toBe(12)
    expect(s.header).toBe('idle')
  }, 90_000)
})

describe('a failed attempt is retried on its own, without another save', () => {
  for (const kind of ['busy', 'network'] as const) {
    it(`${kind === 'busy' ? 'LISTING_BUSY' : 'a network error'} on the last SKU: retried within seconds`, async () => {
      ctl.pushMs = 50
      ctl.failKind = kind
      ctl.failOnce.add('BR3')
      for (let i = 1; i <= 3; i++) await enqueue(draft(i), photo())
      const el = await mount()
      await sleep(3 * 50 + 6000)
      const s = await snapshot(el)
      expect(s.pushedIds).toEqual(['BR1', 'BR2', 'BR3'])
      expect(ctl.starts.map((x) => x.id)).toEqual(['BR1', 'BR2', 'BR3', 'BR3'])
    }, 30_000)
  }
})
