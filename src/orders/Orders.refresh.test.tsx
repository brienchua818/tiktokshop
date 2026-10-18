// @vitest-environment happy-dom
/**
 * The Orders tab reads again by itself while the window is still open.
 *
 * It read once when opened, when the window changed and after Sync, so the
 * figures left on screen during a stream stopped moving while the backend's
 * own timer kept pulling orders in. Through the real Orders screen on a fake
 * clock, with the network stubbed. 10:00 UTC is 18:00 in Singapore, inside
 * the default window of today.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ListingOrders, OrderSummary } from '../lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctl = vi.hoisted(() => ({
  orderSummary: vi.fn(),
  listingOrders: vi.fn(),
  syncOrders: vi.fn(),
}))
vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      orderSummary: ctl.orderSummary,
      listingOrders: ctl.listingOrders,
      syncOrders: ctl.syncOrders,
    },
  }
})

import Orders from './Orders'

function summary(orders: number): OrderSummary {
  return {
    from: '', to: '', total_orders: orders, total_units: orders, total_revenue: orders * 10,
    listings: [
      { listing_id: 'L1', product_name: 'First', units: orders, order_count: orders, unsold_units: 0, revenue: orders * 10, latest_order_sgt: '' },
    ],
  }
}
function detail(units: number): ListingOrders {
  return {
    listing_id: 'L1', from: '', to: '', order_count: units, total_units: units, total_revenue: units * 10,
    variations: [{ seller_sku: 'A1', variation: 'A1 bowl', units, unsold_units: 0, revenue: units * 10, price: '10' }],
  }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((a) => {
    resolve = a
  })
  return { promise, resolve }
}

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })

let root: Root | null = null
let el: HTMLElement

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
async function mount() {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => root!.render(<Orders shop={{ shop_id: 'HZ', brand: 'HOUZE' } as never} />))
  await advance(0)
}
async function fire(target: EventTarget, type: string) {
  await act(async () => {
    target.dispatchEvent(new Event(type))
  })
  await advance(0)
}
function button(match: (text: string) => boolean): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) => match(x.textContent?.trim() ?? ''))
  if (!b) throw new Error('no such button')
  return b
}
async function click(b: HTMLElement) {
  await act(async () => b.click())
  await advance(0)
}
/** Type into an input the way a browser does, so React's onChange runs. */
async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const reads = () => ctl.orderSummary.mock.calls.length
const drills = () => ctl.listingOrders.mock.calls.length

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'))
  document.body.innerHTML = ''
  visibility = 'visible'
  ctl.orderSummary.mockReset()
  ctl.listingOrders.mockReset()
  ctl.syncOrders.mockReset()
  ctl.orderSummary.mockImplementation(async () => summary(3))
  ctl.listingOrders.mockImplementation(async () => detail(3))
  ctl.syncOrders.mockImplementation(async () => ({ orders: 0, items: 0, from: '', to: '' }))
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  vi.useRealTimers()
})

describe('7. the Orders tab keeps itself current', () => {
  it('reads every 60 s while the window includes now', async () => {
    await mount()
    expect(reads()).toBe(1)
    await advance(59_000)
    expect(reads()).toBe(1)
    await advance(1_000)
    expect(reads()).toBe(2)
    await advance(60_000)
    expect(reads()).toBe(3)
  })

  it('a hidden page does not poll, and coming back after 30 s reads at once', async () => {
    await mount()
    await advance(60_000)
    expect(reads()).toBe(2)
    visibility = 'hidden'
    await fire(document, 'visibilitychange')
    await advance(5 * 60_000)
    expect(reads()).toBe(2)
    visibility = 'visible'
    await fire(document, 'visibilitychange')
    expect(reads()).toBe(3)
  })

  it('focus reads only when the figures are older than 30 s', async () => {
    await mount()
    await advance(20_000)
    await fire(window, 'focus')
    expect(reads()).toBe(1)
    await advance(11_000)
    await fire(window, 'focus')
    expect(reads()).toBe(2)
  })

  it('a window that has ended is not polled', async () => {
    await mount()
    await click(button((t) => t.includes('→')))
    await click(button((t) => t === 'Yesterday'))
    await advance(500)
    expect(reads()).toBe(2)
    expect(ctl.orderSummary.mock.calls[1]![1]).toMatchObject({ from_date: '2026-10-17', to_date: '2026-10-17' })
    await advance(5 * 60_000)
    expect(reads()).toBe(2)
  })

  it('skips a tick while Sync is running', async () => {
    await mount()
    const sync = deferred<{ orders: number; items: number; from: string; to: string }>()
    ctl.syncOrders.mockImplementationOnce(() => sync.promise)
    await click(button((t) => t === 'Sync'))
    await advance(3 * 60_000)
    expect(reads()).toBe(1)
    await act(async () => sync.resolve({ orders: 1, items: 1, from: '', to: '' }))
    await advance(0)
    expect(reads()).toBe(2)
  })

  it('the open drill-down is read again after Sync and on each poll', async () => {
    await mount()
    await click(button((t) => t.startsWith('First')))
    expect(drills()).toBe(1)
    await click(button((t) => t === 'Sync'))
    expect(drills()).toBe(2)
    ctl.listingOrders.mockImplementation(async () => detail(7))
    await advance(60_000)
    expect(drills()).toBe(3)
    expect(el.textContent).toContain('7 sold')
  })

  it('date and time fields are read 500 ms after the last change, once', async () => {
    await mount()
    await click(button((t) => t.includes('→')))
    const from = document.querySelectorAll('input[type="time"]')[0] as HTMLInputElement
    await type(from, '18:00')
    await advance(200)
    await type(from, '18:30')
    await advance(200)
    await type(from, '18:45')
    await advance(499)
    expect(reads()).toBe(1)
    await advance(1)
    expect(reads()).toBe(2)
    expect(ctl.orderSummary.mock.calls[1]![1]).toMatchObject({ from_time: '18:45' })
  })

  it('says when the figures were read, after every read and not only after Sync', async () => {
    await mount()
    expect(el.textContent).toMatch(/read (18:00|06:00 pm)/)
    await advance(60_000)
    expect(el.textContent).toMatch(/read (18:01|06:01 pm)/)
  })

  it('an answer asked for before the one on screen does not replace it', async () => {
    const first = deferred<OrderSummary>()
    ctl.orderSummary.mockImplementationOnce(() => first.promise)
    await mount()
    ctl.orderSummary.mockImplementationOnce(async () => summary(5))
    await click(button((t) => t === 'Sync'))
    expect(el.textContent).toContain('5 orders')
    await act(async () => first.resolve(summary(1)))
    await advance(0)
    expect(el.textContent).toContain('5 orders')
  })

  it('stops on unmount', async () => {
    await mount()
    await advance(60_000)
    expect(reads()).toBe(2)
    await act(async () => root!.unmount())
    root = null
    await advance(10 * 60_000)
    expect(reads()).toBe(2)
  })
})
