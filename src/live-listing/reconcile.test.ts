import { describe, expect, it } from 'vitest'
import type { ListingState, LiveVariant } from '../lib/api'
import type { QueuedDraft } from '../offline/queue'
import { driftedDrafts, isRemoved, landed, mergeRows, soldOut, splitRows } from './reconcile'

function variant(over: Partial<LiveVariant>): LiveVariant {
  return {
    identifier: 'B9',
    variant: 'B9 Off White Wireless Mouse',
    price: '999',
    status: 'pushed',
    external: false,
    tiktok_sku_id: '1737387226619348974',
    image_url: '',
    created_at: '',
    created_by: '',
    on_tiktok: false,
    under_review: true,
    unaccounted: false,
    removed: false,
    stock_set: 1,
    stock_available: null,
    sold: null,
    ...over,
  }
}

function state(variants: LiveVariant[]): ListingState {
  return {
    listing_id: '1734903629786286062',
    product_status: 'ACTIVATE',
    audit_reasons: [],
    sku_count: variants.length,
    max_skus: 100,
    variants,
  } as unknown as ListingState
}

function draft(over: Partial<QueuedDraft>): QueuedDraft {
  return {
    draft_id: 'd1',
    shop_id: 'HZ',
    listing_id: '1734903629786286062',
    identifier: 'B9',
    title: 't',
    variant_name: 'v',
    price: '999',
    stock: 1,
    weight_kg: '1',
    created_at: '2026-09-07T04:14:00.000Z',
    idempotency_key: 'k',
    status: 'failed',
    error: 'No connection: Load failed',
    attempts: 1,
    retryAfter: 0,
    settled: false,
    ...over,
  } as unknown as QueuedDraft
}

describe('landed — did the backend record it?', () => {
  it('counts a variation the backend recorded even while TikTok still reviews it', () => {
    // This is B9: recorded 12:14:17, not yet returned by TikTok, reply lost.
    expect(landed(state([variant({ on_tiktok: false, under_review: true })]), 'B9')).not.toBeNull()
  })
  it('counts one TikTok already shows', () => {
    expect(landed(state([variant({ on_tiktok: true, under_review: false })]), 'B9')).not.toBeNull()
  })
  it('ignores a variation added outside this app, even with the same name', () => {
    expect(landed(state([variant({ external: true })]), 'B9')).toBeNull()
  })
  it('is null when the backend has no such row, or there is no state yet', () => {
    expect(landed(state([variant({ identifier: 'B8' })]), 'B9')).toBeNull()
    expect(landed(null, 'B9')).toBeNull()
  })
})

describe('driftedDrafts — local "failed", backend "pushed"', () => {
  const live = state([variant({})])

  it('finds the failed draft whose push actually landed', () => {
    expect(driftedDrafts([draft({})], live).map((d) => d.draft_id)).toEqual(['d1'])
  })
  it('finds a queued draft that has been attempted', () => {
    expect(driftedDrafts([draft({ status: 'queued', attempts: 2 })], live)).toHaveLength(1)
  })
  it('leaves a never-attempted draft alone even if the identifier is live', () => {
    expect(driftedDrafts([draft({ status: 'queued', attempts: 0 })], live)).toHaveLength(0)
  })
  it('leaves pushed drafts and unrelated identifiers alone', () => {
    expect(driftedDrafts([draft({ status: 'pushed' }), draft({ draft_id: 'd2', identifier: 'B10' })], live)).toHaveLength(0)
  })
  it('does nothing without live state', () => {
    expect(driftedDrafts([draft({})], null)).toHaveLength(0)
  })
})

describe('mergeRows — every phone shows the same listing', () => {
  const mine = draft({ draft_id: 'd-b9', identifier: 'B9', status: 'pushed', created_at: '2026-09-07T04:14:00Z' })
  const fromOtherPhone = variant({ identifier: 'L11', variant: 'L11 Trolley', created_at: '2026-09-07T13:50:00Z', on_tiktok: true, created_by: 'Judy' })
  const mineLive = variant({ identifier: 'B9', on_tiktok: true, created_at: '2026-09-07T04:14:00Z' })
  const sellerCenter = variant({ identifier: '', variant: 'Diatomite Absorbent Mat', external: true, on_tiktok: true, created_at: '' })

  it('shows a variation pushed from another phone, which the old list dropped', () => {
    const rows = mergeRows([mine], state([mineLive, fromOtherPhone]))
    expect(rows.map((r) => (r.kind === 'draft' ? r.draft.identifier : r.live.identifier))).toEqual(['B9', 'L11'])
    expect(rows[1]!.kind).toBe('remote')
  })
  it('does not duplicate a variation this phone already has as a draft', () => {
    const rows = mergeRows([mine], state([mineLive]))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('draft')
    expect((rows[0] as { live: LiveVariant | null }).live?.on_tiktok).toBe(true)
  })
  it('orders by creation time across phones, Seller Center last', () => {
    const later = draft({ draft_id: 'd-b12', identifier: 'B12', status: 'queued', created_at: '2026-09-07T14:00:00Z' })
    const rows = mergeRows([later, mine], state([mineLive, fromOtherPhone, sellerCenter]))
    expect(rows.map((r) => (r.kind === 'draft' ? r.draft.identifier : r.live.identifier || r.live.variant)))
      .toEqual(['B9', 'L11', 'B12', 'Diatomite Absorbent Mat'])
  })
  it('works with no live state yet: local drafts only', () => {
    expect(mergeRows([mine], null)).toHaveLength(1)
  })
})

