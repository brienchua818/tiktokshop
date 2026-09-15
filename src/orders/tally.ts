import type { Tally } from '../lib/api'

export interface Bucket {
  label: string
  units: number
}

/**
 * Everything a unit can be, beyond sold and cancelled.
 *
 * Sold and cancelled have their own place on the screen. These four do not,
 * and until 15 Sep they had none anywhere: a refunded unit left `units`
 * without entering `unsold_units`, so it simply stopped being on the page.
 * That is the shape of the bug Brien reported as "1 left of 5, but 6 sold" —
 * a figure that does not reconcile and no column that says why.
 *
 * Returned in the order they cost money: the buyer already has it back, then
 * has asked for it back, then could still ask, then we do not know.
 */
export function otherBuckets(t: Tally): Bucket[] {
  return [
    { label: 'refunded', units: t.refunded_units },
    { label: 'returning', units: t.at_risk_units },
    { label: 'on hold', units: t.held_units },
    { label: 'unconfirmed', units: t.unknown_units },
  ].filter((b) => b.units > 0)
}

/**
 * What total sold minus every other bucket comes to.
 *
 * Equals `sold_units` when the buckets are disjoint and complete, which is the
 * only condition under which the six figures on the export add up. Exposed so
 * a test can assert it rather than a reader having to trust it.
 */
export function netOf(t: Tally): number {
  return (
    t.ordered_units -
    t.cancelled_units -
    t.refunded_units -
    t.at_risk_units -
    t.held_units -
    t.unknown_units
  )
}

/** The same subtraction in money. */
export function netValueOf(t: Tally): number {
  return (
    t.ordered_value -
    t.cancelled_value -
    t.refunded_value -
    t.at_risk_value -
    t.held_value -
    t.unknown_value
  )
}

/** "1 refunded · 2 on hold", or '' when there is nothing to say. */
export function bucketText(t: Tally): string {
  return otherBuckets(t)
    .map((b) => `${b.units} ${b.label}`)
    .join(' · ')
}

/**
 * A tally from a response that may predate it.
 *
 * Netlify redeploys the moment a commit lands; the Apps Script backend is
 * pasted into the editor by hand, minutes or hours later. Between the two
 * there is a live app talking to a backend that does not yet send these
 * fields, and a screen that dereferences one of them is a white page during
 * that window — on the phones being used on a broadcast.
 *
 * So every new field is read through here: missing means zero, and an old
 * backend degrades to showing nothing extra rather than to showing nothing.
 */
export function tallyOf(t: Partial<Tally> | null | undefined): Tally {
  const n = (v: number | undefined) => (typeof v === 'number' && isFinite(v) ? v : 0)
  const t2 = t || {}
  return {
    ordered_units: n(t2.ordered_units), ordered_value: n(t2.ordered_value),
    sold_units: n(t2.sold_units), sold_value: n(t2.sold_value),
    cancelled_units: n(t2.cancelled_units), cancelled_value: n(t2.cancelled_value),
    refunded_units: n(t2.refunded_units), refunded_value: n(t2.refunded_value),
    at_risk_units: n(t2.at_risk_units), at_risk_value: n(t2.at_risk_value),
    held_units: n(t2.held_units), held_value: n(t2.held_value),
    unknown_units: n(t2.unknown_units), unknown_value: n(t2.unknown_value),
  }
}
