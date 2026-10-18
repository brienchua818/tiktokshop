// @vitest-environment happy-dom
/**
 * The stock and price sheet, judged by what it sends.
 *
 * Every assertion is on the body handed to api.setStock or api.setPrice, or on
 * a write that was NOT sent — those are what change a live listing. Three
 * harms this stops, each seen or measured: a "reduction" set from a stale
 * screen that raised the stock, a retried delta applied twice, and a busy
 * reply that promised a retry nothing ever made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctl = vi.hoisted(() => ({ setStock: vi.fn(), setPrice: vi.fn() }))
vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return { ...real, api: { ...real.api, setStock: ctl.setStock, setPrice: ctl.setPrice } }
})

import { ApiError, type LiveVariant } from '../lib/api'
import { StockSheet } from './DraftQueue'

const variant = (over: Partial<LiveVariant> = {}): LiveVariant => ({
  identifier: 'A1', variant: 'A1 Ceramic Bowl', price: '12.90', status: 'pushed', external: false,
  tiktok_sku_id: '9001', image_url: '', created_at: '', created_by: '', state: 'live', buyable: true,
  on_tiktok: true, removed: false, stock_available: 10, stock_total: 12, held: 0, refunded: 0,
  at_risk: 0, sold: 2, cancelled: 0, ...over,
})

/** What the backend says while another write holds the lock. */
const busy = () =>
  new ApiError(
    409,
    'Another change is being saved right now. This will retry in a moment — nothing has been lost.',
    'LISTING_BUSY',
    { retryable: true },
  )
/** What the client raises when it gave up waiting: status 0, outcome unknown. */
const lost = (action: string) =>
  new ApiError(0, `"${action}" gave no reply after 90s. It may still have gone through, so check before repeating it.`, 'TIMEOUT')

let el: HTMLDivElement
let root: Root

async function mount(props: Partial<Parameters<typeof StockSheet>[0]> = {}) {
  const onDone = vi.fn(async (_note: string, _changed?: unknown) => {})
  const onUnknown = vi.fn()
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => {
    root.render(
      <StockSheet
        v={variant()}
        listingId="P1"
        onClose={() => {}}
        onDone={onDone}
        onUnknown={onUnknown}
        {...props}
      />,
    )
  })
  return { onDone, onUnknown }
}

const labelled = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const titled = (text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)
const click = (b: HTMLButtonElement | null | undefined) =>
  act(async () => {
    if (!b) throw new Error('no such button')
    b.click()
  })
/** Types as a person does: through the value setter React watches, then an input event. */
const type = (selector: string, value: string) =>
  act(() => {
    const input = el.querySelector<HTMLInputElement>(selector)
    if (!input) throw new Error('no input ' + selector)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const later = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  ctl.setStock.mockReset()
  ctl.setPrice.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
})

describe('stock', () => {
  it('a minus step sends a negative delta, never an absolute', async () => {
    ctl.setStock.mockResolvedValue({ identifier: 'A1', before: 10, after: 5, requested: 5 })
    const { onDone } = await mount()
    await click(labelled('Take 5 off'))
    expect(ctl.setStock).toHaveBeenCalledTimes(1)
    const body = ctl.setStock.mock.calls[0]![0]
    expect(body).toMatchObject({ listing_id: 'P1', identifier: 'A1', tiktok_sku_id: '9001', delta: -5 })
    expect(body).not.toHaveProperty('absolute')
    expect(typeof body.idempotency_key).toBe('string')
    // TikTok's figure, not the arithmetic.
    expect(onDone).toHaveBeenCalledWith('A1: 5 left, was 10.', { stock_available: 5 })
  })

  it('a minus step that would take the shown stock below 1 cannot be pressed', async () => {
    await mount({ v: variant({ stock_available: 3 }) })
    expect(labelled('Take 1 off')?.disabled).toBe(false)
    expect(labelled('Take 5 off')?.disabled).toBe(true)
    expect(labelled('Take 10 off')?.disabled).toBe(true)
    await click(labelled('Take 5 off'))
    expect(ctl.setStock).not.toHaveBeenCalled()
  })

  it('an exact number carries the number the screen showed', async () => {
    ctl.setStock.mockResolvedValue({ identifier: 'A1', before: 10, after: 6, requested: 6 })
    await mount()
    await click(titled('Set an exact number instead'))
    type('input[aria-label="Exact stock"]', '6')
    await click(titled('Set'))
    expect(ctl.setStock).toHaveBeenCalledTimes(1)
    expect(ctl.setStock.mock.calls[0]![0]).toMatchObject({ absolute: 6, expected_before: 10 })
  })

  it('a busy backend is retried with the same key, and the sheet says it is retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ctl.setStock
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce({ identifier: 'A1', before: 10, after: 11, requested: 11 })
    const { onDone } = await mount()
    await click(titled('+1'))
    expect(ctl.setStock).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('Retrying (1 of 3)')
    await later(2_000)
    expect(ctl.setStock).toHaveBeenCalledTimes(2)
    expect(el.textContent).toContain('Retrying (2 of 3)')
    await later(4_000)
    expect(ctl.setStock).toHaveBeenCalledTimes(3)
    const keys = ctl.setStock.mock.calls.map((c) => c[0].idempotency_key)
    expect(keys[0]).toBeTruthy()
    expect(new Set(keys).size).toBe(1)
    expect(onDone).toHaveBeenCalledWith('A1: 11 left, was 10.', { stock_available: 11 })
  })

  it('a backend still busy after three retries is reported, and nothing more is sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ctl.setStock.mockRejectedValue(busy())
    const { onDone } = await mount()
    await click(titled('+5'))
    await later(2_000)
    await later(4_000)
    await later(6_000)
    await later(30_000)
    expect(ctl.setStock).toHaveBeenCalledTimes(4)
    expect(el.textContent).toContain('Still busy after 3 retries. Nothing was changed')
    expect(onDone).not.toHaveBeenCalled()
  })

  it('a reply that never came is not sent again; the caller is asked to check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ctl.setStock.mockRejectedValueOnce(lost('setStock'))
    const { onDone, onUnknown } = await mount()
    await click(titled('+10'))
    await later(60_000)
    expect(ctl.setStock).toHaveBeenCalledTimes(1)
    expect(onUnknown).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
    expect(el.textContent).toMatch(/Outcome unknown.*not sent again.*Checking the listing/)
    // Nor can it be sent again by hand from here: a second tap is a new key.
    expect(titled('+10')?.disabled).toBe(true)
    expect(labelled('Take 1 off')?.disabled).toBe(true)
  })
})

