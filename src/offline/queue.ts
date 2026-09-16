import type { Draft, DraftStatus } from '../types'

/**
 * The offline queue.
 *
 * This is the single biggest improvement over the app being replaced, which
 * loses whatever was unsaved when factory Wi-Fi drops. Here the local queue is
 * the source of truth for unpushed work: a SKU is written to IndexedDB the
 * moment it is created, survives the app being closed, and pushes itself when
 * the connection returns.
 *
 * Exactly-once is the hard part. A push that times out may still have
 * succeeded on TikTok's side, so every item carries an `idempotency_key` that
 * TikTok honours — a retry with the same key returns the original product
 * rather than creating a second one.
 */

const DB_NAME = 'tikshop'
const DB_VERSION = 1
const STORE = 'drafts'
const PHOTOS = 'photos'

/** Attempts before an item stops retrying on its own and waits for a person. */
export const MAX_AUTO_ATTEMPTS = 5

/**
 * The `retryAfter` of an item that will never retry on its own.
 *
 * A rejection TikTok will repeat — a title too short, a missing attribute —
 * is parked the moment it arrives rather than retried five times, because
 * every attempt costs the shop's daily listing allowance and none of them can
 * succeed. Parked means WAITING FOR A PERSON, so anything carrying this must
 * show up in `needsAttention`.
 */
export const PARKED = Number.MAX_SAFE_INTEGER

export interface QueuedDraft extends Draft {
  /** How many push attempts have been made. */
  attempts: number
  /** Epoch ms before which this item should not be retried. */
  retryAfter: number
  /**
   * When this row's push started, so a stale in-flight marker can be told from
   * a live one without knowing when the reader happens to be running.
   */
  uploading_at?: number | null
  /** True once TikTok has confirmed the product. */
  settled: boolean
  /**
   * When the push succeeded, ISO. Absent on drafts pushed before this existed.
   *
   * Exists so the screen can tell "the backend has not heard about this yet"
   * from "the backend knows about it and says it is gone". Both look identical
   * from a draft alone — the difference is whether the backend's read happened
   * after the push, which needs a time on both sides.
   */
  pushed_at?: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'draft_id' })
        store.createIndex('by_listing', 'listing_id')
        store.createIndex('by_status', 'status')
      }
      if (!db.objectStoreNames.contains(PHOTOS)) {
        // Photos live in their own store so reading the queue does not pull
        // every image into memory with it.
        db.createObjectStore(PHOTOS)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'))
  })
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const request = run(transaction.objectStore(storeName))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Local database write failed.'))
        transaction.oncomplete = () => db.close()
      }),
  )
}

export async function enqueue(draft: Draft, photo: Blob | null): Promise<QueuedDraft> {
  const queued: QueuedDraft = { ...draft, attempts: 0, retryAfter: 0, settled: false }
  await tx(STORE, 'readwrite', (store) => store.put(queued))
  if (photo) {
    await tx(PHOTOS, 'readwrite', (store) => store.put(photo, draft.draft_id))
  }
  return queued
}

export function getPhoto(draftId: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(PHOTOS, 'readonly', (store) => store.get(draftId))
}

/**
 * Every draft, oldest first.
 *
 * IndexedDB returns rows in key order, and the key is a random UUID — so
 * without this the list is in an order nobody chose (B5, B1, B2, B6, B3 on
 * a real stream). Sorted here rather than at each call site so no screen can
 * forget to.
 */
