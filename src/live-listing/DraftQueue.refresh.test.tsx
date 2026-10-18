// @vitest-environment happy-dom
/**
 * The listing screen reads TikTok again by itself.
 *
 * It read once on opening and then only on a tap or after this phone's own
 * stock, remove or restore. The effect meant to read again when a push landed
 * returned early once anything had been read. Each block below is one part of
 * what replaced that, through the real DraftQueue on a fake clock; only the
 * network (api.*), IndexedDB and the background sender are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ListingState, LiveVariant } from '../lib/api'
import type { QueuedDraft } from '../offline/queue'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctl = vi.hoisted(() => ({
  listingState: vi.fn(),
  setStock: vi.fn(),
  removeVariation: vi.fn(),
}))
vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      listingState: ctl.listingState,
      setStock: ctl.setStock,
      removeVariation: ctl.removeVariation,
      removedVariations: vi.fn(async () => ({ variants: [], total: 0 })),
    },
  }
})
vi.mock('../offline/queue', async (orig) => ({
  ...(await orig<typeof import('../offline/queue')>()),
  allDrafts: vi.fn(async () => []),
  updateDraft: vi.fn(async () => {}),
  removeDraft: vi.fn(async () => {}),
  getPhoto: vi.fn(async () => null),
}))
vi.mock('../offline/runner', () => ({ kickQueue: vi.fn() }))

import DraftQueue from './DraftQueue'
import { ApiError, HEAVY_READ, POLL_READ } from '../lib/api'

function variant(id: string, over: Partial<LiveVariant> = {}): LiveVariant {
  return {
    identifier: id, variant: `${id} bowl`, price: '10', status: 'pushed', external: false,
    tiktok_sku_id: `S${id}`, image_url: '', created_at: '', created_by: 'brien', state: 'live',
    buyable: true, on_tiktok: true, removed: false, stock_available: 5, stock_total: 7, held: 0,
    refunded: 0, at_risk: 0, sold: 2, cancelled: 0, ...over,
  }
}
function state(...variants: LiveVariant[]): ListingState {
  return {
    listing_id: 'L1', title: 'HOUZE live', product_status: 'ACTIVATE', audit_reasons: [],
    variations_on_tiktok: variants.length, removed_count: 0, max_skus: 100, variants,
    checked_at: new Date().toISOString(),
  }
}
function draft(id: string, status: QueuedDraft['status']): QueuedDraft {
  return {
    draft_id: `d-${id}`, listing_id: 'L1', stream_id: 'L1', continues_from: null, shop_id: 'HZ',
    identifier: id, title: 'HOUZE live', variant_name: `${id} bowl`, price: '10', stock: 1,
    weight_kg: '1', dimensions: null, include_dims_in_title: false, image_preview: null,
    tiktok_image_uri: null, tiktok_attribute_image_uri: null, status, error: null,
    idempotency_key: `k-${id}`, created_at: '2026-10-18T09:00:00.000Z', attempts: 0, retryAfter: 0,
  } as QueuedDraft
}
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

let visibility: DocumentVisibilityState = 'visible'
let online = true
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })

let root: Root | null = null
let el: HTMLElement
const onLive = vi.fn()

async function render(drafts: QueuedDraft[] = []) {
  await act(async () => {
    root!.render(
      <DraftQueue drafts={drafts} listingId="L1" onChanged={async () => {}} onLive={onLive} onDelete={() => {}} />,
    )
  })
}
async function mount(drafts: QueuedDraft[] = []) {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await render(drafts)
  await advance(0)
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
async function fire(target: EventTarget, type: string) {
  await act(async () => {
    target.dispatchEvent(new Event(type))
  })
  await advance(0)
}
async function click(label: string) {
  const b = el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null
  if (!b) throw new Error(`no control labelled ${label}`)
  await act(async () => b.click())
  await advance(0)
}
async function clickText(text: string) {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text)
  if (!b) throw new Error(`no button reading ${text}`)
  await act(async () => b.click())
  await advance(0)
}
const reads = () => ctl.listingState.mock.calls.length
const plans = () => ctl.listingState.mock.calls.map((c) => c[1])
const header = () => el.querySelector('.h-11')?.textContent ?? ''
/** The row whose identifier is `id`, as text; empty when there is none. */
const rowText = (id: string) =>
  [...el.querySelectorAll('li')].find((li) => [...li.querySelectorAll('span')].some((s) => s.textContent === id))
    ?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'))
  document.body.innerHTML = ''
  visibility = 'visible'
  online = true
  ctl.listingState.mockReset()
  ctl.setStock.mockReset()
  ctl.removeVariation.mockReset()
  onLive.mockReset()
  ctl.listingState.mockImplementation(async () => state(variant('A1')))
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  vi.useRealTimers()
})

