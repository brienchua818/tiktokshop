// @vitest-environment happy-dom
/**
 * Export only the listings that are ticked.
 *
 * Brien, 24 Sep: a five-day window held more listings than one export can
 * build inside Google's six-minute limit, and he needed only some of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { exportOrders, listing } = vi.hoisted(() => ({
  exportOrders: vi.fn(async (_body: unknown) => ({ url: 'u', name: 'n', listings: 1, units: 3, revenue: 30, cost_divisor: null })),
  listing: (id: string, name: string) => ({
    listing_id: id, product_name: name, units: 3, order_count: 2, unsold_units: 0, revenue: 30,
  }),
}))
vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      orderSummary: vi.fn(async () => ({
        from: '', to: '', total_orders: 3, total_units: 9, total_revenue: 90,
        listings: [listing('L1', 'First'), listing('L2', 'Second'), listing('', 'No listing id'), listing('L3', 'Third')],
      })),
      exportOrders,
    },
  }
})

import Orders from './Orders'

async function render() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  await act(async () => {
    createRoot(el).render(<Orders shop={{ shop_id: 'HZ', brand: 'HOUZE' } as never} />)
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return el
}
const byLabel = (el: HTMLElement, label: string) =>
  el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
const exportButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) => /^Export (all|\d+ selected)/.test(b.textContent ?? ''))!

describe('exporting chosen listings', () => {
  beforeEach(() => { document.body.innerHTML = ''; exportOrders.mockClear() })

  it('sends exactly the ticked listings', async () => {
    const el = await render()
    await act(async () => { byLabel(el, 'Export First').click() })
    await act(async () => { byLabel(el, 'Export Third').click() })
    expect(exportButton(el).textContent).toContain('Export 2 selected')
    await act(async () => { exportButton(el).click() })
    expect(exportOrders).toHaveBeenCalledTimes(1)
    const sent = exportOrders.mock.calls[0]![0] as unknown as { listing_ids?: string[]; cost_divisor?: number }
    expect(sent.listing_ids).toEqual(['L1', 'L3'])
    expect(sent.cost_divisor).toBeUndefined()
  })

  it('nothing ticked exports every listing', async () => {
    const el = await render()
    expect(exportButton(el).textContent).toContain('Export all 3 listings')
    await act(async () => { exportButton(el).click() })
    const sent = exportOrders.mock.calls[0]![0] as unknown as { listing_ids?: string[] }
    expect(sent.listing_ids).toBeUndefined()
  })

  it('unticking takes a listing back out', async () => {
    const el = await render()
    await act(async () => { byLabel(el, 'Export Second').click() })
    await act(async () => { byLabel(el, 'Export Second').click() })
    expect(exportButton(el).textContent).toContain('Export all')
  })

  it('select all ticks every listing that has an id, and clear all empties it', async () => {
    const el = await render()
    const selectAll = () => [...el.querySelectorAll('button')].find((b) => /Select all|Clear all/.test(b.textContent ?? ''))!
    await act(async () => { selectAll().click() })
    expect(exportButton(el).textContent).toContain('Export 3 selected')
    expect(byLabel(el, 'Export No listing id')).toBeNull()   // nothing to export for it
    await act(async () => { selectAll().click() })
    expect(exportButton(el).textContent).toContain('Export all')
  })
})
