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
 * Drafts the backend has taken over, which this phone should stop keeping.
 *
 * **Why two phones showed different rows.**
 *
 * The list each phone draws is the server's variations plus that phone's own
 * drafts. A draft is written locally when a SKU is added, and `removeDraft` is
 * called from exactly one place — the operator's delete button. So nothing
 * ever removed a draft once it had been pushed, and every phone accumulated a
 * permanent private residue of everything it had ever listed. Brien's phone
 * carried sixteen from an old test run; Wen Xuan's carried her own. Neither
 * list was wrong about the server, and neither matched the other.
 *
 * A draft exists to survive a push that has not happened yet. Once the backend
 * holds the record, the draft has no job left: keeping it means the same
 * variation is described in two places, and the two can disagree.
 *
 * So a pushed draft is deleted as soon as the backend has SPOKEN about it —
 * either it is in the listing state (confirmed), or the read is newer than the
 * push and it is absent (removed, which the Removed tab now records instead).
 * Both are the backend taking ownership. What is NOT pruned is anything still
 * in flight: queued, uploading, failed, or pushed so recently that no read has
 * covered it. Those are exactly the drafts the queue exists for.
 */
export function draftsTakenOver(
  drafts: readonly QueuedDraft[],
  live: ListingState | null,
): QueuedDraft[] {
  if (!live) return []
  return drafts.filter((d) => {
    if (d.status !== 'pushed') return false
    if (landed(live, d.identifier)) return true
    // Absent. Only meaningful once a read has happened since the push — the
    // same rule isRemoved uses, and for the same reason: a SKU pushed after
    // the last refresh is legitimately missing from it.
    const pushedAt = d.pushed_at ?? d.created_at
    return Boolean(pushedAt) && pushedAt < live.checked_at
  })
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
  /**
   * Newest first.
   *
   * Brien, 15 Sep: "new listings pushed should appear on the top". Obvious in
   * hindsight — the thing you just pushed is the thing you want to check, and
   * on a listing carrying a hundred variations the newest one was a hundred
   * rows down. It was oldest-first because the queue began life as a to-do
   * list, where that was right; it is now a record of what is on the listing,
   * where it is not.
   *
   * Variations added outside the app still sort last: they have no creation
   * time we know, and guessing one would scatter them through the list.
   */
  return rows.sort((a, b) => {
    const external = (r: QueueRow) => (r.kind === 'remote' && r.live.external ? 1 : 0)
    const side = external(a) - external(b)
    if (side !== 0) return side
    return b.sortKey.localeCompare(a.sortKey)
  })
}

/**
 * Whether a row is a variation that has been taken off TikTok.
 *
 * A draft row carries the answer on its live record, not on itself: the draft
 * still says "pushed", because it was, and what changed happened on TikTok.
 * So both kinds are asked the same question of the same field.
 */
export function isRemoved(row: QueueRow, live: ListingState | null): boolean {
  if (row.kind === 'remote') return Boolean(row.live.removed)
  if (row.live) return Boolean(row.live.removed)

  /**
   * A pushed draft the backend does not return has been removed.
   *
   * `listingState` used to send removed variations and the screen read
   * `row.live.removed`. On 15 Sep they moved to their own tab and stopped
   * being sent — at which point `row.live` for a removed variation became
   * null, `row.live?.removed` became undefined, and every one of them counted
   * as ON the listing. Brien's phone then showed 19 on a listing carrying 3,
   * because sixteen drafts from an old test run were still in its local queue.
   *
   * So the absence has to be read, not the flag. The backend returns every row
   * it holds for this listing except the removed ones, and drafts here are
   * already scoped to this listing — so a pushed draft it does not return is
   * one it has marked removed.
   *
   * Guarded on time, because absence means nothing before the backend has
   * looked: a SKU pushed after the last refresh is legitimately missing from
   * it, and hiding it would make a variation vanish the moment it was listed.
   * Only a push the backend's own read happened AFTER can be judged this way.
   * Drafts pushed before `pushed_at` existed fall back to when they were
   * created, which is earlier still and so never judges a fresh push.
   */
  if (!live || row.draft.status !== 'pushed') return false
  const pushedAt = row.draft.pushed_at ?? row.draft.created_at
  return Boolean(pushedAt) && pushedAt < live.checked_at
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
export function splitRows(
  rows: readonly QueueRow[],
  live: ListingState | null,
): { active: QueueRow[]; removed: QueueRow[] } {
  const active: QueueRow[] = []
  const removed: QueueRow[] = []
  for (const row of rows) (isRemoved(row, live) ? removed : active).push(row)
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

/**
 * Whether "of N" can honestly be shown beside the stock left.
 *
 * `stock_set` is what THIS APP asked for when it listed the variation. It is
 * not what TikTok holds now, and nothing keeps the two in step: raising stock
 * in Seller Center leaves the Sheet untouched.
 *
 * Brien, 8 Sep: B15 was listed with 1, he added 10 in Seller Center, and the
 * row read **"11 left of 1"**. The 11 was right, freshly read from TikTok. The
 * "of 1" was a stale record of an old intention presented as a current total,
 * and it read as nonsense — which is worse than reading as nothing.
 *
 * So the denominator is shown only while it can still be true. Once TikTok
 * holds more than the app ever listed, the app does not know the real total —
 * `available + sold` does not recover it either, because a cancelled unit may
 * or may not have returned to stock — so it says "11 left" and stops there.
 */
export function showsOriginalTotal(v: LiveVariant): boolean {
  if (v.stock_set === null || v.stock_set <= 0) return false
  if (v.stock_available === null) return false
  return v.stock_available <= v.stock_set
}

/**
 * The variant name with its identifier taken off the front.
 *
 * Every variant name this app sends to TikTok is prefixed with the identifier,
 * because that is what a buyer sees in the picker and how a factory matches a
 * box to a row. Which means the queue was printing it twice: "A1  A1 Ceramic
 * Serving Bowl", on the one line where width is worth most.
 *
 * Only a leading, whole-token match is removed, so a name that genuinely
 * begins with something similar is left alone: "L1" does not strip "L12", and
 * a name that is nothing but its identifier keeps it rather than becoming
 * blank.
 */
export function nameWithoutIdentifier(name: string, identifier: string): string {
  const id = identifier.trim()
  const full = name.trim()
  if (!id || !full) return full
  if (!full.toUpperCase().startsWith(id.toUpperCase())) return full
  const rest = full.slice(id.length)
  // A whole token: the next character has to be a separator, or there was none.
  if (rest && !/^[\s\-–—:·,.]/.test(rest)) return full
  const trimmed = rest.replace(/^[\s\-–—:·,.]+/, '').trim()
  return trimmed || full
}
