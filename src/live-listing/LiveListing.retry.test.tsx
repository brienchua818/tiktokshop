// @vitest-environment happy-dom
/**
 * "Try again" on the listing picker, then a change of brand.
 *
 * The retry's answer used to have no way to be cancelled, so a slow one for
 * HOUZE could land on Table Matters' screen — and a listing picked from it
 * would take SKUs to the wrong shop.
 */
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctl = vi.hoisted(() => ({ listings: vi.fn() }))
vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      listings: ctl.listings,
      listingNames: vi.fn(async () => ({ names: [], checked_at: '' })),
    },
  }
})
vi.mock('./ListingDetail', () => ({ default: () => <div>DETAIL</div> }))

import { ApiError } from '../lib/api'
import LiveListing from './LiveListing'

const listing = (shop: string, name: string) => ({
  listing_id: name, shop_id: shop, brand: shop, product_name: name, supplier: '', created_at: '',
})
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('the listing picker', () => {
  it("a retry still out when the brand changes never lands on the new brand's screen", async () => {
    let answerRetry: (rows: unknown) => void = () => {}
    ctl.listings
      .mockImplementationOnce(async () => { throw new ApiError(0, 'No connection: Load failed') })  // HOUZE fails
      .mockImplementationOnce(() => new Promise((r) => { answerRetry = r }))                      // HOUZE retry, slow
      .mockImplementationOnce(async () => [listing('TM', 'Table Matters stream')])               // TM

    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => {
      root.render(<LiveListing shop={{ shop_id: 'HZ', brand: 'HOUZE' } as never} onQueueChange={() => {}} />)
    })
    await tick()
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!
    expect(retry).toBeTruthy()
    await act(async () => { retry.click() })

    await act(async () => {
      root.render(<LiveListing shop={{ shop_id: 'TM', brand: 'TABLE MATTERS' } as never} onQueueChange={() => {}} />)
    })
    await tick()
    expect(el.textContent).toContain('Table Matters stream')

    await act(async () => { answerRetry([listing('HZ', 'HOUZE stream')]) })
    await tick()
    expect(el.textContent).toContain('Table Matters stream')
    expect(el.textContent).not.toContain('HOUZE stream')
    root.unmount()
  })

  it("a brand whose list will not load shows the error, never the last brand's listings", async () => {
    ctl.listings.mockReset()
    ctl.listings
      .mockImplementationOnce(async () => [listing('HZ', 'HOUZE stream')])
      .mockImplementationOnce(async () => { throw new ApiError(0, 'No connection: Load failed') })
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => {
      root.render(<LiveListing shop={{ shop_id: 'HZ', brand: 'HOUZE' } as never} onQueueChange={() => {}} />)
    })
    await tick()
    expect(el.textContent).toContain('HOUZE stream')
    await act(async () => {
      root.render(<LiveListing shop={{ shop_id: 'TM', brand: 'TABLE MATTERS' } as never} onQueueChange={() => {}} />)
    })
    await tick()
    expect(el.textContent).not.toContain('HOUZE stream')
    expect(el.textContent).toContain('Try again')
    root.unmount()
  })
})
