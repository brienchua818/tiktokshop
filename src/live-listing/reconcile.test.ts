import { describe, expect, it } from 'vitest'
import type { ListingState, LiveVariant } from '../lib/api'
import type { QueuedDraft } from '../offline/queue'
import { driftedDrafts, landed } from './reconcile'

function variant(over: Partial<LiveVariant>): LiveVariant {
  return {
    identifier: 'B9',
    variant: 'B9 Off White Wireless Mouse',
    price: '999',
    status: 'pushed',
    external: false,
    tiktok_sku_id: '1737387226619348974',
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
