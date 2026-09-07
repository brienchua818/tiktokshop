import { useCallback, useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type ExportResult,
  type ListingOrders,
  type OrderSummary,
  type DateWindow,
} from '../lib/api'
import type { Shop } from '../types'
import Icon from '../ui/Icon'
import BarSpacer from '../ui/BarSpacer'
import { useDismiss } from '../ui/useDismiss'

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
  const [win, setWin] = useState<DateWindow>({
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
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<ExportResult | null>(null)
  /**
   * Selling price divided by this gives the factory price.
   *
   * Kept as text, not a number: an input bound to a number turns "1." into 1
   * mid-typing and the cursor jumps. Parsed once, at the point of use.
   */
  const [divisor, setDivisor] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setSummary(await api.orderSummary(shop.shop_id, win))
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
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
    try {
      await api.syncOrders({ shop_id: shop.shop_id, ...win })
      setSyncedAt(
        new Date().toLocaleTimeString('en-SG', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Singapore',
        }),
      )
      await load()
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setSyncing(false)
    }
  }

  async function exportPo() {
    const d = divisor.trim() ? Number(divisor) : undefined
    if (d !== undefined && (!Number.isFinite(d) || d <= 0)) {
      setError('The cost divisor has to be a number greater than zero.')
      return
    }
    setExporting(true)
    setError('')
    setExported(null)
    try {
      setExported(
        await api.exportOrders({
          shop_id: shop.shop_id,
          ...win,
          ...(d !== undefined ? { cost_divisor: d } : {}),
        }),
      )
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setExporting(false)
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
    // The other three handlers clear this before starting and this one did
    // not, so a refusal from a previous action stayed on screen while a
    // perfectly successful drill-down rendered underneath it.
    setError('')
    try {
      setDetail(await api.listingOrders(listingId, win))
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
    }
  }

  const [rangeOpen, setRangeOpen] = useState(false)
  /** When this device last pulled from TikTok, in Singapore time. */
  const [syncedAt, setSyncedAt] = useState('')

  function set(patch: Partial<DateWindow>) {
    setWin((w) => ({ ...w, ...patch }))
  }

  /** A day, in Singapore, `back` days ago. */
  function sgtDay(back = 0) {
    return new Date(Date.now() - back * 86400000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Singapore',
    })
  }

  /**
   * The four windows a real question actually takes.
   *
   * Last night is the common one — a stream runs into the evening and the
   * purchase order is cut the next morning. Typing four fields to say that was
   * the single biggest waste of space on this screen.
   */
  const presets = [
    {
      label: 'Last night 6pm–12am',
      win: { from_date: sgtDay(1), from_time: '18:00', to_date: sgtDay(1), to_time: '23:59' },
    },
    {
      label: 'Today',
      win: { from_date: today, from_time: '00:00', to_date: today, to_time: '23:59' },
    },
    {
      label: 'Yesterday',
      win: { from_date: sgtDay(1), from_time: '00:00', to_date: sgtDay(1), to_time: '23:59' },
    },
    {
      label: 'Last 7 days',
      win: { from_date: sgtDay(6), from_time: '00:00', to_date: today, to_time: '23:59' },
    },
  ]

  /** The window as one line, for the chip. */
  const rangeLabel = `${shortDate(win.from_date)} ${win.from_time} → ${shortDate(win.to_date)} ${win.to_time}`

  return (
    <div className="space-y-2.5">
      {/*
        The whole filter, in 44 px.

        It was four date and time inputs, two preset buttons, a sync button and
        two paragraphs of explanation — about 330 px before a single figure.
        The window is one chip that opens a sheet, and Sync sits beside it
        because the two are always used together.
      */}
      <div className="flex items-center gap-2 h-11">
        <button
          onClick={() => setRangeOpen(true)}
          className="flex-1 min-w-0 h-9 px-3 inline-flex items-center gap-2 rounded-lg bg-raised border border-line text-left"
        >
          <Icon name="calendar" size={16} className="text-muted" />
          <span className="text-[13px] text-fg truncate flex-1">{rangeLabel}</span>
          <Icon name="chevron-down" size={14} className="text-faint" />
        </button>
        <button
          onClick={() => void sync()}
          disabled={syncing}
          className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 text-[13px] font-semibold text-white shrink-0"
        >
          <Icon name="sync" size={16} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      {/* One line instead of a card: three numbers and when they are from. */}
      {summary && (
        <div className="flex items-baseline gap-3 flex-wrap text-[13px] px-0.5">
          <span className="text-fg2">
            <span className="font-semibold text-fg">{summary.total_orders}</span> orders
          </span>
          <span className="text-fg2">
            <span className="font-semibold text-fg">{summary.total_units}</span> items
          </span>
          <span className="font-semibold text-fg font-mono">
            ${summary.total_revenue.toFixed(2)}
          </span>
          <span className="flex-1" />
          {/* When the last read failed, the numbers beside it are from an
              earlier one. Saying so is the difference between figures and
              figures somebody trusts: an error banner over live-looking totals
              invites reading them as current. */}
          {error ? (
            <span className="text-xs text-warn">from the last good read</span>
          ) : (
            syncedAt && <span className="text-xs text-faint">synced {syncedAt}</span>
          )}
        </div>
      )}

      {error && (
        <p className="text-sm text-bad bg-bad-tint border border-bad-line rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {busy && !summary ? (
        <p className="text-sm text-faint py-10 text-center">Loading…</p>
      ) : !summary || summary.listings.length === 0 ? (
        <div className="bg-raised border border-line2 border-dashed rounded-xl px-4 py-8 text-center">
          <p className="text-sm text-faint">No orders in this window</p>
          <p className="text-xs text-ghost mt-1">
            If you expected some, press <span className="text-muted">Sync from TikTok</span> —
            nothing appears here until it has been fetched.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2.5">
            {/* On an iPad there is no fixed bottom bar, so the export controls
                live in the flow here instead. Same handler, same state. */}
            <div className="hidden md:flex items-center gap-2 bg-raised border border-line2 rounded-xl p-3">
              <label className="flex items-center gap-1.5 h-11 px-2.5 rounded-lg bg-sunken border border-line shrink-0">
                <span className="text-xs text-faint whitespace-nowrap">cost ÷</span>
                <input
                  inputMode="decimal"
                  value={divisor}
                  onChange={(e) => setDivisor(e.target.value)}
                  placeholder="1.6"
                  aria-label="Cost divisor"
                  className="w-14 bg-transparent text-sm text-fg outline-none"
                />
              </label>
              <button
                onClick={() => void exportPo()}
                disabled={exporting}
                className="min-h-11 px-4 rounded-lg bg-ok-solid disabled:opacity-50 text-on-ok text-sm font-semibold flex items-center gap-2"
              >
                <Icon name="download" size={18} />
                {exporting ? 'Building…' : 'Export purchase order'}
              </button>
              <p className="text-xs text-faint flex-1">
                Factory price = selling price ÷ this number. Blank means selling prices only.
                Either way the figure is printed in the file.
              </p>
            </div>

            {exported && (
              <div className="text-xs text-ok bg-ok-tint border border-ok-line rounded-lg px-3 py-3 space-y-2">
                <p className="font-medium text-ok flex items-center gap-1.5">
                  <Icon name="check" size={16} />
                  Purchase order saved to the shared drive
                </p>
                <p className="break-words">{exported.name}</p>
                <p className="text-ok/70">
                  {exported.listings} listing{exported.listings === 1 ? '' : 's'} ·{' '}
                  {exported.units} units · ${exported.revenue.toFixed(2)}
                  {exported.cost_divisor ? ` · cost ÷ ${exported.cost_divisor}` : ''}
                  {exported.folder ? ` · in ${exported.folder}` : ''}
                </p>
                {/* Said here so nobody has to open the file to learn a photo
                    did not make it. The reason for each is in the Log tab
                    and as a note on the cell itself. */}
                {typeof exported.photos_placed === 'number' && (
                  <p className={exported.photos_missing ? 'text-warn' : 'text-ok/70'}>
                    {exported.photos_placed} photo{exported.photos_placed === 1 ? '' : 's'} placed
                    {exported.photos_missing
                      ? ` · ${exported.photos_missing} shown as a link instead (reason in the Log tab and on the cell)`
                      : ''}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <a
                    href={exported.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-h-11 inline-flex items-center px-4 rounded-lg bg-ok-solid text-on-ok font-medium"
                  >
                    Open the Excel file
                  </a>
                  {exported.folder_url && (
                    <a
                      href={exported.folder_url}
                      target="_blank"
                      rel="noreferrer"
                      className="min-h-11 inline-flex items-center px-4 rounded-lg border border-ok-line text-ok"
                    >
                      Open the folder
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          <ul className="space-y-2">
            {summary.listings.map((l) => (
              <li key={l.listing_id} className="bg-raised border border-line2 rounded-xl">
                <button
                  onClick={() => void openDetail(l.listing_id)}
                  className="w-full text-left px-4 py-3"
                >
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm text-fg font-medium truncate flex-1">
                      {l.product_name || l.listing_id}
                    </p>
                    <p className="text-sm text-fg shrink-0">${l.revenue.toFixed(2)}</p>
                  </div>
                  <p className="text-xs text-faint mt-0.5">
                    {l.units} unit{l.units === 1 ? '' : 's'} · {l.order_count} order
                    {l.order_count === 1 ? '' : 's'}
                    {/* Shown rather than hidden: a factory asking why the number
                        is lower than what was called out on air deserves this. */}
                    {l.unsold_units > 0 && (
                      <span className="text-warn/80">
                        {' '}
                        · {l.unsold_units} cancelled or unpaid
                      </span>
                    )}
                    {l.latest_order_sgt && (
                      <span className="text-ghost"> · last {l.latest_order_sgt}</span>
                    )}
                  </p>
                  <p className="text-xs font-mono text-ref/70 mt-0.5">{l.listing_id}</p>
                </button>

                {openListing === l.listing_id && (
                  <div className="border-t border-line2 px-4 py-3">
                    {!detail ? (
                      <p className="text-xs text-faint">Loading variations…</p>
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

      {rangeOpen && (
        <RangeSheet
          win={win}
          presets={presets}
          onSet={set}
          onApply={() => {
            setRangeOpen(false)
            void sync()
          }}
          onClose={() => setRangeOpen(false)}
          syncing={syncing}
        />
      )}

      {/*
        Export, fixed above the tab bar.

        It used to sit inside the summary card, which on a phone means
        scrolling past every listing to reach it — and it is the last thing
        anyone does on this screen. The divisor stays beside it because the
        number it produces is the whole point of the file.
      */}
      {summary && summary.listings.length > 0 && (
        <div
          className="md:hidden fixed left-0 right-0 z-10 px-3 py-1.5 bg-surface border-t border-line2"
          style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom))' }}
        >
          <div className="max-w-5xl mx-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 h-11 px-2.5 rounded-xl bg-sunken border border-line shrink-0">
              <span className="text-xs text-faint whitespace-nowrap">cost ÷</span>
              <input
                inputMode="decimal"
                value={divisor}
                onChange={(e) => setDivisor(e.target.value)}
                placeholder="1.6"
                aria-label="Cost divisor"
                className="w-12 bg-transparent text-sm text-fg outline-none"
              />
            </label>
            <button
              onClick={() => void exportPo()}
              disabled={exporting}
              className="flex-1 min-h-11 rounded-xl bg-ok-solid disabled:opacity-50 text-on-ok text-[15px] font-semibold flex items-center justify-center gap-2"
            >
              <Icon name="download" size={18} />
              {exporting ? 'Building…' : 'Export purchase order'}
            </button>
          </div>
        </div>
      )}

      {/* Clears the fixed export bar this screen adds. */}
      {summary && summary.listings.length > 0 && <BarSpacer />}
    </div>
  )
}

/**
 * The date window, on demand.
 *
 * Presets first and biggest, because they answer the question almost every
 * time; the four fields are underneath for the rest. "Apply and sync" is one
 * button because choosing a window and then forgetting to sync it is how you
 * end up exporting yesterday's figures.
 */
function RangeSheet({
  win,
  presets,
  onSet,
  onApply,
  onClose,
  syncing,
}: {
  win: DateWindow
  presets: { label: string; win: DateWindow }[]
  onSet: (patch: Partial<DateWindow>) => void
  onApply: () => void
  onClose: () => void
  syncing: boolean
}) {
  useDismiss(onClose)
  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center">
      <button className="absolute inset-0 bg-scrim" onClick={onClose} aria-label="Close" />
      <div className="relative w-full sm:max-w-md max-h-[85dvh] overflow-y-auto bg-surface border-t sm:border border-line rounded-t-2xl sm:rounded-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-fg flex-1">Date and time</h2>
          <button
            onClick={onClose}
            className="min-h-11 min-w-11 -mr-1 inline-flex items-center justify-center text-muted"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => {
            const on =
              preset.win.from_date === win.from_date &&
              preset.win.from_time === win.from_time &&
              preset.win.to_date === win.to_date &&
              preset.win.to_time === win.to_time
            return (
              <button
                key={preset.label}
                onClick={() => onSet(preset.win)}
                aria-pressed={on}
                className={`min-h-10 px-3 rounded-lg text-[13px] border ${
                  on ? 'bg-accent border-accent text-white' : 'bg-sunken border-line text-fg2'
                }`}
              >
                {preset.label}
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <input
              type="date"
              value={win.from_date}
              max={win.to_date}
              onChange={(e) => onSet({ from_date: e.target.value })}
              className="w-full bg-sunken border border-line rounded-lg px-2.5 min-h-11 text-sm text-fg outline-none focus:border-accent"
            />
            <input
              type="time"
              value={win.from_time}
              onChange={(e) => onSet({ from_time: e.target.value })}
              className="w-full bg-sunken border border-line rounded-lg px-2.5 min-h-11 text-sm text-fg outline-none focus:border-accent"
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={win.to_date}
              min={win.from_date}
              onChange={(e) => onSet({ to_date: e.target.value })}
              className="w-full bg-sunken border border-line rounded-lg px-2.5 min-h-11 text-sm text-fg outline-none focus:border-accent"
            />
            <input
              type="time"
              value={win.to_time}
              onChange={(e) => onSet({ to_time: e.target.value })}
              className="w-full bg-sunken border border-line rounded-lg px-2.5 min-h-11 text-sm text-fg outline-none focus:border-accent"
            />
          </Field>
        </div>

        <button
          onClick={onApply}
          disabled={syncing}
          className="w-full min-h-12 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-50 text-[15px] font-semibold text-white flex items-center justify-center gap-2"
        >
          <Icon name="sync" size={18} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing…' : 'Apply and sync from TikTok'}
        </button>
        <p className="text-xs text-faint text-center">
          Re-syncing the same window updates cancellations, never duplicates.
        </p>
      </div>
    </div>
  )
}

/** "4 Sep" from "2026-09-04" — the year is noise in a chip. */
function shortDate(iso: string): string {
  const [, month, day] = iso.split('-')
  if (!month || !day) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(day)} ${months[Number(month) - 1] ?? month}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">{label}</p>
      {children}
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
            <tr className="text-faint text-left">
              <th className="font-normal pb-1.5 pr-3">SKU</th>
              <th className="font-normal pb-1.5 pr-3">Variation</th>
              <th className="font-normal pb-1.5 pr-3 text-right">Units</th>
              <th className="font-normal pb-1.5 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {detail.variations.map((v) => (
              <tr key={v.seller_sku || v.variation} className="border-t border-hair">
                <td className="py-1.5 pr-3 font-mono text-identifier whitespace-nowrap">
                  {v.seller_sku || '—'}
                </td>
                <td className="py-1.5 pr-3 text-muted">{v.variation}</td>
                <td className="py-1.5 pr-3 text-right text-fg">
                  {v.units}
                  {v.unsold_units > 0 && (
                    <span className="text-warn/70"> (+{v.unsold_units})</span>
                  )}
                </td>
                <td className="py-1.5 text-right text-fg2">${v.revenue.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-faint">
        {detail.total_units} units across {detail.order_count} orders · $
        {detail.total_revenue.toFixed(2)}
        {detail.variations.some((v) => v.unsold_units > 0) && (
          <span className="text-ghost"> · (+n) is cancelled or unpaid</span>
        )}
      </p>
    </div>
  )
}
