import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { Listing, Shop } from '../types'
import ListingDetail from './ListingDetail'

/**
 * Pick the factory livestream to list against, or add a new one.
 *
 * Each row is one livestream at one factory, keyed by the TikTok listing id —
 * which is also the only place the business currently records which factories
 * are livestreamed from.
 */
export default function LiveListing({
  shop,
  onQueueChange,
}: {
  shop: Shop
  onQueueChange: () => void
}) {
  const [listings, setListings] = useState<Listing[]>([])
  const [selected, setSelected] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    api
      .listings(shop.shop_id)
      .then(setListings)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [shop.shop_id])

  useEffect(() => {
    // Changing brand must clear the selection, or the next screen would show
    // one shop's listing under another shop's credentials.
    setSelected(null)
    load()
  }, [load])

  if (selected) {
    return (
      <ListingDetail
        shop={shop}
        listing={selected}
        onBack={() => setSelected(null)}
        onQueueChange={onQueueChange}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-white">Live Listing</h1>
        {/* Hidden on a phone: the button matters, the hint does not, and at
            430px the two fight for the same row. */}
        <span className="hidden sm:inline text-xs text-gray-500 flex-1">
          Pick a factory stream to start listing
        </span>
        <span className="flex-1 sm:hidden" />
        <button
          onClick={() => setAdding(true)}
          className="text-xs px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
        >
          New stream
        </button>
      </div>

      {!shop.authorised && (
        <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2">
          {shop.brand} is not connected to TikTok yet. Authorise it before listing.
        </p>
      )}

      {error && (
        <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading…</p>
      ) : listings.length === 0 ? (
        <p className="text-sm text-gray-500 py-10 text-center">
          No streams yet. Add one with its TikTok listing ID.
        </p>
      ) : (
        <ul className="space-y-2">
          {listings.map((listing) => (
            <li key={listing.listing_id}>
              <button
                onClick={() => setSelected(listing)}
                className="w-full text-left bg-raised border border-white/8 rounded-xl px-4 py-3 hover:border-accent/50 transition-colors"
              >
                <p className="text-xs font-mono text-cyan-400">{listing.listing_id}</p>
                {listing.product_name && (
                  <p className="text-sm text-white font-medium mt-0.5">{listing.product_name}</p>
                )}
                {listing.supplier && (
                  <p className="text-xs text-gray-500 mt-0.5">{listing.supplier}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddListing
          shopId={shop.shop_id}
          onClose={() => setAdding(false)}
          onAdded={(listing) => {
            setAdding(false)
            setListings((prev) => [listing, ...prev])
            setSelected(listing)
          }}
        />
      )}
    </div>
  )
}

function AddListing({
  shopId,
  onClose,
  onAdded,
}: {
  shopId: string
  onClose: () => void
  onAdded: (listing: Listing) => void
}) {
  const [listingId, setListingId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    const id = listingId.trim()
    if (!id) {
      setError('Enter the TikTok listing ID.')
      return
    }
    // TikTok listing ids are long numeric strings. Catching a pasted URL or a
    // typo here is cheaper than a confusing API error.
    if (!/^\d{6,}$/.test(id)) {
      setError('That does not look like a TikTok listing ID — it should be digits only.')
      return
    }
    setBusy(true)
    setError('')
    try {
      onAdded(await api.addListing(shopId, id))
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-white/10 rounded-2xl p-6 w-full max-w-sm space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-white">Add a factory stream</p>
        <div className="space-y-1">
          <label htmlFor="listing-id" className="text-xs text-gray-400">
            TikTok listing ID
          </label>
          <input
            id="listing-id"
            autoFocus
            inputMode="numeric"
            value={listingId}
            onChange={(e) => {
              setListingId(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. 1734906684322056174"
            className="w-full bg-sunken border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono outline-none focus:border-accent"
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-xs px-4 py-2 text-gray-400 hover:text-white">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="text-xs px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