describe('1. it polls while the listing is open and on screen', () => {
  it('opens with the heavy read, then every 30 s with the light one once everything is live', async () => {
    await mount()
    expect(plans()).toEqual([HEAVY_READ])
    await advance(29_000)
    expect(reads()).toBe(1)
    await advance(1_000)
    expect(plans()).toEqual([HEAVY_READ, POLL_READ])
    await advance(30_000)
    expect(plans()).toEqual([HEAVY_READ, POLL_READ, POLL_READ])
  })

  it('every 20 s while a variation is still in review', async () => {
    ctl.listingState.mockImplementation(async () => state(variant('A1', { state: 'reviewing', buyable: false })))
    await mount()
    await advance(20_000)
    expect(reads()).toBe(2)
    await advance(20_000)
    expect(reads()).toBe(3)
  })

  it('every 20 s while a pushed SKU is not in the read yet', async () => {
    await mount([draft('A2', 'pushed')])
    await advance(20_000)
    expect(reads()).toBe(2)
  })

  it('the next read is timed from when the last one answered, and never overlaps it', async () => {
    await mount()
    const slow = deferred<ListingState>()
    ctl.listingState.mockImplementationOnce(() => slow.promise)
    await advance(30_000)
    expect(reads()).toBe(2)
    // Out for 45 s. An interval would have sent another at 60 s and 90 s.
    await advance(45_000)
    expect(reads()).toBe(2)
    await act(async () => slow.resolve(state(variant('A1'))))
    await advance(29_000)
    expect(reads()).toBe(2)
    await advance(1_000)
    expect(reads()).toBe(3)
  })

  it('a read from anywhere else restarts the gap, so a tap is not followed by a tick seconds later', async () => {
    await mount()
    await advance(20_000)
    await click('Check TikTok for this listing')
    expect(reads()).toBe(2)
    await advance(29_000)
    expect(reads()).toBe(2)
    await advance(1_000)
    expect(reads()).toBe(3)
  })

  it('skips a tick while the stock sheet is open, and tries again on the next', async () => {
    await mount()
    await click('Stock and price for A1')
    await advance(95_000)
    expect(reads()).toBe(1)
    await click('Close')
    await advance(30_000)
    expect(reads()).toBe(2)
  })

  it('skips a tick while the remove dialog is open', async () => {
    await mount()
    await click('Remove A1 from TikTok')
    await advance(95_000)
    expect(reads()).toBe(1)
    await clickText('Keep it')
    await advance(30_000)
    expect(reads()).toBe(2)
  })

  it('a hidden page does not poll', async () => {
    await mount()
    await advance(30_000)
    expect(reads()).toBe(2)
    visibility = 'hidden'
    await fire(document, 'visibilitychange')
    await advance(5 * 60_000)
    expect(reads()).toBe(2)
  })

  it('an offline phone does not poll', async () => {
    await mount()
    await advance(30_000)
    expect(reads()).toBe(2)
    online = false
    await advance(5 * 60_000)
    expect(reads()).toBe(2)
  })

  it('stops on unmount, and a read still out then changes nothing', async () => {
    await mount()
    expect(onLive).toHaveBeenCalledTimes(1)
    const late = deferred<ListingState>()
    ctl.listingState.mockImplementationOnce(() => late.promise)
    await advance(30_000)
    expect(reads()).toBe(2)
    await act(async () => root!.unmount())
    root = null
    await act(async () => late.resolve(state(variant('A1'), variant('A2'))))
    await advance(10 * 60_000)
    expect(reads()).toBe(2)
    expect(onLive).toHaveBeenCalledTimes(1)
  })
})

