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
        // A variation listed outside this app has no creation time we know.
        // Empty rather than a high sentinel: '9999' sorted FIRST in a
        // newest-first comparison, putting undated rows at the top of a list
        // whose whole promise is that the top is the newest. Externals are
        // already forced last by the side check below, so the sentinel was
        // doing nothing it was meant to and something it was not.
        sortKey: v.created_at || '',
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

    /**
     * Compared as instants, not as text.
     *
     * `localeCompare` on a timestamp only works while the timestamp is ISO,
     * and the backend was sending `String(<Date from a Sheet cell>)` —
     * "Sun Sep 13 2026 22:00:00 GMT+0800". Sorting those as text sorts by
     * WEEKDAY NAME, which put the 13th above the 14th. The backend now emits
     * ISO, and this no longer depends on it doing so.
     */
    const at = Date.parse(a.sortKey)
    const bt = Date.parse(b.sortKey)
    if (!isNaN(at) && !isNaN(bt) && at !== bt) return bt - at
    // One of them is undated: dated rows first, so an unknown time cannot
    // claim the top of a newest-first list.
    if (isNaN(at) !== isNaN(bt)) return isNaN(at) ? 1 : -1

    /**
     * A tiebreaker, so the order cannot change between two renders.
     *
     * Two variations pushed in the same second share a sortKey, and a stable
     * sort then preserves whatever order they arrived in — which is TikTok's,
     * and TikTok does not promise one. So the list reshuffled whenever it was
     * rebuilt, which is what Brien saw switching to the Removed tab and back.
     *
     * The identifier is the tiebreaker because it is the one thing every row
     * has, it is what the host says out loud, and its sequence IS the order
     * things were listed in. Compared numerically, or B9 would sit above B75.
     */
    return identifierRank(rowIdentifier(b)) - identifierRank(rowIdentifier(a))
  })
}

/** The identifier a row shows, from whichever half of the union it is. */
function rowIdentifier(r: QueueRow): string {
  return r.kind === 'draft' ? r.draft.identifier : r.live.identifier
}

/**
 * An identifier as a number, for ordering. "B75" ranks above "B9".
 *
 * Text comparison puts B9 after B75 because '9' > '7', which is the wrong way
 * round for a sequence somebody counts upwards. Anything with no number in it
 * ranks lowest rather than throwing off the rows that do.
 */
function identifierRank(identifier: string): number {
  const digits = /(\d+)\s*$/.exec(String(identifier || ''))
  return digits ? Number(digits[1]) : -1
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
 * Buyable and nothing left. Both halves matter: a variation still in review
 * reports no quantity at all, and reading that absence as "sold out" would put
 * a red label on something that has never been on sale.
 *
 * This used to also consult the stored figure, to avoid calling a variation
 * sold out when it had never been stocked. It does not need to any more — the
 * quantity comes from the version buyers see, so zero there means zero for
 * sale — and that dependency is what made a cancellation need a special case.
 * TikTok returns the units, `stock_available` rises, and this goes false by
 * itself.
 */
export function soldOut(v: LiveVariant): boolean {
  return v.buyable && v.stock_available === 0
}

/**
 * Whether "of N" can honestly be shown beside the stock left.
 *
 * It always can now, when there is a quantity at all, because the total is
 * derived rather than remembered: `available + sold`, computed by the backend
 * from the version buyers see and the order lines. Those two move together, so
 * the pair cannot contradict each other.
 *
 * It could not before. The denominator was the figure the app asked for when
 * it first listed the variation, and nothing kept it current — which produced
 * "11 left of 1" on 8 Sep after a top-up in Seller Centre, and "1 left of 5 ·
 * 6 sold" on 15 Sep, a row that cannot describe anything real. Six sold and
 * one left means seven were available.
 *
 * Kept as a function rather than inlined because "can this number be shown"
 * has been wrong twice, and one place to ask is one place to fix.
 */
export function showsOriginalTotal(v: LiveVariant): boolean {
  return v.stock_total !== null && v.stock_total > 0
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