describe('price', () => {
  it('is offered for a live variation, whatever the review state of the listing', async () => {
    // The listing's status is read from its copy under review, which is what
    // it is for most of a stream: the price must not hide behind it.
    await mount({ v: { ...variant(), stock_available: null } })
    expect(el.querySelector('input[aria-label="New price"]')).toBeNull()
    act(() => root.unmount())
    el.remove()
    await mount()
    expect(el.querySelector('input[aria-label="New price"]')).not.toBeNull()
    expect(el.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Stock and price for A1')
  })

  it('Save stays off until the price is valid and different, and the change is spelled out', async () => {
    await mount()
    const save = () => titled('Save price')!
    expect(save().disabled).toBe(true)
    type('input[aria-label="New price"]', '12.9')
    expect(save().disabled).toBe(true)
    type('input[aria-label="New price"]', '18.905')
    expect(save().disabled).toBe(true)
    expect(el.textContent).toContain('at most two decimal places')
    type('input[aria-label="New price"]', '10000.01')
    expect(save().disabled).toBe(true)
    expect(el.textContent).toContain('ceiling for Singapore')
    type('input[aria-label="New price"]', '9.9')
    expect(save().disabled).toBe(false)
    expect(el.textContent).toContain('$12.90 → $9.90')
  })

  it('a price far from the current one asks once more before it is sent', async () => {
    ctl.setPrice.mockResolvedValue({
      identifier: 'A1', before: '12.90', after: '99.00', requested: '99.00', pending_price: false, currency: 'SGD',
    })
    await mount()
    type('input[aria-label="New price"]', '99')
    await click(titled('Save price'))
    expect(ctl.setPrice).not.toHaveBeenCalled()
    expect(el.textContent).toContain('more than three times the current $12.90')
    await click(titled('Confirm $99.00'))
    expect(ctl.setPrice).toHaveBeenCalledTimes(1)
    expect(ctl.setPrice.mock.calls[0]![0].price).toBe('99.00')
  })

  it('under a third of the current price asks once more too', async () => {
    await mount()
    type('input[aria-label="New price"]', '1.29')
    await click(titled('Save price'))
    expect(ctl.setPrice).not.toHaveBeenCalled()
    expect(el.textContent).toContain('under a third of the current $12.90')
  })

  it('sends the price and the price the screen showed, then shows TikTok’s figure', async () => {
    ctl.setPrice.mockResolvedValue({
      identifier: 'A1', tiktok_sku_id: '9001', before: '12.90', after: '9.90', requested: '9.90',
      pending_price: false, currency: 'SGD',
    })
    const { onDone } = await mount()
    type('input[aria-label="New price"]', '9.9')
    await click(titled('Save price'))
    expect(ctl.setPrice).toHaveBeenCalledWith({
      listing_id: 'P1', identifier: 'A1', tiktok_sku_id: '9001', price: '9.90', expected_before: '12.90',
    })
    expect(onDone).toHaveBeenCalledWith('A1: now $9.90, was $12.90.', { price: '9.90' })
  })

  it('says so when the copy under review still shows the old price', async () => {
    ctl.setPrice.mockResolvedValue({
      identifier: 'A1', before: '12.90', after: '9.90', requested: '9.90', pending_price: true, currency: 'SGD',
    })
    const { onDone } = await mount()
    type('input[aria-label="New price"]', '9.90')
    await click(titled('Save price'))
    const note = String(onDone.mock.calls[0]![0])
    expect(note).toContain('A1: now $9.90, was $12.90.')
    expect(note).toContain('copy under review still shows $12.90')
    expect(note).toContain('TikTok will catch up')
  })

  it('a price change whose reply never came is not sent again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ctl.setPrice.mockRejectedValueOnce(lost('setPrice'))
    const { onDone, onUnknown } = await mount()
    type('input[aria-label="New price"]', '9.90')
    await click(titled('Save price'))
    await later(60_000)
    expect(ctl.setPrice).toHaveBeenCalledTimes(1)
    expect(onUnknown).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
    expect(titled('Save price')?.disabled).toBe(true)
  })
})
