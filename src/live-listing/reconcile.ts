import type { LiveVariant, ListingState } from '../lib/api'
import type { QueuedDraft } from '../offline/queue'

/**
 * Local drafts versus what the backend knows: the backend wins.
 *
 * A push is three things in sequence — the phone sends, the backend writes to
 * TikTok and records the row, the reply comes home. The third can fail alone:
 * B9 on 7 Sep was recorded at 12:14:17, seen live by 12:15:00, and shown on
 * the phone as "Failed · No connection: Load failed". The only party that
 * knows whether a write happened is the backend, and `listingState` carries
 * its answer: every variant it returns that is not `external` is a row the
 * backend recorded as pushed (or later removed) for this listing.
 *
 * So the question is never "is it on TikTok yet?" — a variation under review
 * is not returned by TikTok for minutes — but "did the backend record it?".
 * The first question is what the old check asked, and why B9 read as failed.
 */

/** Did the backend record this identifier as pushed for the listing? */
export function landed(live: ListingState | null, identifier: string): LiveVariant | null {
  if (!live) return null
  return live.variants.find((v) => !v.external && v.identifier === identifier) ?? null
}

/**
 * Drafts this device believes are not pushed, that the backend says are.
 *
 * Only drafts that have made at least one attempt qualify. A draft that has
 * never been sent and happens to share an identifier with a live variation
 * is a different problem (two devices, one identifier) and is left for the
 * push itself to refuse, not silently marked done.
 */
export function driftedDrafts(drafts: readonly QueuedDraft[], live: ListingState | null): QueuedDraft[] {
  if (!live) return []
  return drafts.filter(
    (d) =>
      d.status !== 'pushed' &&
      (d.status === 'failed' || d.status === 'uploading' || d.attempts > 0) &&
      landed(live, d.identifier) !== null,
  )
}

/**
 * One row of the queue as the screen shows it: either a draft on this phone,
 * or a variation the backend or TikTok knows about that this phone has no
 * draft for — pushed from another phone, or added in Seller Center.
 *
 * Before this the list was `drafts.map(...)`: only what THIS phone had made.
 * Two phones listing the same stream saw two different lists (7 Sep), and a
 * variation added in Seller Center appeared only in a footnote. The list is
 * now the union, ordered by when each was created, so every phone shows the
 * same listing.
 */
export type QueueRow =
  | { kind: 'draft'; key: string; draft: QueuedDraft; live: LiveVariant | null; sortKey: string }
  | { kind: 'remote'; key: string; live: LiveVariant; sortKey: string }

export function mergeRows(drafts: readonly QueuedDraft[], live: ListingState | null): QueueRow[] {
  const rows: QueueRow[] = drafts.map((d) => ({
    kind: 'draft',
    key: d.draft_id,
    draft: d,
    live: live?.variants.find((v) => !v.external && v.identifier === d.identifier) ?? null,
    sortKey: d.created_at,
  }))
  if (live) {
    const local = new Set(drafts.map((d) => d.identifier))
    for (const v of live.variants) {
      if (!v.external && local.has(v.identifier)) continue
      rows.push({
        kind: 'remote',
        key: `remote:${v.tiktok_sku_id || v.identifier || v.variant}`,
        live: v,
        // A variation listed outside this app has no creation time we know;
        // it sorts after everything dated, in TikTok's order.
        sortKey: v.created_at || '9999',
      })
    }
  }
  return rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
}

/**
 * Whether a row is a variation that has been taken off TikTok.
 *
 * A draft row carries the answer on its live record, not on itself: the draft
 * still says "pushed", because it was, and what changed happened on TikTok.
 * So both kinds are asked the same question of the same field.
 */
export function isRemoved(row: QueueRow): boolean {
  return row.kind === 'draft' ? Boolean(row.live?.removed) : Boolean(row.live.removed)
}

/**
 * The listing, split into what is on it and what has been taken off.
 *
 * Removed variations used to sit in the main list. On a 25-variation listing
 * that meant scrolling past five dead rows to reach the live ones, during a
 * broadcast, which is the worst possible time to be reading carefully. They
 * are not deleted from view though: a removal is a decision someone made, and
 * the record of it is worth keeping where it can be found.
 *
 * Order is preserved within each side, so the active list reads exactly as it
 * did before, minus the noise.
 */
export function splitRows(rows: readonly QueueRow[]): { active: QueueRow[]; removed: QueueRow[] } {
  const active: QueueRow[] = []
  const removed: QueueRow[] = []
  for (const row of rows) (isRemoved(row) ? removed : active).push(row)
  return { active, removed }
}

/**
 * Every unit of this variation is gone.
 *
 * Only meaningful once TikTok has confirmed the variation and told us a
 * quantity: a variation still under review reports no stock at all, and
 * reading that absence as "sold out" would put a red label on something that
 * has never been on sale. `stock_set` guards the other end — a variation
 * listed with no stock in the first place was never sold out, it was never
 * stocked.
 */
export function soldOut(v: LiveVariant): boolean {
  if (!v.on_tiktok || v.removed) return false
  if (v.stock_available === null || v.stock_available > 0) return false
  return v.external ? true : (v.stock_set ?? 0) > 0
}
