import { describe, it, expect } from 'vitest'
import type { Tally } from '../lib/api'
import { otherBuckets, netOf, netValueOf, bucketText, tallyOf } from './tally'

function tally(over: Partial<Tally> = {}): Tally {
  return {
    ordered_units: 0, ordered_value: 0,
    sold_units: 0, sold_value: 0,
    cancelled_units: 0, cancelled_value: 0,
    refunded_units: 0, refunded_value: 0,
    at_risk_units: 0, at_risk_value: 0,
    held_units: 0, held_value: 0,
    unknown_units: 0, unknown_value: 0,
    ...over,
  }
}

describe('the buckets are disjoint and complete', () => {
  it('total minus every other bucket is the net figure', () => {
    const t = tally({
      ordered_units: 10, sold_units: 3,
      cancelled_units: 2, refunded_units: 1,
      at_risk_units: 1, held_units: 2, unknown_units: 1,
    })
    expect(netOf(t)).toBe(t.sold_units)
  })

  it('does the same subtraction in money', () => {
    const t = tally({
      ordered_value: 100, sold_value: 30,
      cancelled_value: 20, refunded_value: 10,
      at_risk_value: 10, held_value: 20, unknown_value: 10,
    })
    expect(netValueOf(t)).toBe(t.sold_value)
  })

  /**
   * The one that would have caught the bug this file exists for.
   *
   * A refunded unit leaves `sold_units` without entering `cancelled_units`.
   * Subtracting only cancelled — which is what "net sold = total sold −
   * total cancelled" says on its face — overstates net by exactly the units
   * nobody can see.
   */
  it('subtracting only cancelled overstates net when a unit was refunded', () => {
    const t = tally({ ordered_units: 5, sold_units: 4, refunded_units: 1 })
    expect(t.ordered_units - t.cancelled_units).toBe(5)
    expect(netOf(t)).toBe(4)
    expect(bucketText(t)).toBe('1 refunded')
  })
})

describe('what a row names', () => {
  it('says nothing when there is nothing to say', () => {
    expect(otherBuckets(tally({ ordered_units: 3, sold_units: 3 }))).toEqual([])
    expect(bucketText(tally({ ordered_units: 3, sold_units: 3 }))).toBe('')
  })

  it('names them worst first', () => {
    const t = tally({ refunded_units: 1, at_risk_units: 2, held_units: 3, unknown_units: 4 })
    expect(bucketText(t)).toBe('1 refunded · 2 returning · 3 on hold · 4 unconfirmed')
  })

  it('never names an empty bucket', () => {
    expect(bucketText(tally({ held_units: 2 }))).toBe('2 on hold')
  })
})

/**
 * The paste window.
 *
 * Netlify deploys on push; the backend is pasted by hand afterwards. For the
 * minutes in between, a live phone is talking to a backend that does not send
 * these fields — and a screen that dereferences one is a white page mid-stream.
 */
describe('a response from a backend older than the app', () => {
  it('reads every missing figure as zero rather than throwing', () => {
    const t = tallyOf(undefined)
    expect(netOf(t)).toBe(0)
    expect(bucketText(t)).toBe('')
    expect(Object.values(t).every((v) => v === 0)).toBe(true)
  })

  it('keeps the figures it did send', () => {
    expect(tallyOf({ ordered_units: 4, sold_units: 3 }).ordered_units).toBe(4)
    expect(tallyOf({ ordered_units: 4, sold_units: 3 }).cancelled_units).toBe(0)
  })

  it('refuses a NaN that would render as "NaN sold"', () => {
    expect(tallyOf({ sold_units: Number('x') }).sold_units).toBe(0)
  })
})
