import { describe, expect, it } from 'vitest'
import type { ListingState, LiveVariant } from '../lib/api'
import type { QueuedDraft } from '../offline/queue'
import {
  draftsTakenOver,
  driftedDrafts,
  isRemoved,
  landed,
  mergeRows,
  nameWithoutIdentifier,
  showsOriginalTotal,
  soldOut,
  splitRows,
} from './reconcile'

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
    cancelled: null,
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
    // After every draft fixture's created_at, so "the backend has looked since
    // this was pushed" is the default and a test that needs the opposite says so.
    checked_at: '2026-09-15T10:00:00.000Z',
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
    // Newest first: L11 was created after B9.
    expect(rows.map((r) => (r.kind === 'draft' ? r.draft.identifier : r.live.identifier))).toEqual(['L11', 'B9'])
    // The other phone's variation is the newer one, so it now leads.
    expect(rows[0]!.kind).toBe('remote')
  })
  it('does not duplicate a variation this phone already has as a draft', () => {
    const rows = mergeRows([mine], state([mineLive]))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('draft')
    expect((rows[0] as { live: LiveVariant | null }).live?.on_tiktok).toBe(true)
  })
  it('orders newest first across phones, Seller Center last', () => {
    const later = draft({ draft_id: 'd-b12', identifier: 'B12', status: 'queued', created_at: '2026-09-07T14:00:00Z' })
    const rows = mergeRows([later, mine], state([mineLive, fromOtherPhone, sellerCenter]))
    expect(rows.map((r) => (r.kind === 'draft' ? r.draft.identifier : r.live.identifier || r.live.variant)))
      // Newest first, and Seller Center last whatever its age: it has no
      // creation time we know, so guessing one would scatter such rows through
      // the list instead of keeping them together at the end.
      .toEqual(['B12', 'L11', 'B9', 'Diatomite Absorbent Mat'])
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
    const { active, removed } = splitRows(rows, null)
    expect(removed.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['B1'])
    expect(active.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['L1'])
  })

  it('sends a pushed draft whose variation was removed to the removed side', () => {
    // The draft still reads "pushed", because it was. What changed happened on
    // TikTok, so the answer is on the live record and nowhere else.
    const d = draft({ identifier: 'B1', status: 'pushed' })
    const rows = mergeRows([d], state([variant({ identifier: 'B1', removed: true, on_tiktok: false, under_review: false })]))
    const { active, removed } = splitRows(rows, null)
    expect(active).toHaveLength(0)
    expect(removed).toHaveLength(1)
    expect(removed[0]!.kind).toBe('draft')
  })

  it('keeps a draft with no live record on the active side', () => {
    // Nothing has been removed; it simply has not been checked yet.
    const rows = mergeRows([draft({ identifier: 'B13', status: 'queued' })], null)
    expect(splitRows(rows, null).removed).toHaveLength(0)
    expect(splitRows(rows, null).active).toHaveLength(1)
  })

  it('preserves order within each side', () => {
    const rows = mergeRows([], state([
      variant({ identifier: 'A', removed: true, on_tiktok: false, under_review: false, created_at: '2026-09-07T03:00:00.000Z' }),
      variant({ identifier: 'B', on_tiktok: true, under_review: false, stock_available: 1, created_at: '2026-09-07T01:00:00.000Z' }),
      variant({ identifier: 'C', removed: true, on_tiktok: false, under_review: false, created_at: '2026-09-07T02:00:00.000Z' }),
    ]))
    const { active, removed } = splitRows(rows, null)
    // Newest first within each side: A is 03:00, C is 02:00.
    expect(removed.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['A', 'C'])
    expect(active.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['B'])
  })

  it('isRemoved answers for both kinds of row', () => {
    const remote = mergeRows([], state([variant({ removed: true, on_tiktok: false, under_review: false })]))[0]!
    expect(isRemoved(remote, null)).toBe(true)
  })

  /**
   * The regression that showed 19 variations on a listing carrying 3.
   *
   * `listingState` stopped sending removed variations on 15 Sep, so the flag
   * these rows were read from stopped arriving and every one of them counted
   * as on the listing. The absence has to be read instead — but only once the
   * backend has actually looked, which is what the time comparison is for.
   */
  describe('a pushed draft the backend does not return', () => {
    const live = state([variant({ identifier: 'B74', on_tiktok: true, under_review: false, stock_available: 8 })])

    it('is removed when the backend looked after it was pushed', () => {
      const d = draft({ identifier: 'B15', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
      const { active, removed } = splitRows(mergeRows([d], live), live)
      expect(removed).toHaveLength(1)
      expect(active.map((r) => (r.kind === 'remote' ? r.live.identifier : ''))).toEqual(['B74'])
    })

    it('is NOT removed when it was pushed after the backend looked', () => {
      // The race that would make a SKU vanish the moment it was listed.
      const d = draft({ identifier: 'B77', status: 'pushed', pushed_at: '2026-09-15T10:30:00.000Z' })
      expect(splitRows(mergeRows([d], live), live).removed).toHaveLength(0)
    })

    it('falls back to created_at for a draft pushed before pushed_at existed', () => {
      // Brien's sixteen. No pushed_at, created days ago, so plainly older than
      // any read — and the fallback is earlier than the push, never later, so
      // it can only ever be more cautious about a fresh one.
      const d = draft({ identifier: 'B13', status: 'pushed', created_at: '2026-09-15T02:00:00.000Z' })
      expect(splitRows(mergeRows([d], live), live).removed).toHaveLength(1)
    })

    it('is NOT removed while the backend has not answered', () => {
      // A failed or pending refresh must not empty the listing.
      const d = draft({ identifier: 'B15', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
      expect(splitRows(mergeRows([d], null), null).removed).toHaveLength(0)
    })

    it('leaves a draft that has not been pushed alone', () => {
      // Queued, retrying and failed drafts are work still to do, not history.
      for (const status of ['queued', 'uploading', 'failed'] as const) {
        const d = draft({ identifier: 'B80', status, pushed_at: undefined })
        expect(splitRows(mergeRows([d], live), live).removed).toHaveLength(0)
      }
    })

    it('leaves a pushed draft the backend DOES return alone, under review', () => {
      // Absence is the signal. A variation TikTok has not published yet is
      // still returned by the backend, so it is not absent.
      const reviewing = state([variant({ identifier: 'B78', on_tiktok: false, under_review: true })])
      const d = draft({ identifier: 'B78', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
      expect(splitRows(mergeRows([d], reviewing), reviewing).removed).toHaveLength(0)
    })
  })
})

/**
 * A draft the backend has taken over must stop being kept on the phone.
 *
 * This is what made two phones show different lists. Each phone renders the
 * server's variations plus its own drafts, and nothing removed a draft once it
 * had been pushed — so every phone carried a permanent private residue and no
 * two matched. A draft exists to survive a push that has not happened yet;
 * once the backend holds the record, keeping it means the same variation is
 * described twice and the two can disagree.
 */
describe('draftsTakenOver', () => {
  const live = state([
    variant({ identifier: 'B74', on_tiktok: true, under_review: false, stock_available: 8 }),
  ])

  it('hands over a pushed draft the backend confirms', () => {
    const d = draft({ identifier: 'B74', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
    expect(draftsTakenOver([d], live).map((x) => x.identifier)).toEqual(['B74'])
  })

  it('hands over a pushed draft the backend says is gone', () => {
    // Absent from a read taken after the push. The Removed tab is the record
    // now, so the phone has nothing left to hold.
    const d = draft({ identifier: 'B99', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
    expect(draftsTakenOver([d], live).map((x) => x.identifier)).toEqual(['B99'])
  })

  // The other half, and the half that matters: a draft still in flight is
  // exactly what the queue exists for, and losing one loses a SKU.
  it('keeps a draft pushed after the last read', () => {
    const d = draft({ identifier: 'B99', status: 'pushed', pushed_at: '2026-09-15T10:30:00.000Z' })
    expect(draftsTakenOver([d], live)).toHaveLength(0)
  })

  it('keeps queued, uploading and failed drafts', () => {
    for (const status of ['queued', 'uploading', 'failed'] as const) {
      const d = draft({ identifier: 'B99', status, pushed_at: undefined })
      expect(draftsTakenOver([d], live)).toHaveLength(0)
    }
  })

  it('keeps everything while the backend has not answered', () => {
    const d = draft({ identifier: 'B74', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
    expect(draftsTakenOver([d], null)).toHaveLength(0)
  })

  it('leaves the two phones with the same list', () => {
    // The whole point, stated as a test. Two phones, different drafts, one
    // backend: after each hands over what the backend holds, both render the
    // same rows from the same source.
    const mine = draft({ draft_id: 'a', identifier: 'B74', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
    const hers = draft({ draft_id: 'b', identifier: 'B75', status: 'pushed', pushed_at: '2026-09-15T09:00:00.000Z' })
    const shared = state([
      variant({ identifier: 'B74', on_tiktok: true, under_review: false, stock_available: 8 }),
      variant({ identifier: 'B75', on_tiktok: true, under_review: false, stock_available: 3 }),
    ])
    expect(draftsTakenOver([mine], shared)).toHaveLength(1)
    expect(draftsTakenOver([hers], shared)).toHaveLength(1)
    const afterMine = mergeRows([], shared).map((r) => (r.kind === 'remote' ? r.live.identifier : ''))
    const afterHers = mergeRows([], shared).map((r) => (r.kind === 'remote' ? r.live.identifier : ''))
    expect(afterMine).toEqual(afterHers)
    expect(afterMine.sort()).toEqual(['B74', 'B75'])
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

describe('showsOriginalTotal', () => {
  it("hides the total once TikTok holds more than the app ever listed", () => {
    // Brien's B15 on 8 Sep: listed with 1, ten added in Seller Center, and the
    // row read "11 left of 1". The 11 was correct and current; the "of 1" was
    // a stale intention shown as a total.
    expect(showsOriginalTotal(variant({ stock_set: 1, stock_available: 11 }))).toBe(false)
  })

  it('shows it while it can still be true', () => {
    expect(showsOriginalTotal(variant({ stock_set: 50, stock_available: 48 }))).toBe(true)
    // Equal is fine: nothing has sold and nothing has been added.
    expect(showsOriginalTotal(variant({ stock_set: 2, stock_available: 2 }))).toBe(true)
  })

  it('hides it when there is nothing to compare', () => {
    // A Seller Center variation has no stock_set at all, and a variation under
    // review has no available figure yet.
    expect(showsOriginalTotal(variant({ external: true, stock_set: null, stock_available: 4 }))).toBe(false)
    expect(showsOriginalTotal(variant({ stock_set: 5, stock_available: null }))).toBe(false)
    expect(showsOriginalTotal(variant({ stock_set: 0, stock_available: 0 }))).toBe(false)
  })
})

describe('nameWithoutIdentifier', () => {
  it('drops the identifier the app prefixed onto the name', () => {
    // The queue was printing "A1  A1 Ceramic Serving Bowl" on the one line
    // where width is worth most.
    expect(nameWithoutIdentifier('A1 Ceramic Serving Bowl', 'A1')).toBe('Ceramic Serving Bowl')
    expect(nameWithoutIdentifier('L12 Cat trolley in pink', 'L12')).toBe('Cat trolley in pink')
    expect(nameWithoutIdentifier('B15 - Showroom Lamp', 'B15')).toBe('Showroom Lamp')
    expect(nameWithoutIdentifier('b15 showroom lamp', 'B15')).toBe('showroom lamp')
  })

  it('leaves a name alone when the match is not a whole token', () => {
    // "L1" must not eat the "2" off "L12 Rattan Basket".
    expect(nameWithoutIdentifier('L12 Rattan Basket', 'L1')).toBe('L12 Rattan Basket')
    expect(nameWithoutIdentifier('A1000 Trolley', 'A1')).toBe('A1000 Trolley')
  })

  it('never returns an empty name', () => {
    // A variation named only by its identifier keeps it rather than vanishing.
    expect(nameWithoutIdentifier('A1', 'A1')).toBe('A1')
    expect(nameWithoutIdentifier('A1 ', 'A1')).toBe('A1')
    expect(nameWithoutIdentifier('', 'A1')).toBe('')
    expect(nameWithoutIdentifier('Ceramic Bowl', '')).toBe('Ceramic Bowl')
  })

  it('leaves an unrelated name alone', () => {
    expect(nameWithoutIdentifier('Ceramic Serving Bowl', 'A1')).toBe('Ceramic Serving Bowl')
  })
})