describe('2. coming back reads at once when the figures are older than 10 s', () => {
  it('visible again after a while in the background', async () => {
    await mount()
    visibility = 'hidden'
    await fire(document, 'visibilitychange')
    await advance(5 * 60_000)
    visibility = 'visible'
    await fire(document, 'visibilitychange')
    expect(plans()).toEqual([HEAVY_READ, POLL_READ])
  })

  it('focus: not within 10 s of the last answer, at once after it', async () => {
    await mount()
    await advance(5_000)
    await fire(window, 'focus')
    expect(reads()).toBe(1)
    await advance(6_000)
    await fire(window, 'focus')
    expect(reads()).toBe(2)
  })

  it('back online', async () => {
    await mount()
    online = false
    await advance(60_000)
    expect(reads()).toBe(1)
    online = true
    await fire(window, 'online')
    expect(reads()).toBe(2)
  })
})

describe('3. a push landing is read, with the listing already read', () => {
  it('about 3 s after it lands', async () => {
    await mount([draft('A2', 'queued')])
    await render([draft('A2', 'uploading')])
    await render([draft('A2', 'pushed')])
    await advance(2_900)
    expect(reads()).toBe(1)
    await advance(200)
    expect(plans()).toEqual([HEAVY_READ, POLL_READ])
  })

  it('a run of pushes costs one read', async () => {
    await mount([draft('A2', 'uploading'), draft('A3', 'queued'), draft('A4', 'queued')])
    await render([draft('A2', 'pushed'), draft('A3', 'uploading'), draft('A4', 'queued')])
    await advance(1_000)
    await render([draft('A2', 'pushed'), draft('A3', 'pushed'), draft('A4', 'uploading')])
    await advance(1_000)
    await render([draft('A2', 'pushed'), draft('A3', 'pushed'), draft('A4', 'pushed')])
    await advance(1_100)
    expect(reads()).toBe(2)
    await advance(10_000)
    expect(reads()).toBe(2)
  })

  it('one landing while a read is out is read again when that read ends', async () => {
    await mount([draft('A2', 'uploading')])
    const out = deferred<ListingState>()
    ctl.listingState.mockImplementationOnce(() => out.promise)
    await click('Check TikTok for this listing')
    expect(reads()).toBe(2)
    await render([draft('A2', 'pushed')])
    await advance(5_000)
    expect(reads()).toBe(2)
    await act(async () => out.resolve(state(variant('A1'))))
    await advance(0)
    expect(reads()).toBe(3)
  })

  it('SKUs already pushed when the screen opens are not a push landing', async () => {
    await mount([])
    await render([draft('A2', 'pushed'), draft('A3', 'pushed')])
    await advance(10_000)
    expect(reads()).toBe(1)
  })
})

describe('4. the newest answer wins', () => {
  it('a read asked for before a removal does not put the removed variation back', async () => {
    ctl.listingState.mockImplementation(async () => state(variant('A1'), variant('A2')))
    await mount()
    expect(rowText('A2')).not.toBe('')

    const before = deferred<ListingState>()
    ctl.listingState.mockImplementationOnce(() => before.promise)
    await click('Check TikTok for this listing')

    ctl.removeVariation.mockResolvedValue({ removed: 'A2', listing_id: 'L1', variations_now: 1, audit: 'pending' })
    ctl.listingState.mockImplementationOnce(async () => state(variant('A1')))
    await click('Remove A2 from TikTok')
    await clickText('Remove A2')
    expect(rowText('A2')).toBe('')

    await act(async () => before.resolve(state(variant('A1'), variant('A2'))))
    await advance(0)
    expect(rowText('A2')).toBe('')
    expect(onLive.mock.calls.at(-1)![0].variants.map((v: LiveVariant) => v.identifier)).toEqual(['A1'])
  })
})

