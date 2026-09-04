/**
 * A mutual-exclusion lease over a single listing.
 *
 * Adding a variation to a TikTok product is a read-modify-write: read the
 * product's SKUs, append one, send the whole list back. Two of those running at
 * once is a textbook lost update, except the consequence is worse than usual —
 * the second write's SKU list was built before the first write landed, so the
 * first operator's variation is not merely overwritten, it is *deleted from the
 * shop*. TikTok returns success to both.
 *
 * That is not a theoretical race. Two people can be listing from the same
 * livestream on two phones, and the offline queue means a reconnecting device
 * can fire a push at any moment, including while someone else is mid-push.
 *
 * So every append takes this lease first.
 *
 * The atomicity comes from Netlify Blobs' conditional writes, not from wishful
 * thinking: `onlyIfNew` succeeds for exactly one caller when several race to
 * create the same key, and `onlyIfMatch` makes taking over an expired lease a
 * compare-and-set rather than a blind overwrite.
 */

import { getStore } from '@netlify/blobs'

const LOCKS = 'tikshop-locks'

/**
 * How long a lease is honoured before another caller may take it.
 *
 * Long enough to cover the slowest realistic push — a read, a build and an
 * edit, on factory Wi-Fi — and short enough that a function killed mid-push
 * does not wedge a livestream. Netlify's function timeout is well inside this,
 * so a lease outliving its holder means the holder is genuinely gone.
 */
export const LEASE_MS = 30_000

export interface Lease {
  key: string
  owner: string
  expiresAt: number
}

interface LeaseRecord {
  owner: string
  expiresAt: number
}

/** True when a lease record is old enough to be taken over. */
export function isExpired(record: LeaseRecord, now = Date.now()): boolean {
  return record.expiresAt <= now
}

/**
 * Try once to take the lease.
 *
 * Returns null when someone else holds it and their lease is still live. The
 * caller decides whether to wait or to tell the operator to try again — this
 * function deliberately does not block, so a queued push cannot pile up
 * holding a function invocation open.
 */
export async function tryAcquire(
  key: string,
  owner: string,
  now = Date.now(),
): Promise<Lease | null> {
  const store = getStore(LOCKS)
  const record: LeaseRecord = { owner, expiresAt: now + LEASE_MS }

  // The happy path, and the only one that matters when nothing is contended:
  // exactly one racing caller gets `modified: true`.
  const created = await store.setJSON(key, record, { onlyIfNew: true })
  if (created.modified) return { key, owner, expiresAt: record.expiresAt }

  // Someone holds it. Read it with strong consistency — the default is
  // eventually consistent, and a stale read here would hand the same lease to
  // two callers, which is the exact failure this module exists to prevent.
  const existing = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' })
  if (!existing) {
    // Released between our write and our read. Leave it to the next attempt
    // rather than racing again inside one call.
    return null
  }

  const held = existing.data as LeaseRecord | null
  if (held && !isExpired(held, now)) return null

  // Expired. Take it over conditionally, so if two callers both see it as
  // expired only one wins.
  if (!existing.etag) return null
  const taken = await store.setJSON(key, record, { onlyIfMatch: existing.etag })
  return taken.modified ? { key, owner, expiresAt: record.expiresAt } : null
}

/**
 * Release the lease, but only if we still hold it.
 *
 * The check matters: if our lease expired and someone else took over, deleting
 * the key would drop *their* lease and let a third caller in alongside them.
 */
export async function release(lease: Lease): Promise<void> {
  const store = getStore(LOCKS)
  try {
    const existing = await store.get(lease.key, { type: 'json', consistency: 'strong' })
    const held = existing as LeaseRecord | null
    if (held && held.owner !== lease.owner) return
    await store.delete(lease.key)
  } catch (error) {
    // A lease that fails to release expires on its own. Never let this failure
    // mask the outcome of the work it was protecting.
    console.error('[tikshop] lease release failed; it will expire', error)
  }
}

/** The lease key for one listing. Scoped by shop so ids cannot collide. */
export function listingLockKey(shopId: string, listingId: string): string {
  return `listing-${shopId}-${listingId}`
}

/**
 * Run `work` while holding the listing's lease.
 *
 * @throws ListingBusyError when another push holds it.
 */
export async function withListingLock<T>(
  shopId: string,
  listingId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = listingLockKey(shopId, listingId)
  const owner = crypto.randomUUID()
  const lease = await tryAcquire(key, owner)
  if (!lease) throw new ListingBusyError(listingId)

  try {
    return await work()
  } finally {
    await release(lease)
  }
}

/**
 * Another push is mid-flight on this listing.
 *
 * Surfaced rather than swallowed: the correct response is to retry in a moment,
 * and the offline queue already knows how to do that. Silently proceeding is
 * the one thing that must not happen.
 */
export class ListingBusyError extends Error {
  readonly listingId: string
  constructor(listingId: string) {
    super(
      'Another SKU is being added to this listing right now. This one will retry in a moment — nothing has been lost.',
    )
    this.name = 'ListingBusyError'
    this.listingId = listingId
  }
}
