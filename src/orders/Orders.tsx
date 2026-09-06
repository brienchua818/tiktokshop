import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type ListingOrders, type OrderSummary, type Window } from '../lib/api'
import type { Shop } from '../types'

/**
 * Orders, grouped by listing, inside a date and time window.
 *
 * The window is the primary filter, not a decoration on top of a listing
 * total. One listing is often used across more than one stream — the
 * convention is one listing per factory, and a factory gets visited again —
 * so "what did this listing sell" is not a well-formed question without a
 * period attached. Every figure on this screen is scoped to the window.
 *
 * Time as well as date, because a livestream is an evening rather than a day,
 * and a factory being paid for Tuesday night should not be credited with
 * Tuesday afternoon's organic sales.
 */

/** Today in Singapore, as yyyy-MM-dd. */
function todaySgt(): string {
  // en-CA gives ISO order, which is what the input element wants.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })
}

export default function Orders({ shop }: { shop: Shop }) {
  const today = todaySgt()

  // Defaults to the whole of today. A stream is normally the evening just
  // gone, and narrowing from a full day is easier than widening from an
  // arbitrary hour.
  const [win, setWin] = useState<Window>({
    from_date: today,
    from_time: '00:00',
    to_date: today,
    to_time: '23:59',
  })

  const [summary, setSummary] = useState<OrderSummary | null>(null)
  const [openListing, setOpenListing] = useState<string | null>(null)
  const [detail, setDetail] = useState<ListingOrders | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setSummary(await api.orderSummary(shop.shop_id, win))
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [shop.shop_id, win])

  useEffect(() => {
    setOpenListing(null)
    setDetail(null)
    void load()
  }, [load])

  /**
   * Fetch this window from TikTok, then re-read.
   *
   * Separate from loading on purpose. Reading is free and instant; syncing
   * costs TikTok calls and can take a while on a busy stream, so it is a
   * deliberate press rather than something that happens whenever a date
   * changes.
   */
  async function sync() {
    setSyncing(true)
    setError('')
    setNote('')
    try {
      const r = await api.syncOrders({ shop_id: shop.shop_id, ...win })
      setNote(`${r.orders} orders, ${r.items} items — ${r.from} to ${r.to}`)
      await load()
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  async function openDetail(listingId: string) {
    if (openListing === listingId) {
      setOpenListing(null)
      setDetail(null)
      return
    }
    setOpenListing(listingId)
    setDetail(null)
    try {
      setDetail(await api.listingOrders(listingId, win))
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  function set(patch: Partial<Window>) {
    setWin((w) => ({ ...w, ...patch }))
  }

  /** Yesterday evening — the shape almost every real question takes. */
  function lastNight() {
    const d = new Date(Date.now() - 86400000)
    const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })
    setWin({ from_date: day, from_time: '18:00', to_date: day, to_time: '23:59' })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h1 className="text-lg font-semibold text-white">Orders</h1>
        <span className="text-xs text-gray-500">{shop.brand} · Singapore time</span>
      </div>

      {/* The filter, not a sidebar. Everything below it is scoped to it. */}
      <div className="bg-raised border border-white/8 rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <input
              type="date"
              value={win.from_date}
              max={win.to_date}
              onChange={(e) => set({ from_date: e.target.value })}
              className="w-full bg-sunken border border-white/10 rounded-lg px-2.5 min-h-11 text-sm text-white outline-none focus:border-accent"
            />
            <input
              type="time"
              value={win.from_time}
              onChange={(e) => set({ from_time: e.target.value })}
              className="w-full bg-sunken border border-white/10 rounded-lg px-2.5 min-h-11 text-sm text-white outline-none focus:border-accent"
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={win.to_date}
              min={win.from_date}
              onChange={(e) => set({ to_date: e.target.value })}
              className="w-full bg-sunken border border-white/10 rounded-lg px-2.5 min-h-11 text-sm text-white outline-none focus:border-accent"
            />
            <input
              type="time"
              value={win.to_time}
              onChange={(e) => set({ to_time: e.target.value })}
              className="w-full bg-sunken border border-white/10 rounded-lg px-2.5 min-h-11 text-sm text-white outline-none focus:border-accent"
            />
          </Field>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button
            onClick={lastNight}
            className="text-xs px-3 min-h-9 rounded-lg border border-white/10 text-gray-300 hover:border-accent/50"
          >
            Last night 6pm–midnight
          </button>
          <button
            onClick={() => setWin({ from_date: today, from_time: '00:00', to_date: today, to_time: '23:59' })}
            className="text-xs px-3 min-h-9 rounded-lg border border-white/10 text-gray-300 hover:border-accent/50"
          >
            Today
          </button>
          <span className="flex-1" />
          <button
            onClick={() => void sync()}
            disabled={syncing}
            className="text-xs px-4 min-h-9 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 text-white font-medium"
          >
            {syncing ? 'Syncing…' : 'Sync from TikTok'}
          </button>
        </div>

        <p className="text-xs text-gray-600">
          Sync fetches this window from TikTok. Everything below reads what has been synced, so
          re-syncing the same window updates cancellations rather than duplicating orders.
        </p>
      </div>

      {note && (
        <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
          {note}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {busy && !summary ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading…</p>
      ) : !summary || summary.listings.length === 0 ? (
        <div className="bg-raised border border-white/8 border-dashed rounded-xl px-4 py-8 text-center">
          <p className="text-sm text-gray-500">No orders in this window</p>
          <p className="text-xs text-gray-600 mt-1">
            If you expected some, press <span className="text-gray-400">Sync from TikTok</span> —
            nothing appears here until it has been fetched.
          </p>
        </div>
      ) : (
        <>
          <div className="flex gap-4 text-sm bg-raised border border-white/8 rounded-xl px-4 py-3">
            <Stat label="Listings" value={String(summary.listings.length)} />
            <Stat label="Units" value={String(summary.total_units)} />
            <Stat label="Revenue" value={`$${summary.total_revenue.toFixed(2)}`} />
          </div>

          <ul className="space-y-2">
            {summary.listings.map((l) => (
              <li key={l.listing_id} className="bg-raised border border-white/8 rounded-xl">
                <button
                  onClick={() => void openDetail(l.listing_id)}
                  className="w-full text-left px-4 py-3"
                >
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm text-white font-medium truncate flex-1">
                      {l.product_name || l.listing_id}
                    </p>
                    <p className="text-sm text-white shrink-0">${l.revenue.toFixed(2)}</p>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {l.units} unit{l.units === 1 ? '' : 's'} · {l.order_count} order
                    {l.order_count === 1 ? '' : 's'}
                    {/* Shown rather than hidden: a factory asking why the number
                        is lower than what was called out on air deserves this. */}
                    {l.unsold_units > 0 && (
                      <span className="text-amber-400/80">
                        {' '}
                        · {l.unsold_units} cancelled or unpaid
                      </span>
                    )}
                    {l.latest_order_sgt && (
                      <span className="text-gray-600"> · last {l.latest_order_sgt}</span>
                    )}
                  </p>
                  <p className="text-xs font-mono text-cyan-400/60 mt-0.5">{l.listing_id}</p>
                </button>

                {openListing === l.listing_id && (
                  <div className="border-t border-white/8 px-4 py-3">
                    {!detail ? (
                      <p className="text-xs text-gray-500">Loading variations…</p>
                    ) : (
                      <VariationTable detail={detail} />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-400">{label}</p>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-white font-medium">{value}</p>
    </div>
  )
}

/**
 * What the factory has to supply, by variation.
 *
 * Grouped rather than listed per order: two hundred order rows is not a
 * purchase order, and "A7 × 14" is. Scrolls inside its own container so a
 * long run cannot push the page sideways on a phone.
 */
function VariationTable({ detail }: { detail: ListingOrders }) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="font-normal pb-1.5 pr-3">SKU</th>
              <th className="font-normal pb-1.5 pr-3">Variation</th>
              <th className="font-normal pb-1.5 pr-3 text-right">Units</th>
              <th className="font-normal pb-1.5 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {detail.variations.map((v) => (
              <tr key={v.seller_sku || v.variation} className="border-t border-white/5">
                <td className="py-1.5 pr-3 font-mono text-identifier whitespace-nowrap">
                  {v.seller_sku || '—'}
                </td>
                <td className="py-1.5 pr-3 text-gray-400">{v.variation}</td>
                <td className="py-1.5 pr-3 text-right text-white">
                  {v.units}
                  {v.unsold_units > 0 && (
                    <span className="text-amber-400/70"> (+{v.unsold_units})</span>
                  )}
                </td>
                <td className="py-1.5 text-right text-gray-300">${v.revenue.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">
        {detail.total_units} units across {detail.order_count} orders · $
        {detail.total_revenue.toFixed(2)}
        {detail.variations.some((v) => v.unsold_units > 0) && (
          <span className="text-gray-600"> · (+n) is cancelled or unpaid</span>
        )}
      </p>
    </div>
  )
}
