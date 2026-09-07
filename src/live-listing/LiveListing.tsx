import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type TikTokProduct } from '../lib/api'
import type { Listing, Shop } from '../types'
import ListingDetail from './ListingDetail'
import { useDismiss } from '../ui/useDismiss'
import Icon from '../ui/Icon'

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
      .catch((e: unknown) => setError(e instanceof ApiError ? e.display : String(e)))
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
        <h1 className="text-lg font-semibold text-fg">Live Listing</h1>
        {/* Hidden on a phone: the button matters, the hint does not, and at
            430px the two fight for the same row. */}
        <span className="hidden sm:inline text-xs text-faint flex-1">
          Pick a factory stream to start listing
        </span>
        <span className="flex-1 sm:hidden" />
        <button
          onClick={() => setAdding(true)}
          className="text-xs px-3 py-1.5 bg-accent hover:bg-accent-hover text-fg rounded-lg transition-colors"
        >
          New stream
        </button>
      </div>

      {!shop.authorised && (
        <p className="text-sm text-warn bg-warn-tint border border-warn-line rounded-lg px-4 py-2">
          {shop.brand} is not connected to TikTok yet. Authorise it before listing.
        </p>
      )}

      {error && (
        <p className="text-sm text-bad bg-bad-tint border border-bad-line rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-faint py-10 text-center">Loading…</p>
      ) : listings.length === 0 ? (
        <div className="py-10 text-center space-y-3">
          <p className="text-sm text-faint">No streams yet.</p>
          <button
            onClick={() => setAdding(true)}
            className="text-xs px-4 py-2 bg-accent hover:bg-accent-hover text-fg rounded-lg transition-colors"
          >
            Pick one from {shop.brand}
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {listings.map((listing) => (
            <li key={listing.listing_id}>
              <button
                onClick={() => setSelected(listing)}
                className="w-full text-left bg-raised border border-line2 rounded-xl px-4 py-3 hover:border-accent/50 transition-colors"
              >
                <p className="text-xs font-mono text-ref">{listing.listing_id}</p>
                {listing.product_name && (
                  <p className="text-sm text-fg font-medium mt-0.5">{listing.product_name}</p>
                )}
                {listing.supplier && (
                  <p className="text-xs text-faint mt-0.5">{listing.supplier}</p>
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
  useDismiss(onClose)
  const [products, setProducts] = useState<TikTokProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [busyId, setBusyId] = useState('')
  // The id box is the fallback, not the front door. A product too new to
  // appear, or a search that will not load, still has to be addable.
  const [byHand, setByHand] = useState(false)
  const [listingId, setListingId] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .tiktokProducts(shopId)
      .then((r) => !cancelled && setProducts(r.products))
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.display : String(e))
        // Nothing to pick from is a dead end, so open the fallback rather than
        // leaving someone looking at an error with no way forward.
        setByHand(true)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [shopId])

  async function add(id: string, name?: string) {
    setBusyId(id)
    setError('')
    try {
      onAdded(await api.addListing(shopId, id, name))
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setBusyId('')
    }
  }

  async function submitTyped() {
    const id = listingId.trim()
    if (!/^\d{6,}$/.test(id)) {
      setError('That does not look like a TikTok listing ID — it should be digits only.')
      return
    }
    await add(id)
  }

  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(needle) || p.listing_id.includes(needle),
      )
    : products

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-scrim"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl p-5 w-full sm:max-w-md max-h-[85vh] flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-fg flex-1">Start a stream</p>
          <button
            onClick={onClose}
            className="min-h-11 min-w-11 -mr-1 inline-flex items-center justify-center text-muted hover:text-fg"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        {error && (
          <p className="text-xs text-bad bg-bad-tint border border-bad-line rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {!byHand && (
          <>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search your products"
              className="w-full bg-sunken border border-line rounded-lg px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
            />

            <div className="overflow-y-auto -mx-1 px-1 flex-1 min-h-0">
              {loading ? (
                <p className="text-sm text-faint py-8 text-center">Loading products…</p>
              ) : shown.length === 0 ? (
                <p className="text-sm text-faint py-8 text-center">
                  {products.length === 0 ? 'No live products on this shop.' : 'Nothing matches.'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {shown.map((p) => (
                    <li key={p.listing_id}>
                      <button
                        onClick={() => add(p.listing_id, p.product_name)}
                        disabled={Boolean(busyId)}
                        className="w-full flex items-center gap-3 text-left bg-raised border border-line2 rounded-xl p-2.5 hover:border-accent/50 disabled:opacity-50 transition-colors"
                      >
                        {p.image ? (
                          <img
                            src={p.image}
                            alt=""
                            className="w-11 h-11 rounded-lg object-cover shrink-0"
                          />
                        ) : (
                          <span className="w-11 h-11 rounded-lg bg-sunken shrink-0" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-fg truncate">
                            {p.product_name || p.listing_id}
                          </span>
                          {/* Singapore caps a product at 100 variations, so how
                              full it already is decides whether this stream can
                              use it at all. */}
                          <span className="block text-xs text-faint">
                            {p.sku_count} variation{p.sku_count === 1 ? '' : 's'}
                            {p.sku_count >= 100 && ' — full'}
                          </span>
                        </span>
                        {busyId === p.listing_id && (
                          <span className="text-xs text-muted shrink-0">Adding…</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {byHand && (
          <div className="space-y-2">
            <label htmlFor="listing-id" className="text-xs text-muted">
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
              onKeyDown={(e) => e.key === 'Enter' && submitTyped()}
              placeholder="e.g. 1734906684322056174"
              className="w-full bg-sunken border border-line rounded-lg px-3 py-2.5 text-sm text-fg font-mono outline-none focus:border-accent"
            />
            <button
              onClick={submitTyped}
              disabled={Boolean(busyId)}
              className="w-full text-xs px-4 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-fg rounded-lg transition-colors"
            >
              {busyId ? 'Adding…' : 'Add'}
            </button>
          </div>
        )}

        <button
          onClick={() => {
            setByHand((v) => !v)
            setError('')
          }}
          className="text-xs text-faint hover:text-fg2 self-start"
        >
          {byHand ? '← Pick from my products' : 'Or paste a listing ID'}
        </button>
      </div>
    </div>
  )
}