describe('5. a stock change shows at once', () => {
  it('the new figure and a total moved by the same amount, before any read answers', async () => {
    await mount()
    expect(rowText('A1')).toContain('5 left of 7')
    ctl.listingState.mockImplementation(() => new Promise(() => {}))
    ctl.setStock.mockResolvedValue({ identifier: 'A1', before: 5, after: 10, requested: 5 })
    await click('Stock and price for A1')
    await clickText('+5')
    expect(rowText('A1')).toContain('10 left of 12')
    // And it is still followed by a read.
    expect(plans()).toEqual([HEAVY_READ, POLL_READ])
  })

  it('a read asked for before the change does not put the old figure back', async () => {
    await mount()
    const old = deferred<ListingState>()
    ctl.listingState.mockImplementationOnce(() => old.promise)
    await advance(30_000)
    expect(reads()).toBe(2)
    ctl.listingState.mockImplementation(() => new Promise(() => {}))
    ctl.setStock.mockResolvedValue({ identifier: 'A1', before: 5, after: 10, requested: 5 })
    await click('Stock and price for A1')
    await clickText('+5')
    await act(async () => old.resolve(state(variant('A1'))))
    await advance(0)
    expect(rowText('A1')).toContain('10 left of 12')
  })

  it('no reply: one read, never a resend, and the sheet shows what TikTok holds', async () => {
    await mount()
    ctl.setStock.mockRejectedValue(new ApiError(0, '"setStock" gave no reply after 90s. It may still have gone through, so check before repeating it.', 'TIMEOUT'))
    const truth = deferred<ListingState>()
    ctl.listingState.mockImplementationOnce(() => truth.promise)
    await click('Stock and price for A1')
    await clickText('+5')
    expect(document.body.textContent).toMatch(/Outcome unknown.*not sent again/)
    expect(reads()).toBe(2)
    await act(async () => truth.resolve(state(variant('A1', { stock_available: 10, stock_total: 12 }))))
    await advance(0)
    expect(document.body.textContent).toContain('10 left on TikTok')
    await advance(5 * 60_000)
    expect(ctl.setStock).toHaveBeenCalledTimes(1)
    // The sheet is still open, so the timer has not read either.
    expect(reads()).toBe(2)
  })

  it('a refusal is not an unknown outcome: no extra read', async () => {
    await mount()
    ctl.setStock.mockRejectedValue(new ApiError(422, 'TikTok refused the quantity', 'TS-PRD-40'))
    await click('Stock and price for A1')
    await clickText('+5')
    expect(reads()).toBe(1)
  })
})

describe('6. how old the figures are', () => {
  it('an age that counts up, and turns to a warning after two polls without an answer', async () => {
    await mount()
    await advance(15_000)
    expect(header()).toContain('checked 15 s ago')
    expect(el.querySelector('[title^="TikTok last checked"]')!.className).toContain('text-faint')
    ctl.listingState.mockImplementation(() => new Promise(() => {}))
    await advance(45_000)
    expect(header()).toContain('checked 1 min ago')
    expect(el.querySelector('[title^="TikTok last checked"]')!.className).toContain('text-faint')
    await advance(1_000)
    expect(el.querySelector('[title^="TikTok last checked"]')!.className).toContain('text-warn')
    await advance(60_000)
    expect(header()).toContain('checked 2 min ago')
  })

  it('a read that fails still says "no reply · showing HH:MM"', async () => {
    await mount()
    ctl.listingState.mockRejectedValue(new ApiError(0, 'no reply', 'TIMEOUT'))
    await advance(30_000)
    // The clock time of the last good answer, as before: 18:00 in Singapore.
    expect(header()).toMatch(/no reply · showing (18:00|06:00 pm)/)
  })

  it('an order not paid for yet reads "awaiting payment", not "cancelled"', async () => {
    ctl.listingState.mockResolvedValue(state(variant('A1', { unpaid: 2, cancelled: 1 })))
    await mount()
    expect(rowText('A1')).toContain('2 awaiting payment')
    expect(rowText('A1')).toContain('1 cancelled')
  })
})