export async function allDrafts(): Promise<QueuedDraft[]> {
  const rows = await tx<QueuedDraft[]>(STORE, 'readonly', (store) => store.getAll())
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/**
 * How long an upload can be marked in-flight before it certainly is not.
 *
 * The push deadline is 120 seconds (api.ts, `timeoutMs: 120_000`), after which
 * the client aborts and writes an outcome. So a row still marked 'uploading'
 * well past that has no request behind it, whatever else is true.
 */
export const STALE_UPLOAD_MS = 150_000

/**
 * An upload that no longer has anything watching it.
 *
 * `status: 'uploading'` is written by the one function that performs a push,
 * and every path that clears it lives inside that same promise. So if the app
 * is closed, reloaded, or killed by iOS during the push window, the row stays
 * 'uploading' in IndexedDB with no writer left alive, and nothing picks it up
 * again: `dueForPush` and `nextBatch` both skip 'uploading' on purpose, so a
 * reconnect cannot double-push something already in flight.
 *
 * Telling those two apart is the whole problem, and the first version of this
 * got it wrong in the most dangerous direction. It reasoned "a row still
 * uploading when the app BOOTS cannot be in flight" — true — and was then
 * wired to a function that runs on a one-second interval and after every queue
 * change. So it did not revive orphans; it stripped the in-flight marker off
 * pushes that were still flying, one second in, and handed them straight back
 * to `dueForPush`. That turns the queue's only concurrency guard into a
 * duplicate-product machine.
 *
 * So the test is no longer WHEN this runs, but what the row itself says. A
 * push stamps `uploading_at` as it starts; a row is revivable only once that
 * stamp is older than the push can possibly still be running. Safe to call on
 * a timer, from another tab, or at startup, because it no longer depends on
 * the caller to be careful.
 *
 * A row with no stamp at all was written by a build that predates it, which
 * means a previous session — genuinely orphaned, and revivable.
 */
export function revivable(
  drafts: readonly QueuedDraft[],
  now: number = Date.now(),
): QueuedDraft[] {
  return drafts.filter((d) => {
    if (d.settled || d.status !== 'uploading') return false
    const since = Number(d.uploading_at ?? 0)
    if (!since) return true
    return now - since > STALE_UPLOAD_MS
  })
}

/** Put every genuinely orphaned upload back in the queue. Safe to call often. */
export async function reviveOrphanedUploads(now: number = Date.now()): Promise<number> {
  const orphans = revivable(await allDrafts(), now)
  for (const d of orphans) {
    await updateDraft(d.draft_id, {
      status: 'queued' satisfies DraftStatus,
      /**
       * The dead attempt still counts.
       *
       * It did not, and that was the second half of the same mistake: a draft
       * whose push kills the app every time would be revived, killed, revived
       * for ever, never reaching MAX_AUTO_ATTEMPTS and so never reaching a
       * person. An attempt that took the app down with it is exactly the kind
       * that should count against the five.
       */
      attempts: d.attempts + 1,
      retryAfter: 0,
      uploading_at: null,
      error: null,
    })
  }
  return orphans.length
}

export async function updateDraft(
  draftId: string,
  patch: Partial<QueuedDraft>,
): Promise<QueuedDraft | undefined> {
  const existing = await tx<QueuedDraft | undefined>(STORE, 'readonly', (store) =>
    store.get(draftId),
  )
  if (!existing) return undefined
  const merged = { ...existing, ...patch }
  await tx(STORE, 'readwrite', (store) => store.put(merged))
  return merged
}

/**
 * How much unpushed work this device is holding.
 *
 * Asked before a reset, because a reset that silently discards a SKU somebody
 * spoke on air is worse than any problem it could fix.
 */
export async function unpushedCount(): Promise<number> {
  const all = await allDrafts()
  return all.filter((d) => d.status !== 'pushed').length
}

/**
 * Throw away this device's local state and start again from the backend.
 *
 * A last resort, not a routine. Drafts are now handed to the backend as soon
 * as it has the record, so a phone should not accumulate anything to clear —
 * this exists for the case where one has anyway, and the alternative is
 * reinstalling the app on a factory floor.
 *
 * It refuses while anything is unpushed. Those drafts are the only copy: the
 * backend has never seen them, and clearing them loses the SKU.
 */
export async function resetDevice(): Promise<{ cleared: number }> {
  const unpushed = await unpushedCount()
  if (unpushed > 0) {
    throw new Error(
      `${unpushed} SKU${unpushed === 1 ? '' : 's'} on this phone ${unpushed === 1 ? 'has' : 'have'} not reached ` +
        'TikTok yet. Let them finish first \u2014 clearing now is the only copy gone.',
    )
  }
  const all = await allDrafts()
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE, PHOTOS], 'readwrite')
    transaction.objectStore(STORE).clear()
    transaction.objectStore(PHOTOS).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear the local database.'))
  })
  return { cleared: all.length }
}

export async function removeDraft(draftId: string): Promise<void> {
  await tx(STORE, 'readwrite', (store) => store.delete(draftId))
  await tx(PHOTOS, 'readwrite', (store) => store.delete(draftId))
}

