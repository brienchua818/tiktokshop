import { useCallback, useEffect, useRef, useState } from 'react'
import { bucketText, tallyOf, unsoldText } from './tally'
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
import { useAutoRefresh } from '../hooks/useAutoRefresh'

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

/** Now, in Singapore, as HH:MM. */
function clockSgt(): string {
  return new Date().toLocaleTimeString('en-SG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Singapore',
  })
}

/**
 * Whether the window has not ended yet, so its figures can still move.
 *
 * Compared as "yyyy-MM-dd HH:MM" text in Singapore time, which sorts the way
 * the instants do. sv-SE is the locale whose date-time format is exactly that.
 */
function includesNow(w: DateWindow): boolean {
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).slice(0, 16)
  return `${w.from_date} ${w.from_time}` <= now && now <= `${w.to_date} ${w.to_time}`
}

/**
 * Between reads while the window is still open.
 *
 * The backend pulls new orders from TikTok every minute on its own timer
 * (`syncRecentOrders`, Orders.gs), so the Sheet this reads changes about that
 * often during a stream and no faster.
 */
const POLL_MS = 60_000
/** Coming back to the tab reads at once if the figures are older than this. */
const STALE_ON_RETURN_MS = 30_000
/** A date or time being typed is read this long after the last change. */
const FIELD_SETTLE_MS = 500

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

  /**
   * The window the figures are read for: `win`, once it has stopped changing.
   *
   * Every change to a date or time field started a read of the whole Order
   * Items tab, and a picker being scrolled or a date typed digit by digit
   * changes the field several times on the way to the value wanted. Each was
   * a read, and their answers could land in any order.
   */
  const [readWin, setReadWin] = useState<DateWindow>(win)
  useEffect(() => {
    const timer = setTimeout(() => setReadWin(win), FIELD_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [win])

  const [summary, setSummary] = useState<OrderSummary | null>(null)
  const [openListing, setOpenListing] = useState<string | null>(null)
  /** `openListing` as of now, for a read that started before it changed. */
  const openNow = useRef<string | null>(null)
  const [detail, setDetail] = useState<ListingOrders | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<ExportResult | null>(null)
  /**
   * The listings to export. Empty means every listing in the window.
   *
   * Brien, 24 Sep: a five-day window held more listings than one export can
   * build inside Google's six-minute limit, and he only ever needed a few of
   * them. Ticking the ones wanted makes the file as small as the question.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  /**
   * A failed read, kept apart from a failed action.
   *
   * The timer reads every minute. Had it shared `error`, its next good answer
   * would have wiped an export's failure off the screen before anybody had
   * read it.
   */
  const [readError, setReadError] = useState('')
  /** When the figures on screen were read, in Singapore time. */
  const [readAt, setReadAt] = useState('')

  /**
   * Which read is on screen, by the order the reads were asked for.
   *
   * Reads overlap — the one when the window changes, the one after a Sync,
   * the timer's — and whichever answered last won, whatever it described: a
   * read asked for before a sync, answering after the sync's own read, put the
   * pre-sync figures back. An answer older than the one on screen is dropped.
   */
  const asked = useRef(0)
  const shown = useRef(0)
  /** Reads still out. The timer does not start another while any is. */
  const loading = useRef(0)
  const lastGood = useRef(0)
  const detailAsked = useRef(0)
  const detailShown = useRef(0)
  /** Nothing is set after the tab has been left. */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(
    async (w: DateWindow) => {
      const n = ++asked.current
      loading.current++
      setBusy(true)
      try {
        const s = await api.orderSummary(shop.shop_id, w)
        if (!alive.current || n < shown.current) return
        shown.current = n
        lastGood.current = Date.now()
        setSummary(s)
        setReadAt(clockSgt())
        setReadError('')
      } catch (e: unknown) {
        if (alive.current && n >= shown.current) setReadError(e instanceof ApiError ? e.display : String(e))
      } finally {
        loading.current--
        if (alive.current) setBusy(loading.current > 0)
      }
    },
    [shop.shop_id],
  )

  /** One listing's variations, for the drill-down that is open. */
  const loadDetail = useCallback(async (listingId: string, w: DateWindow) => {
    const n = ++detailAsked.current
    try {
      const d = await api.listingOrders(listingId, w)
      if (!alive.current || n < detailShown.current || openNow.current !== listingId) return
      detailShown.current = n
      setDetail(d)
    } catch (e: unknown) {
      if (alive.current && n >= detailShown.current && openNow.current === listingId) {
        setError(e instanceof ApiError ? e.display : String(e))
      }
    }
  }, [])

  useEffect(() => {
    openNow.current = null
    setOpenListing(null)
    setDetail(null)
    setError('')
    void load(readWin)
  }, [load, readWin])

  /**
   * Read again by itself while the window is still open and the tab is on
   * screen, and on coming back to it.
   *
   * It read once when opened, when the window changed and after Sync, so
   * figures left on screen during a stream stopped moving while the backend's
   * own timer kept pulling orders in. The open drill-down is read with it, or
   * its rows would disagree with the total above them.
   */
  useAutoRefresh({
    enabled: includesNow(readWin),
    everyMs: POLL_MS,
    staleAfterMs: STALE_ON_RETURN_MS,
    lastGoodAt: () => lastGood.current,
    busy: () => loading.current > 0 || syncing,
    read: async () => {
      await load(readWin)
      if (openNow.current) await loadDetail(openNow.current, readWin)
    },
  })

  // A tick for a listing no longer in this window would export something
  // nobody can see on the screen. Keep only the ones still shown.
  useEffect(() => {
    if (!summary) return
    const shown = new Set(summary.listings.map((l) => l.listing_id).filter(Boolean))
    setSelected((was) => {
      const kept = new Set([...was].filter((id) => shown.has(id)))
      return kept.size === was.size ? was : kept
    })
  }, [summary])

  const selectable = (summary?.listings ?? []).filter((l) => l.listing_id)
  const allTicked = selectable.length > 0 && selectable.every((l) => selected.has(l.listing_id))

  function toggle(id: string) {
    setSelected((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allTicked ? new Set() : new Set(selectable.map((l) => l.listing_id)))
  }

  const exportLabel = exporting
    ? 'Building…'
    : selected.size
      ? `Export ${selected.size} selected`
      : `Export all ${selectable.length} listing${selectable.length === 1 ? '' : 's'}`

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
      await load(win)
      // The drill-down too: it is the same window, just synced.
      if (openNow.current) await loadDetail(openNow.current, win)
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setSyncing(false)
    }
  }

  async function exportPo() {
    setExporting(true)
    setError('')
    setExported(null)
    try {
      setExported(
        await api.exportOrders({
          shop_id: shop.shop_id,
          ...win,
          ...(selected.size ? { listing_ids: [...selected] } : {}),
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
      openNow.current = null
      setOpenListing(null)
      setDetail(null)
      return
    }
    openNow.current = listingId
    setOpenListing(listingId)
    setDetail(null)
    // The other three handlers clear this before starting and this one did
    // not, so a refusal from a previous action stayed on screen while a
    // perfectly successful drill-down rendered underneath it.
    setError('')
    await loadDetail(listingId, readWin)
  }

  const [rangeOpen, setRangeOpen] = useState(false)

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
          {error || readError ? (
            <span className="text-xs text-warn">from the last good read</span>
          ) : (
            // Every read, not only one after Sync: the screen now reads by
            // itself, and a figure needs its time beside it to be trusted.
            readAt && <span className="text-xs text-faint">read {readAt}</span>
          )}
        </div>
      )}

      {(error || readError) && (
        <p className="text-sm text-bad bg-bad-tint border border-bad-line rounded-lg px-4 py-2">
          {error || readError}
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
              <button
                onClick={() => void exportPo()}
                disabled={exporting}
                className="min-h-11 px-4 rounded-lg bg-ok-solid disabled:opacity-50 text-on-ok text-sm font-semibold flex items-center gap-2"
              >
                <Icon name="download" size={18} />
                {exportLabel}
              </button>
              <p className="text-xs text-faint flex-1">
                Tick the listings you need for a smaller, faster file. Nothing ticked exports every listing
                in this window.
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
                {exported.photos_skipped ? (
                  <p className="text-warn">
                    {exported.photos_skipped} photo{exported.photos_skipped === 1 ? ' was' : 's were'} skipped so the
                    file could be saved inside Google&rsquo;s six-minute limit. Every figure is complete. For every
                    photo, export fewer days or one listing at a time.
                  </p>
                ) : null}
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

          <div className="flex items-center gap-2 px-0.5">
            <button
              onClick={toggleAll}
              className="min-h-11 px-3 -ml-1 inline-flex items-center gap-2 rounded-lg text-[13px] text-fg2"
            >
              <Tick on={allTicked} />
              {allTicked ? 'Clear all' : 'Select all'}
            </button>
            <span className="text-xs text-faint">
              {selected.size ? `${selected.size} of ${selectable.length} selected` : 'None selected: export takes all'}
            </span>
          </div>

          <ul className="space-y-2">
            {summary.listings.map((l) => (
              <li key={l.listing_id || l.product_name} className="bg-raised border border-line2 rounded-xl flex items-start">
                {l.listing_id ? (
                  <button
                    onClick={() => toggle(l.listing_id)}
                    role="checkbox"
                    aria-checked={selected.has(l.listing_id)}
                    aria-label={`Export ${l.product_name || l.listing_id}`}
                    className="min-h-11 min-w-11 mt-1.5 ml-1.5 inline-flex items-center justify-center shrink-0"
                  >
                    <Tick on={selected.has(l.listing_id)} />
                  </button>
                ) : (
                  // No listing id: no sheet of its own to export, so nothing to tick.
                  <span className="min-w-11 ml-1.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                <button
                  onClick={() => void openDetail(l.listing_id)}
                  className="w-full text-left pl-1 pr-4 py-3"
                >
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm text-fg font-medium truncate flex-1">
                      {l.product_name || l.listing_id}
                    </p>
                    <p className="text-sm text-fg shrink-0">${l.revenue.toFixed(2)}</p>
                  </div>
                  <p className="text-xs text-faint mt-0.5">
                    {/* "sold" not "units", to match the table below it. The
                        card said "60 units" and the table said "Units", and
                        neither said that cancelled ones were excluded from
                        both — which is the whole question somebody has when
                        the figure is lower than what was called out on air. */}
                    {l.units} sold · {l.order_count} order
                    {l.order_count === 1 ? '' : 's'}
                    {/* Shown rather than hidden: a factory asking why the number
                        is lower than what was called out on air deserves this. */}
                    {l.unsold_units > 0 && (
                      <span className="text-warn/80">
                        {' '}
                        · {unsoldText(l.unsold_units, l)}
                      </span>
                    )}
                    {/* Refunded, returning, on hold, unrecognised. A unit in
                        one of these left the sold figure without entering the
                        cancelled one, so without this line it is simply not on
                        the page — which is how a count stops reconciling. */}
                    {bucketText(tallyOf(l)) && (
                      <span className="text-warn/80"> · {bucketText(tallyOf(l))}</span>
                    )}
                    {l.latest_order_sgt && (
                      <span className="text-ghost"> · last {l.latest_order_sgt}</span>
                    )}
                  </p>
                  <p className="text-xs font-mono text-ref/70 mt-0.5">{l.listing_id}</p>
                </button>

                {openListing === l.listing_id && (
                  <div className="border-t border-line2 pl-1 pr-4 py-3">
                    {!detail ? (
                      <p className="text-xs text-faint">Loading variations…</p>
                    ) : (
                      <VariationTable detail={detail} />
                    )}
                  </div>
                )}
                </div>
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
        anyone does on this screen. Its label says what it will export: the
        ticked listings, or all of them.
      */}
      {summary && summary.listings.length > 0 && (
        <div
          className="md:hidden fixed left-0 right-0 z-10 px-3 py-1.5 bg-surface border-t border-line2"
          style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom))' }}
        >
          <div className="max-w-5xl mx-auto flex items-center gap-2">
            <button
              onClick={() => void exportPo()}
              disabled={exporting}
              className="flex-1 min-h-11 rounded-xl bg-ok-solid disabled:opacity-50 text-on-ok text-[15px] font-semibold flex items-center justify-center gap-2"
            >
              <Icon name="download" size={18} />
              {exportLabel}
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

/** A checkbox mark, drawn to match the app rather than the platform's own. */
function Tick({ on }: { on: boolean }) {
  return (
    <span
      className={`w-5 h-5 rounded-md border inline-flex items-center justify-center ${
        on ? 'bg-accent border-accent text-white' : 'bg-sunken border-line'
      }`}
    >
      {on && <Icon name="check" size={14} />}
    </span>
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
              {/* "Sold" rather than "Units", because the column carries two
                  figures and only one of them is what a factory is paid. */}
              <th className="font-normal pb-1.5 pr-3 text-right">Sold</th>
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
                {/**
                  * Each number says what it is, in the cell.
                  *
                  * It read "2 (+1)", and Brien asked whether that meant three
                  * sold with one cancelled netting two, or two sold with one
                  * cancelled netting one. It is the second — the counters are
                  * disjoint, a unit lands in one or the other, and `units` was
                  * never the larger figure. But "+" reads as an addition, and
                  * on the column a factory is paid from, having to work out
                  * which reading applies is a defect rather than a nuance.
                  *
                  * The table already scrolls sideways on a phone, so the width
                  * costs almost nothing and buys an unmisreadable number.
                  */}
                <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                  <span className="text-fg">{v.units} sold</span>
                  {v.unsold_units > 0 && (
                    <span className="text-warn/70"> · {unsoldText(v.unsold_units, v)}</span>
                  )}
                  {bucketText(tallyOf(v)) && (
                    <span className="text-warn/70"> · {bucketText(tallyOf(v))}</span>
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
        {tallyOf(detail.totals).ordered_units > tallyOf(detail.totals).sold_units && (
          // No longer explaining a notation — the cells say it themselves. This
          // says the one thing the cells cannot: that the buckets never overlap,
          // and that the sold figure is what is left after all of them.
          <span className="text-ghost">
            {' '}
            · {tallyOf(detail.totals).ordered_units} ordered, of which{' '}
            {tallyOf(detail.totals).ordered_units - tallyOf(detail.totals).sold_units} did not
            stick
          </span>
        )}
      </p>
    </div>
  )
}
