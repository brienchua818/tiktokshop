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

export interface QueuedDraft extends Draft {
  /** How many push attempts have been made. */
  attempts: number
  /** Epoch ms before which this item should not be retried. */
  retryAfter: number
  /** True once TikTok has confirmed the product. */
  settled: boolean
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

export function allDrafts(): Promise<QueuedDraft[]> {
  return tx<QueuedDraft[]>(STORE, 'readonly', (store) => store.getAll())
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

/** Items a person needs to look at: out of automatic attempts. */
export function needsAttention(drafts: readonly QueuedDraft[]): QueuedDraft[] {
  return drafts.filter((d) => !d.settled && d.status === 'failed' && d.attempts >= MAX_AUTO_ATTEMPTS)
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

/** Next state after an attempt. Kept pure for the same reason as dueForPush. */
export function afterAttempt(
  draft: QueuedDraft,
  outcome:
    | { ok: true; tiktokProductId: string }
    | { ok: false; error: string; retryable: boolean },
  now: number = Date.now(),
): QueuedDraft {
  if (outcome.ok) {
    return {
      ...draft,
      status: 'pushed' satisfies DraftStatus,
      settled: true,
      error: null,
      tiktok_image_uri: draft.tiktok_image_uri,
      attempts: draft.attempts + 1,
      retryAfter: 0,
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
    retryAfter: outcome.retryable ? now + retryDelayMs(attempts) : Number.MAX_SAFE_INTEGER,
    settled: false,
  }
}
