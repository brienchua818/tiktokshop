// @vitest-environment happy-dom
/**
 * A listing renamed on TikTok shows its new name in the picker.
 *
 * Brien, 17 Oct: renaming a listing in Seller Center never reached the app;
 * the name was copied once, when the listing was added.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { listingNames } = vi.hoisted(() => ({ listingNames: vi.fn() }))
vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      listings: vi.fn(async () => [
        { listing_id: '1001', shop_id: 'HZ', brand: 'HOUZE', product_name: 'Old name', supplier: '', created_at: '' },
        { listing_id: '1002', shop_id: 'HZ', brand: 'HOUZE', product_name: 'Unchanged', supplier: '', created_at: '' },
      ]),
      listingNames,
    },
  }
})
vi.mock('./ListingDetail', () => ({ default: () => <div>DETAIL</div> }))

import LiveListing from './LiveListing'

async function render() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  await act(async () => {
    createRoot(el).render(<LiveListing shop={{ shop_id: 'HZ', brand: 'HOUZE' } as never} onQueueChange={() => {}} />)
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return el
}

describe('listing names in the picker', () => {
  beforeEach(() => { document.body.innerHTML = ''; listingNames.mockReset() })

  it("shows TikTok's current name once it has been read", async () => {
    listingNames.mockResolvedValue({ names: [{ listing_id: '1001', product_name: 'New name from Seller Center' }], checked_at: '' })
    const el = await render()
    expect(el.textContent).toContain('New name from Seller Center')
    expect(el.textContent).not.toContain('Old name')
    expect(el.textContent).toContain('Unchanged')
  })

  it('keeps the saved names when TikTok cannot be asked (or the backend is older)', async () => {
    listingNames.mockRejectedValue(new Error('Unknown action: listingNames'))
    const el = await render()
    expect(el.textContent).toContain('Old name')
    expect(el.textContent).not.toMatch(/Unknown action/)
  })
})