describe('splitRows', () => {
  it('sends a removed remote variation to the removed side', () => {
    const rows = mergeRows([], state([
      variant({ identifier: 'B1', on_tiktok: false, under_review: false, removed: true, created_at: '2026-09-07T01:00:00.000Z' }),
      variant({ identifier: 'L1', on_tiktok: true, under_review: false, stock_available: 2, created_at: '2026-09-07T02:00:00.000Z' }),
    ]))
    const { active, removed } = splitRows(rows)
    expect(removed.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['B1'])
    expect(active.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['L1'])
  })

  it('sends a pushed draft whose variation was removed to the removed side', () => {
    // The draft still reads "pushed", because it was. What changed happened on
    // TikTok, so the answer is on the live record and nowhere else.
    const d = draft({ identifier: 'B1', status: 'pushed' })
    const rows = mergeRows([d], state([variant({ identifier: 'B1', removed: true, on_tiktok: false, under_review: false })]))
    const { active, removed } = splitRows(rows)
    expect(active).toHaveLength(0)
    expect(removed).toHaveLength(1)
    expect(removed[0]!.kind).toBe('draft')
  })

  it('keeps a draft with no live record on the active side', () => {
    // Nothing has been removed; it simply has not been checked yet.
    const rows = mergeRows([draft({ identifier: 'B13', status: 'queued' })], null)
    expect(splitRows(rows).removed).toHaveLength(0)
    expect(splitRows(rows).active).toHaveLength(1)
  })

  it('preserves order within each side', () => {
    const rows = mergeRows([], state([
      variant({ identifier: 'A', removed: true, on_tiktok: false, under_review: false, created_at: '2026-09-07T03:00:00.000Z' }),
      variant({ identifier: 'B', on_tiktok: true, under_review: false, stock_available: 1, created_at: '2026-09-07T01:00:00.000Z' }),
      variant({ identifier: 'C', removed: true, on_tiktok: false, under_review: false, created_at: '2026-09-07T02:00:00.000Z' }),
    ]))
    const { active, removed } = splitRows(rows)
    expect(removed.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['C', 'A'])
    expect(active.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['B'])
  })

  it('isRemoved answers for both kinds of row', () => {
    const remote = mergeRows([], state([variant({ removed: true, on_tiktok: false, under_review: false })]))[0]!
    expect(isRemoved(remote)).toBe(true)
  })
})

describe('soldOut', () => {
  it('is true when a confirmed variation has nothing left', () => {
    expect(soldOut(variant({ on_tiktok: true, under_review: false, stock_set: 2, stock_available: 0 }))).toBe(true)
  })

  it('is false while stock remains', () => {
    expect(soldOut(variant({ on_tiktok: true, under_review: false, stock_set: 2, stock_available: 1 }))).toBe(false)
  })

  it('is false for a variation under review, which reports no stock at all', () => {
    // Absence of a quantity is not a quantity of zero. Reading it as sold out
    // would put a red label on something that has never been on sale.
    expect(soldOut(variant({ on_tiktok: false, under_review: true, stock_available: null }))).toBe(false)
  })

  it('is false for a removed variation', () => {
    // It has its own tab and its own label; "sold out" would be a second,
    // contradictory explanation of the same row.
    expect(soldOut(variant({ removed: true, on_tiktok: false, under_review: false, stock_available: 0 }))).toBe(false)
  })

  it('is false for a variation that was never stocked', () => {
    expect(soldOut(variant({ on_tiktok: true, under_review: false, stock_set: 0, stock_available: 0 }))).toBe(false)
  })

  it('is true for an external variation at zero, which has no stock_set to check', () => {
    expect(soldOut(variant({ external: true, on_tiktok: true, under_review: false, stock_set: null, stock_available: 0 }))).toBe(true)
  })
})