/**
 * Which queued items are due for a push attempt, in creation order.
 *
 * Pure, so the rules that decide exactly-once behaviour can be tested without
 * a browser or a network.
 *
 * The rules:
 *   - a settled item is never pushed again, whatever its status says;
 *   - an item already uploading is not picked up twice, which is what would
 *     otherwise happen when a reconnect fires while a push is in flight;
 *   - a failed item retries until MAX_AUTO_ATTEMPTS, then waits for a person,
 *     because silently retrying a genuinely invalid SKU forever just burns the
 *     shop's daily listing allowance;
 *   - nothing is retried before its backoff has elapsed;
 *   - oldest first, so SKUs reach TikTok in the order they were created and
 *     the A1, A2, A3 sequence is preserved.
 */
export function dueForPush(drafts: readonly QueuedDraft[], now: number = Date.now()): QueuedDraft[] {
  return drafts
    .filter((d) => {
      if (d.settled || d.status === 'pushed') return false
      if (d.status === 'uploading') return false
      if (d.attempts >= MAX_AUTO_ATTEMPTS) return false
      if (d.retryAfter > now) return false
      return d.status === 'queued' || d.status === 'failed'
    })
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/**
 * The drafts to push right now: at most one per stream.
 *
 * A stream is one TikTok product, and adding a variation to it is a
 * read-modify-write of its whole SKU list. Two of those in flight at once is a
 * lost update whose consequence is a *deleted* variation, not just an
 * overwritten one. The server holds a lease that refuses the second push, but
 * relying on that alone would mean every parallel attempt burning a round trip
 * and a retry, so the client does not start them in the first place.
 *
 * It also settles a problem the lease cannot: before a stream's listing exists,
 * there is no listing id to take a lease on. Two drafts pushing then would each
 * create a product, and the factory run would be split across two listings for
 * no reason. One at a time per stream makes that unreachable — the first draft
 * creates the product, and its id is back-filled onto the rest.
 *
 * A stream with a push already in flight yields nothing, which is what makes
 * this safe to call on every reconnect.
 */
export function nextBatch(drafts: readonly QueuedDraft[], now: number = Date.now()): QueuedDraft[] {
  const inFlight = new Set(
    drafts.filter((d) => d.status === 'uploading').map((d) => d.stream_id),
  )

  const chosen = new Map<string, QueuedDraft>()
  for (const draft of dueForPush(drafts, now)) {
    if (inFlight.has(draft.stream_id)) continue
    // dueForPush is already oldest-first, so the first one seen per stream is
    // the one that should go — which for a new stream is the draft that creates
    // the listing.
    if (!chosen.has(draft.stream_id)) chosen.set(draft.stream_id, draft)
  }
  return [...chosen.values()]
}

/**
 * Stamp a newly created listing id onto every other draft of the same stream.
 *
 * Called once, after the first draft of a stream creates the product. Without
 * it the next draft would create a second product instead of adding to the
 * first. Drafts already settled are left alone — their work is done, and
 * rewriting history on them would only confuse the queue view.
 */
export function backfillListingId(
  drafts: readonly QueuedDraft[],
  streamId: string,
  listingId: string,
): QueuedDraft[] {
  return drafts
    .filter((d) => d.stream_id === streamId && d.listing_id === null && !d.settled)
    .map((d) => ({ ...d, listing_id: listingId }))
}

/**
 * Put a stalled SKU back in the queue, by hand.
 *
 * Resetting `attempts` is the point: automatic retries stop at
 * MAX_AUTO_ATTEMPTS so a genuinely invalid SKU cannot burn the shop's daily
 * listing allowance forever, and without a reset the button would appear to do
 * nothing. Clearing `settled` and the error matters too — a settled item is
 * never pushed again whatever its status says, and a stale error under a
 * retrying row reads as a fresh failure.
 *
 * The idempotency key is deliberately NOT regenerated. If the previous attempt
 * actually reached TikTok and only the reply was lost, the same key makes this
 * a no-op that returns the original product rather than a duplicate.
 */
export async function retryDraft(draftId: string): Promise<void> {
  await updateDraft(draftId, {
    status: 'queued' satisfies DraftStatus,
    error: null,
    attempts: 0,
    retryAfter: 0,
    settled: false,
  })
}

/** Items a person needs to look at: out of automatic attempts. */
/**
 * Is this draft done moving on its own?
 *
 * THE one rule, because it had three call sites and only one of them was
 * updated. `needsAttention` learned that a parked draft counts; the row badge
 * and the Retry button did not, so the screen showed a red banner saying
 * "2 SKUs could not be listed and stopped retrying" above two rows badged
 * **Retrying** with no Retry button on either. Brien photographed exactly that.
 *
 * Both ways a draft stops: it used up its automatic attempts, or it was parked
 * on the first one because the rejection will repeat.
 */
export function isStuck(draft: QueuedDraft): boolean {
  if (draft.settled || draft.status !== 'failed') return false
  return draft.attempts >= MAX_AUTO_ATTEMPTS || draft.retryAfter === PARKED
}

export function needsAttention(drafts: readonly QueuedDraft[]): QueuedDraft[] {
  /**
   * Two ways an item stops moving, and both need a person.
   *
   * It only tested the attempt count. A non-retryable rejection is parked on
   * its FIRST attempt — `afterAttempt` sets retryAfter to PARKED and leaves
   * attempts at 1 — so it failed both tests at once: `dueForPush` skipped it
   * because its backoff never elapses, and this skipped it because one attempt
   * is not five. The row sat in the queue as "failed" with nothing ever
   * picking it up and nothing ever asking anybody to look at it.
   *
   * That is the worst state in the whole queue: work that is neither done nor
   * moving nor visible, on a screen somebody is relying on mid-broadcast.
   */
  return drafts.filter(isStuck)
}

/** Unpushed work, for the "3 SKUs waiting to upload" indicator. */
export function pendingCount(drafts: readonly QueuedDraft[]): number {
  return drafts.filter((d) => !d.settled && d.status !== 'pushed').length
}

/**
 * Backoff for a failed push. Grows quickly but caps at five minutes, since a
 * livestream is finite and an item stuck behind a ten-minute wait is
 * effectively lost.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(2000 * 2 ** Math.max(0, attempts - 1), 300_000)
}

/**
 * How long to wait after losing a race for the listing's lease.
 *
 * Short, because the holder is mid-push and will be done in a second or two,
 * and jittered so two devices that collided do not collide again on the
 * rebound.
 */
export function contendedDelayMs(random: () => number = Math.random): number {
  return 750 + Math.floor(random() * 1250)
}

/** Next state after an attempt. Kept pure for the same reason as dueForPush. */
export function afterAttempt(
  draft: QueuedDraft,
  outcome:
    | { ok: true; tiktokProductId: string; listingId?: string }
    | { ok: false; error: string; retryable: boolean; contended?: boolean },
  now: number = Date.now(),
  random: () => number = Math.random,
): QueuedDraft {
  if (outcome.ok) {
    return {
      ...draft,
      status: 'pushed' satisfies DraftStatus,
      settled: true,
      pushed_at: new Date(now).toISOString(),
      error: null,
      tiktok_image_uri: draft.tiktok_image_uri,
      // A create returns the listing id the rest of the stream appends to, so
      // it is recorded here as well as back-filled onto the stream's siblings.
      listing_id: outcome.listingId ?? draft.listing_id,
      attempts: draft.attempts + 1,
      retryAfter: 0,
    }
  }

  // Contention is not a failure of this SKU, so it must not consume one of its
  // five automatic attempts. Five quick collisions on a busy stream would
  // otherwise park a perfectly good SKU and make someone push it by hand
  // mid-broadcast — the exact opposite of what the queue is for.
  if (outcome.contended) {
    return {
      ...draft,
      status: 'queued' satisfies DraftStatus,
      error: null,
      attempts: draft.attempts,
      retryAfter: now + contendedDelayMs(random),
      settled: false,
    }
  }

  const attempts = draft.attempts + 1
  return {
    ...draft,
    status: 'failed' satisfies DraftStatus,
    // TikTok's own wording, not a generic message. A vague error is what makes
    // the current app frustrating when a listing is refused.
    error: outcome.error,
    attempts,
    // A non-retryable rejection is parked immediately rather than retried:
    // it will fail identically and each attempt costs daily allowance.
    retryAfter: outcome.retryable ? now + retryDelayMs(attempts) : PARKED,
    settled: false,
  }
}
