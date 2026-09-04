import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A fake Netlify Blobs store with the two conditional-write behaviours the
 * lease depends on.
 *
 * Worth faking rather than stubbing: the whole correctness argument for the
 * lease rests on `onlyIfNew` admitting exactly one of several racing callers,
 * so a fake that does not model that would test nothing.
 */
class FakeStore {
  private data = new Map<string, { value: unknown; etag: string }>()
  private etagSeq = 0

  async setJSON(
    key: string,
    value: unknown,
    options?: { onlyIfNew?: boolean; onlyIfMatch?: string },
  ): Promise<{ modified: boolean; etag?: string }> {
    const existing = this.data.get(key)

    if (options?.onlyIfNew && existing) return { modified: false }
    if (options?.onlyIfMatch !== undefined) {
      if (!existing || existing.etag !== options.onlyIfMatch) return { modified: false }
    }

    const etag = `etag-${++this.etagSeq}`
    this.data.set(key, { value, etag })
    return { modified: true, etag }
  }

  async getWithMetadata(key: string): Promise<{ data: unknown; etag?: string } | null> {
    const existing = this.data.get(key)
    return existing ? { data: existing.value, etag: existing.etag } : null
  }

  async get(key: string): Promise<unknown> {
    return this.data.get(key)?.value ?? null
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  has(key: string): boolean {
    return this.data.has(key)
  }
}

let store: FakeStore

vi.mock('@netlify/blobs', () => ({
  getStore: () => store,
}))

const { tryAcquire, release, isExpired, listingLockKey, withListingLock, ListingBusyError, LEASE_MS } =
  await import('./lock')

beforeEach(() => {
  store = new FakeStore()
})

describe('tryAcquire', () => {
  it('grants the lease when nothing holds it', async () => {
    const lease = await tryAcquire('k', 'owner-1')
    expect(lease).not.toBeNull()
    expect(lease!.owner).toBe('owner-1')
  })

  it('refuses a second caller while the first lease is live', async () => {
    await tryAcquire('k', 'owner-1')
    expect(await tryAcquire('k', 'owner-2')).toBeNull()
  })

  it('admits exactly one of many simultaneous callers', async () => {
    // This is the property the whole module exists for. Two winners means two
    // read-modify-write cycles on one product, and one operator's variations
    // being deleted from the live shop.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => tryAcquire('k', `owner-${i}`)),
    )
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })

  it('lets a later caller take over an expired lease', async () => {
    const now = Date.now()
    await tryAcquire('k', 'owner-1', now)
    expect(await tryAcquire('k', 'owner-2', now + LEASE_MS + 1)).not.toBeNull()
  })

  it('still refuses one moment before expiry', async () => {
    const now = Date.now()
    await tryAcquire('k', 'owner-1', now)
    expect(await tryAcquire('k', 'owner-2', now + LEASE_MS - 1)).toBeNull()
  })

  it('admits only one of several callers racing to take over an expired lease', async () => {
    const now = Date.now()
    await tryAcquire('k', 'owner-1', now)
    const later = now + LEASE_MS + 1
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => tryAcquire('k', `taker-${i}`, later)),
    )
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })

  it('grants the lease again after release', async () => {
    const lease = await tryAcquire('k', 'owner-1')
    await release(lease!)
    expect(await tryAcquire('k', 'owner-2')).not.toBeNull()
  })
})

describe('release', () => {
  it('removes the lease it holds', async () => {
    const lease = await tryAcquire('k', 'owner-1')
    await release(lease!)
    expect(store.has('k')).toBe(false)
  })

  it('does not release a lease someone else has taken over', async () => {
    // Our lease expired, another push took it, and then our slow function
    // finally finished. Deleting the key here would let a third caller in
    // alongside the current holder.
    const now = Date.now()
    const mine = await tryAcquire('k', 'owner-1', now)
    await tryAcquire('k', 'owner-2', now + LEASE_MS + 1)

    await release(mine!)
    expect(store.has('k')).toBe(true)
  })

  it('never throws, so it cannot mask the result of the work it guarded', async () => {
    const lease = await tryAcquire('k', 'owner-1')
    vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('blob store down'))
    await expect(release(lease!)).resolves.toBeUndefined()
  })
})

describe('isExpired', () => {
  it('treats the exact expiry instant as expired', () => {
    expect(isExpired({ owner: 'x', expiresAt: 1000 }, 1000)).toBe(true)
  })

  it('treats a future expiry as live', () => {
    expect(isExpired({ owner: 'x', expiresAt: 1001 }, 1000)).toBe(false)
  })
})

describe('listingLockKey', () => {
  it('scopes by shop, so two shops cannot block each other', () => {
    expect(listingLockKey('shopA', '123')).not.toBe(listingLockKey('shopB', '123'))
  })

  it('is stable for the same shop and listing', () => {
    expect(listingLockKey('shopA', '123')).toBe(listingLockKey('shopA', '123'))
  })
})

describe('withListingLock', () => {
  it('runs the work and returns its value', async () => {
    const result = await withListingLock('shop', '123', async () => 'done')
    expect(result).toBe('done')
  })

  it('releases the lease afterwards, so the next push can proceed', async () => {
    await withListingLock('shop', '123', async () => 'first')
    await expect(withListingLock('shop', '123', async () => 'second')).resolves.toBe('second')
  })

  it('releases the lease even when the work throws', async () => {
    await expect(
      withListingLock('shop', '123', async () => {
        throw new Error('TikTok rejected the edit')
      }),
    ).rejects.toThrow('TikTok rejected the edit')

    // A failed push must not wedge the listing for the rest of the livestream.
    await expect(withListingLock('shop', '123', async () => 'ok')).resolves.toBe('ok')
  })

  it('reports the listing as busy rather than proceeding unguarded', async () => {
    let release2: (() => void) | undefined
    const held = withListingLock('shop', '123', () => new Promise<void>((r) => (release2 = r)))

    await expect(withListingLock('shop', '123', async () => 'nope')).rejects.toBeInstanceOf(
      ListingBusyError,
    )

    release2!()
    await held
  })

  it('does not run the work at all when the listing is busy', async () => {
    let release2: (() => void) | undefined
    const held = withListingLock('shop', '123', () => new Promise<void>((r) => (release2 = r)))

    const work = vi.fn(async () => 'ran')
    await expect(withListingLock('shop', '123', work)).rejects.toBeInstanceOf(ListingBusyError)
    expect(work).not.toHaveBeenCalled()

    release2!()
    await held
  })

  it('lets two different listings push at the same time', async () => {
    let releaseA: (() => void) | undefined
    const a = withListingLock('shop', 'listing-A', () => new Promise<void>((r) => (releaseA = r)))

    // A busy listing must not stall an unrelated one — two factories can be
    // streaming at once.
    await expect(withListingLock('shop', 'listing-B', async () => 'ok')).resolves.toBe('ok')

    releaseA!()
    await a
  })
})
