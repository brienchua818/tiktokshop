import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  api,
  ApiError,
  HEAVY_READ,
  POLL_READ,
  type ListingState,
  type LiveVariant,
  type ReadPlan,
} from '../lib/api'
import {
  allDrafts,
  getPhoto,
  MAX_AUTO_ATTEMPTS,
  isStuck,
  PARKED,
  needsAttention,
  removeDraft,
  retryDraft,
  updateDraft,
} from '../offline/queue'
import type { QueuedDraft } from '../offline/queue'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { usePageVisible } from '../hooks/usePageVisible'
import { LISTING_FULL_MARKER } from '../offline/push'
import { kickQueue } from '../offline/runner'
import {
  draftsTakenOver,
  driftedDrafts,
  landed,
  mergeRows,
  nameWithoutIdentifier,
  showsOriginalTotal,
  soldOut,
  splitRows,
} from './reconcile'
import { MAX_SKUS_PER_PRODUCT, validatePrice } from '../lib/tiktok-rules'
import Icon from '../ui/Icon'
import { useDismiss } from '../ui/useDismiss'

/** Between reads while something on the listing has not settled. */
const POLL_SETTLING_MS = 20_000
/** Between reads once everything on it has. */
const POLL_SETTLED_MS = 30_000
/** Coming back to the screen reads at once if the figures are older than this. */
const STALE_ON_RETURN_MS = 10_000
/** After a push lands, wait this long so a run of them costs one read. */
const PUSH_SETTLE_MS = 3_000

/**
 * The draft queue: what has been built, what has landed, and what has not.
 *
 * The queue pushes itself. There is no "upload now" button to forget, because
 * the failure mode being designed out is a stream's worth of SKUs sitting
 * unnoticed on someone's phone.
 */
export default function DraftQueue({
  drafts,
  listingId,
  onChanged,
  onLive,
  onDelete,
}: {
  drafts: QueuedDraft[]
  /** The listing these SKUs belong to, so its live state can be read back. */
  listingId: string | null
  onChanged: () => Promise<void>
  /**
   * Hand the listing's state upward.
   *
   * The review state and the real variation count belong in the listing bar
   * at the top of the screen, not in a banner inside this list — it is the
   * same fact, and stated here it was 400 px below the number it explains.
   */
  onLive?: (state: ListingState | null) => void
  onDelete: (draftId: string) => void | Promise<void>
}) {
  const online = useOnlineStatus()
  // Shown from the data, not from a flag a re-render can strand: a row is
  // uploading exactly when the sender has marked it so.
  const working = drafts.some((d) => d.status === 'uploading')

  /**
   * What TikTok says about this listing, as of the last refresh.
   *
   * Null until asked. A push landing means TikTok ACCEPTED the SKU, which is
   * not the same as the variation being buyable — every edit sends the whole
   * product back for review — so "pushed" on this device must not be drawn as
   * "Live". Only this can say that.
   */
  const [live, setLive] = useState<ListingState | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')

  /** The variation someone has asked to remove, awaiting their confirmation. */
  const [removing, setRemoving] = useState<LiveVariant | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  /** Stays until dismissed: a confirmation that fades is one nobody sees. */
  const [removedNote, setRemovedNote] = useState('')
  /** The variation whose stock is being changed, if any. */
  const [adjusting, setAdjusting] = useState<LiveVariant | null>(null)

  /**
   * Did the last check give up rather than answer?
   *
   * A timeout is not the same as a failure — the figures on screen are simply
   * older than they look. Saying so, with the time they are from, is what
   * replaced two minutes of a frozen "Checking…".
   */
  const stale = checkError !== '' && live !== null

  async function confirmRemove() {
    if (!removing || !listingId) return
    setRemoveBusy(true)
    setCheckError('')
    try {
      const r = await api.removeVariation(listingId, removing.tiktok_sku_id)
      setRemovedNote(
        `${r.removed} removed from TikTok. ${r.variations_now} variation${r.variations_now === 1 ? '' : 's'} remain. ` +
          'The listing goes through review again; the others stay buyable meanwhile.',
      )
      setRemoving(null)
      await refresh()
      await onChanged()
    } catch (e: unknown) {
      setCheckError(e instanceof ApiError ? e.display : String(e))
      setRemoving(null)
    } finally {
      setRemoveBusy(false)
    }
  }

  /**
   * Which read is on screen, by the order the reads were asked for.
   *
   * Reads overlap — the timer's, a tap, the one after a removal — and they do
   * not answer in the order they were sent. An answer asked for before the one
   * on screen describes the listing as it was earlier: a read sent just before
   * a removal, answering after the removal's own read, would put the removed
   * variation back on the list. So it is dropped.
   */
  const readsAsked = useRef(0)
  const readShown = useRef(0)
  /** Reads still out. The timer does not start another while any is. */
  const reading = useRef(0)
  /** A push landed while a read was out, and that read may predate it. */
  const readAgain = useRef(false)
  /** When the answer on screen arrived, on this phone's clock. */
  const lastGood = useRef(0)
  const [readAt, setReadAt] = useState(0)
  /** `live` as of now, for handlers created by an earlier render. */
  const liveNow = useRef<ListingState | null>(null)
  /**
   * Nothing is drawn, handed up or reconciled after the screen has gone. A
   * read can take forty seconds, and the listing can be closed in one.
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  function show(state: ListingState) {
    liveNow.current = state
    setLive(state)
    onLive?.(state)
  }

  /**
   * Read the listing. HEAVY_READ when somebody asked; the timer passes
   * POLL_READ. Resolves to what was shown, or null if nothing was.
   */
  async function refresh(plan: ReadPlan = HEAVY_READ): Promise<ListingState | null> {
    if (!listingId) return null
    const n = ++readsAsked.current
    reading.current++
    setChecking(true)
    try {
      const state = await api.listingState(listingId, plan)
      if (!alive.current || n < readShown.current) return null
      readShown.current = n
      lastGood.current = Date.now()
      setReadAt(lastGood.current)
      // Cleared on an answer rather than when asking, so a background read
      // does not blank "no reply" for the forty seconds it may take.
      setCheckError('')
      show(state)
      await reconcile(state)
      return state
    } catch (e: unknown) {
      // An older read failing says nothing about the newer answer on screen.
      if (alive.current && n >= readShown.current) setCheckError(e instanceof ApiError ? e.display : String(e))
      return null
    } finally {
      reading.current--
      if (alive.current) {
        setChecking(reading.current > 0)
        if (reading.current === 0 && readAgain.current) {
          readAgain.current = false
          void refresh(POLL_READ)
        }
      }
    }
  }

  /**
   * A stock change, on screen as soon as the backend has answered.
   *
   * `after` is TikTok's own figure, read back by the backend after the write,
   * so it is as good as a fresh read for this one variation. Waiting for the
   * whole listing to be read again left the old number on the row for as long
   * as that read took, and on a failed read, until the next one.
   *
   * It counts as an answer for the ordering above: a read asked for before
   * the change landed would put the old number back.
   */
  function showStock(v: LiveVariant, after: number) {
    const was = liveNow.current
    if (!was) return
    readShown.current = ++readsAsked.current
    show(withStock(was, v, after))
  }

  /** The same for a price: TikTok's figure on the row now, before the next read. */
  function showPrice(v: LiveVariant, price: string) {
    const was = liveNow.current
    if (!was) return
    readShown.current = ++readsAsked.current
    show({ ...was, variants: was.variants.map((x) => (sameVariant(x, v) ? { ...x, price } : x)) })
  }

  /**
   * The stock change may or may not have landed: look, never send it again.
   *
   * `setStock` is a delta. Repeating one that did land adds it twice, so the
   * person is shown what TikTok holds now — in the sheet they are about to
   * tap again — before they decide whether to.
   */
  async function checkStock(v: LiveVariant) {
    const state = await refresh()
    const now = state?.variants.find((x) => sameVariant(x, v))
    if (now) setAdjusting((open) => (open && sameVariant(now, open) ? now : open))
  }

  /**
   * Correct this device's drafts against what the backend recorded.
   *
   * A push whose reply was lost sits here as "failed" while the backend has
   * the row as pushed and TikTok has the variation (B9, 7 Sep). Every fetch
   * of live state is a chance to notice, so every fetch does. The backend is
   * the only party that knows whether a write happened; the phone's opinion
   * of its own failed request is not evidence.
   */
  async function reconcile(state: ListingState) {
    // Read now, not from this render: the check when a listing opens runs
    // before the screen has loaded its drafts, so the closure's `drafts` was
    // empty, nothing was ever corrected and pushed drafts — full-size photos
    // and all — piled up on the phone until somebody tapped refresh.
    const mine = await allDrafts().then((all) => all.filter((d) => d.listing_id === listingId))
    const drifted = driftedDrafts(mine, state)
    for (const d of drifted) {
      await updateDraft(d.draft_id, {
        status: 'pushed',
        error: null,
        settled: true,
        // When we LEARNED it was pushed. The backend recorded it earlier, but
        // this read is the first moment this phone could know, and it is the
        // honest lower bound: a row present in this read cannot be judged
        // absent from it.
        pushed_at: state.checked_at,
        listing_id: d.listing_id ?? state.listing_id,
      })
    }

    /**
     * Hand the record over to the backend and stop keeping a copy.
     *
     * This is what makes two phones agree. See draftsTakenOver: a draft the
     * backend has spoken about is described in two places, and two places can
     * disagree — which is exactly what Brien and Wen Xuan were looking at.
     *
     * Deliberately after the drift pass, so a draft corrected to `pushed` a
     * moment ago is considered on the SAME read rather than lingering until
     * the next one.
     */
    const takenOver = draftsTakenOver(
      drifted.length ? await allDrafts().then((all) => all.filter((d) => d.listing_id === listingId)) : mine,
      state,
    )
    for (const d of takenOver) await removeDraft(d.draft_id)

    if (drifted.length || takenOver.length) await onChanged()
  }

  // Read when the listing opens, whenever there is one: a second phone with no
  // drafts of its own still has to see what the first phone and Seller Center
  // have put on it.
  useEffect(() => {
    if (listingId) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId])

  /**
   * Read again when a push lands.
   *
   * This was meant to happen already, through an effect keyed on the number
   * of pushed drafts. It returned early once anything had been read, so after
   * the first answer a landed push changed nothing on screen until somebody
   * tapped refresh.
   *
   * "Lands" is a draft this screen saw unpushed that is now pushed. A draft
   * that arrives already pushed is one the opening read is about to cover, not
   * a push. A few seconds' wait lets a run of pushes share one read, and a
   * push landing while a read is out is remembered rather than dropped: that
   * read was asked for before it.
   */
  const statusBefore = useRef(new Map<string, QueuedDraft['status']>())
  const pushRead = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const before = statusBefore.current
    const pushedNow = drafts.some(
      (d) => d.status === 'pushed' && before.has(d.draft_id) && before.get(d.draft_id) !== 'pushed',
    )
    statusBefore.current = new Map(drafts.map((d) => [d.draft_id, d.status]))
    if (!listingId || !pushedNow || pushRead.current) return
    pushRead.current = setTimeout(() => {
      pushRead.current = null
      if (!alive.current) return
      if (reading.current > 0) readAgain.current = true
      else void refresh(POLL_READ)
    }, PUSH_SETTLE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, listingId])
  useEffect(
    () => () => {
      if (pushRead.current) clearTimeout(pushRead.current)
    },
    [],
  )

  /**
   * The list as shown: this phone's drafts plus every variation the backend
   * or TikTok has that this phone did not make, in creation order. See
   * mergeRows for why — two phones on one stream saw two different lists.
   */
  const rows = useMemo(() => mergeRows(drafts, live), [drafts, live])

  /**
   * On the listing, versus taken off it.
   *
   * Removed variations were sitting in the main list, so a listing with five
   * deletions made you scroll past five dead rows to reach the live ones. They
   * keep their own tab rather than disappearing: a removal is a decision
   * somebody made, and the record of it is worth being able to find.
   */
  const { active, removed } = useMemo(() => splitRows(rows, live), [rows, live])
  const [tab, setTab] = useState<'active' | 'removed'>('active')

  /**
   * The removed list, fetched when its tab is opened and not before.
   *
   * It used to arrive with every refresh. On Brien's 15 Sep stream that was
   * 116 rows against 12 live — ninety per cent of the payload, over 4G, then
   * sorted and rendered by the phone, on the screen that refreshes most. The
   * record is worth keeping; paying for it every few seconds is not.
   */
  const [removedRows, setRemovedRows] = useState<LiveVariant[] | null>(null)
  /** How many removals exist altogether, so the screen can say what it is not showing. */
  const [removedTotal, setRemovedTotal] = useState(0)
  const [removedBusy, setRemovedBusy] = useState(false)
  const [removedError, setRemovedError] = useState('')
  /** The variation being put back, and how many to put back with it. */
  const [restoring, setRestoring] = useState<LiveVariant | null>(null)
  const removedCount = live?.removed_count ?? removed.length

  /**
   * Read the listing again by itself while somebody is looking at it.
   *
   * It was read once on opening and then only when somebody tapped refresh
   * or this phone changed something, on the reasoning that review takes
   * minutes and a timer through a three-hour broadcast spends the shop's rate
   * limit on nothing. So a second phone did not see the first phone's SKUs
   * arrive, and a Reviewing badge stayed after TikTok had passed it, until
   * somebody thought to tap.
   *
   * What keeps the cost down instead: only while the page is visible and
   * online; one read at a time, started after the last one settles; the light
   * plan, so a slow tick is never hedged into two; and not while a sheet or
   * the remove dialog is open, so the list does not change under a thumb.
   * Twenty seconds while something is still settling, thirty once nothing is.
   * Each read is two TikTok product reads and a Sheet read — at twenty
   * seconds a three-hour stream is at most about 1,100 URL fetches per phone,
   * against Apps Script's 20,000 a day (LIMITS.md).
   */
  const settling =
    drafts.some((d) => d.status === 'pushed' && !landed(live, d.identifier)) ||
    (live?.variants ?? []).some(
      (v) => v.state === 'reviewing' || v.state === 'pending' || v.state === 'not_listed',
    )
  const pollMs = settling ? POLL_SETTLING_MS : POLL_SETTLED_MS
  useAutoRefresh({
    enabled: Boolean(listingId),
    everyMs: pollMs,
    staleAfterMs: STALE_ON_RETURN_MS,
    lastGoodAt: () => lastGood.current,
    busy: () => reading.current > 0 || adjusting !== null || removing !== null || restoring !== null,
    read: () => refresh(POLL_READ),
  })

  const loadRemoved = useCallback(async () => {
    if (!listingId) return
    setRemovedBusy(true)
    setRemovedError('')
    try {
      const r = await api.removedVariations(listingId)
      setRemovedRows(r.variants)
      setRemovedTotal(r.total ?? r.variants.length)
    } catch (e: unknown) {
      setRemovedError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setRemovedBusy(false)
    }
  }, [listingId])

  // Opening the tab is the trigger, and only the first time: it is a record,
  // so it does not change while somebody is looking at it.
  useEffect(() => {
    if (tab === 'removed' && removedRows === null && !removedBusy) void loadRemoved()
  }, [tab, removedRows, removedBusy, loadRemoved])

  // The tab only exists while there is something in it, and the moment it
  // empties the view goes back rather than showing an empty pane.
  useEffect(() => {
    if (removedCount === 0 && tab === 'removed') setTab('active')
  }, [removedCount, tab])

  const shown = tab === 'removed' ? [] : active

  /** When TikTok was last asked, in Singapore time. Empty until it has been. */
  const checkedAt = live
    ? new Date(live.checked_at).toLocaleTimeString('en-SG', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Singapore',
      })
    : ''

  /**
   * Nudge the app's sender whenever this listing's queue changes.
   *
   * The sender used to live HERE, as an effect guarded by a `working` flag, and
   * saving the next SKU mid-push tore the effect down with the flag stuck on —
   * the queue then sat at "queued, N waiting" until the listing was reopened
   * (Brien, 17 Oct; BRI21–28 reached the backend nineteen hours late). It is
   * now one loop for the whole app, in offline/runner.ts, that no screen can
   * stop. This only tells it to look now rather than at its next heartbeat.
   */
  useEffect(() => {
    if (online) kickQueue()
  }, [online, drafts])

  const allStuck = needsAttention(drafts)
  // Parked because the listing filled up, rather than because the SKU is bad.
  const full = allStuck.filter((d) => d.error?.includes(LISTING_FULL_MARKER))
  const stuck = allStuck.filter((d) => !d.error?.includes(LISTING_FULL_MARKER))

  /**
   * Move every SKU waiting on the full listing into one new continuation
   * listing.
   *
   * They share a new stream key so the first of them creates the listing and
   * the rest append to it — exactly as a fresh stream behaves, which is what
   * this is.
   */
  async function continueInNewListing() {
    const streamId = crypto.randomUUID()
    for (const draft of full) {
      await startContinuationListing(draft, streamId)
    }
    await onChanged()
  }

  if (drafts.length === 0 && !(live && live.variants.length > 0)) {
    // A card rather than bare text, because on an iPad this is a whole column.
    // Floating grey words in an empty half-screen read as something failing to
    // load; a panel reads as a place where SKUs will appear.
    return (
      <div className="bg-raised border border-line2 border-dashed rounded-xl px-4 py-8 text-center">
        <p className="text-sm text-faint">No SKUs yet</p>
        <p className="text-xs text-ghost mt-1">
          They appear here as you add them, and upload themselves.
        </p>
      </div>
    )
  }

  const renderDraft = (draft: QueuedDraft) => {
    const v = liveFor(live, draft.identifier)
    const canAdjust = Boolean(v && v.on_tiktok && !v.removed && v.stock_available !== null)
    // The same predicate the banner counts with, so the two can never
    // disagree about whether this row is still trying.
    const stuckHere = isStuck(draft)
    const error = draft.error ? draft.error.replace(LISTING_FULL_MARKER, '').trim() : ''

    // Removing from TikTok takes something away from buyers, so it asks
    // first; discarding a draft that never got there does not. One or the
    // other, never both, and neither until there is something to act on.
    const onTikTok = Boolean(v?.on_tiktok && v.tiktok_sku_id && !v.removed)
    const remove =
      draft.status !== 'pushed'
        ? { fn: () => void onDelete(draft.draft_id), label: `Delete ${draft.identifier}` }
        : onTikTok && v
          ? { fn: () => setRemoving(v), label: `Remove ${draft.identifier} from TikTok` }
          : null

    return (
      <VariantRow
        key={draft.draft_id}
        identifier={draft.identifier}
        name={draft.title}
        photo={<Thumbnail draft={draft} fallback={v?.image_url ?? ''} />}
        // TikTok's price once the backend has one: a price changed after the
        // push — here, on another phone, or in Seller Center — is not this
        // draft's. `||` rather than `??`, so an empty figure is not shown as
        // no price at all.
        price={v?.price || draft.price}
        stock={
          v ? (
            <StockState v={v} />
          ) : (
            // "Queued" here sat beside a "Sent" badge on every SKU pushed since
            // the listing was last checked, and made a healthy queue read as a
            // stuck one. Before TikTok has been asked there is no stock to show.
            <span className="text-faint shrink-0">{draft.status === 'pushed' ? '—' : 'Queued'}</span>
          )
        }
        meta={v ? variantMeta(v) : ''}
        badge={<StatusBadge draft={draft} live={v} />}
        {...(canAdjust && v ? { onOpen: () => setAdjusting(v) } : {})}
        {...(remove ? { onDelete: remove.fn, deleteLabel: remove.label } : {})}
      >
        {/* TikTok's own rejection text, verbatim. A generic "failed" is what
            makes an app impossible to recover from mid-broadcast. */}
        {error && <p className="text-[11px] text-bad">{error}</p>}
        {/* Only on a SKU that has stopped trying by itself. Offering it on one
            still counting down invites a second copy of something in flight. */}
        {stuckHere && (
          <button
            onClick={() => void retryDraft(draft.draft_id).then(onChanged)}
            className="mt-1 text-[11px] px-2.5 min-h-8 inline-flex items-center gap-1 rounded-lg bg-accent/90 hover:bg-accent text-white"
          >
            <Icon name="refresh" size={14} />
            Retry {draft.identifier}
          </button>
        )}
      </VariantRow>
    )
  }

  return (
    <div className="bg-raised border border-line2 rounded-xl overflow-hidden">
      {/*
        A 44 px header, not a card lid.

        "ON THIS LISTING" rather than "SKUs (9/10 sent)": the list is now
        everything on the listing — this phone's, other phones', Seller
        Center's — so a count of what THIS device sent is the wrong number to
        lead with. The refresh is an icon on the right, in the corner a right
        thumb reaches, and it says when it last looked rather than only whether
        it is looking now.
      */}
      <div className="flex items-center gap-2 h-11 pl-3 pr-1 border-b border-line2">
        {removedCount === 0 ? (
          <>
            <span className="text-xs font-semibold tracking-wide text-muted uppercase whitespace-nowrap">
              On this listing
            </span>
            <span className="text-xs text-faint">{active.length}</span>
          </>
        ) : (
          /* Two tabs, and only once there is a second one to show. During a
             clean stream the header reads exactly as before.

             `min-w-0` on the group and `shrink` on the buttons is not
             decoration: without it the two tabs, the freshness note and the
             refresh button together exceed 375px, and flex lets the text boxes
             collapse below their content so the words draw on top of each
             other. Truncating is the honest failure. */
          <div className="flex items-center gap-0.5 min-w-0">
            <QueueTab
              label="On listing"
              count={active.length}
              on={tab === 'active'}
              onClick={() => setTab('active')}
            />
            <QueueTab
              label="Removed"
              count={removedCount}
              on={tab === 'removed'}
              onClick={() => setTab('removed')}
            />
          </div>
        )}
        <span className="flex-1 min-w-1" />
        {working ? (
          <span className="text-xs text-info whitespace-nowrap">Uploading…</span>
        ) : !online ? (
          <span className="text-xs text-warn whitespace-nowrap">Waiting for signal</span>
        ) : stale ? (
          // A check that gave up. The last good time stays on screen, because
          // stale figures with a timestamp beat no figures at all.
          <span className="text-xs text-warn whitespace-nowrap">
            no reply · showing {checkedAt}
          </span>
        ) : (
          readAt > 0 && (
            <CheckedAge
              at={readAt}
              warnAfterMs={2 * pollMs}
              short={removedCount !== 0}
              title={`TikTok last checked at ${checkedAt}`}
            />
          )
        )}
        {listingId && (
          <button
            onClick={() => void refresh()}
            disabled={checking}
            className={`min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
              stale ? 'text-warn' : 'text-fg2'
            }`}
            aria-label="Check TikTok for this listing"
            title="Check TikTok for this listing"
          >
            <Icon name="refresh" size={20} className={checking ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      <div className="p-3 space-y-2.5">

      {removedNote && (
        <div className="flex items-start gap-2 text-xs text-ok bg-ok-tint border border-ok-line rounded-lg px-3 py-2.5">
          <p className="flex-1">{removedNote}</p>
          <button
            onClick={() => setRemovedNote('')}
            className="text-ok/70 hover:text-fg min-h-6 px-1"
            aria-label="Dismiss"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {checkError && (
        <p className="text-xs text-bad bg-bad-tint border border-bad-line rounded-lg px-3 py-2">
          {checkError}
        </p>
      )}

      {/* A full listing is not a fault — Singapore allows 100 variations per
          product, so a long factory run simply outgrows one. It gets its own
          banner and its own action, well away from the failure banner, so
          nobody reads "could not be listed" and assumes something broke. */}
      {full.length > 0 && (
        <div className="text-xs bg-warn-tint border border-warn-line rounded-lg px-3 py-2.5 space-y-2">
          <p className="text-warn">
            This listing is full at {MAX_SKUS_PER_PRODUCT} variations — TikTok's limit for
            Singapore. {full.length} SKU{full.length === 1 ? '' : 's'} waiting.
          </p>
          <button
            onClick={() => void continueInNewListing()}
            className="min-h-11 w-full rounded-lg bg-warn-solid px-3 font-medium text-on-warn active:scale-[0.99] transition-transform"
          >
            Start continuation listing
          </button>
          <p className="text-warn/60">
            Creates a second listing for the same factory run. Your SKU numbering carries on.
          </p>
        </div>
      )}

      {stuck.length > 0 && (
        <p className="text-xs text-bad bg-bad-tint border border-bad-line rounded-lg px-3 py-2">
          {stuck.length} SKU{stuck.length === 1 ? '' : 's'} could not be listed and stopped
          retrying. Fix the problem shown, then retry.
        </p>
      )}

      {restoring && (
        <RestoreSheet
          v={restoring}
          onClose={() => setRestoring(null)}
          onDone={async (note) => {
            setRestoring(null)
            setRemovedNote(note)
            setRemovedRows(null)
            await refresh()
            await onChanged()
          }}
          listingId={listingId}
        />
      )}

      {tab === 'removed' && (
        <ul className="space-y-1 max-h-80 overflow-y-auto">
          {removedBusy && <li className="text-xs text-faint py-4 text-center">Loading…</li>}
          {removedError && <li className="text-xs text-bad py-4 text-center">{removedError}</li>}
          {(removedRows ?? []).map((v) => (
            <RemoteRow
              key={`removed:${v.tiktok_sku_id || v.identifier}`}
              v={v}
              onRemove={() => {}}
              onAdjust={() => {}}
              {...(v.restorable ? { onRestore: () => setRestoring(v) } : {})}
            />
          ))}
          {removedRows !== null && removedRows.length === 0 && !removedBusy && (
            <li className="text-xs text-faint py-4 text-center">Nothing has been removed.</li>
          )}
          {/* Says what it is NOT showing, rather than letting a short list read
              as the whole history. The rest are in the Sheet, where they can be
              filtered properly — which a phone list never could. */}
          {removedRows !== null && removedTotal > removedRows.length && (
            <li className="text-[11px] text-ghost py-3 text-center">
              The {removedRows.length} most recent of {removedTotal}. The rest are in the data
              sheet.
            </li>
          )}
        </ul>
      )}

      <ul className={`space-y-1 max-h-80 overflow-y-auto${tab === 'removed' ? ' hidden' : ''}`}>
        {shown.map((row) =>
          row.kind === 'draft' ? (
            renderDraft(row.draft)
          ) : (
            <RemoteRow
              key={row.key}
              v={row.live}
              onRemove={setRemoving}
              onAdjust={setAdjusting}
            />
          ),
        )}
      </ul>
      {tab === 'active' && active.length === 0 && removed.length > 0 && (
        <p className="text-xs text-faint py-4 text-center">
          Every variation on this listing has been removed.
        </p>
      )}
      </div>

      {adjusting && (
        <StockSheet
          v={adjusting}
          listingId={listingId}
          onClose={() => setAdjusting(null)}
          onDone={async (note, changed) => {
            setRemovedNote(note)
            setAdjusting(null)
            if (changed?.stock_available !== undefined) showStock(adjusting, changed.stock_available)
            if (changed?.price !== undefined) showPrice(adjusting, changed.price)
            // Still read: the rest of the row — sold, held, the badge — is the
            // backend's to say, and only a read brings it.
            await refresh(changed ? POLL_READ : HEAVY_READ)
          }}
          onUnknown={() => void checkStock(adjusting)}
        />
      )}

      {removing && (
        <RemoveDialog
          variant={removing}
          busy={removeBusy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}
    </div>
  )
}

/**
 * The one warning in the app that stands between a tap and a loss.
 *
 * Everything else here is additive or local. This deletes a variation buyers
 * can currently purchase, and a mis-tap on a phone in a factory is not rare —
 * so it names the variation, says what changes, and puts the destructive
 * button away from where the thumb already is.
 */
function RemoveDialog({
  variant,
  busy,
  onCancel,
  onConfirm,
}: {
  variant: LiveVariant
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const label = variant.identifier || variant.variant
  // Escape backs out of a destructive confirmation, which is the one place a
  // way out matters most.
  useDismiss(busy ? () => {} : onCancel)
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-scrim px-4 pb-6 sm:pb-0"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-sm bg-surface border border-bad-line rounded-2xl p-5 space-y-3"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-fg">
          Remove <span className="font-mono text-identifier">{label}</span> from TikTok?
        </p>
        {variant.variant && variant.variant !== label && (
          <p className="text-xs text-muted -mt-1">{variant.variant}</p>
        )}
        <ul className="text-xs text-fg2 space-y-1.5 list-disc pl-4">
          <li>Buyers will no longer see or purchase this variation.</li>
          <li>Orders already placed for it are <span className="text-fg">not</span> affected.</li>
          <li>The listing goes through TikTok review again. The other variations stay buyable meanwhile.</li>
          <li className="text-warn">This cannot be undone from the app.</li>
        </ul>
        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 min-h-11 rounded-lg border border-line3 text-sm text-fg"
          >
            Keep it
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 min-h-11 rounded-lg bg-bad-solid hover:bg-bad-solid-hover disabled:opacity-50 text-sm text-fg font-medium"
          >
            {busy ? 'Removing…' : `Remove ${label}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * A draft's photo, read from IndexedDB at render time.
 *
 * `image_preview` is a `blob:` URL, and a blob URL only exists for the life of
 * the document that made it — the browser revokes it on unload. Persisting one
 * in IndexedDB therefore stores a string that is guaranteed to be dead the
 * next time the app opens, which is exactly what it looked like: this
 * session's SKU showed its photo and every earlier one showed a broken image.
 *
 * The photo itself was never lost. It is in IndexedDB beside the draft, so the
 * fix is to make the URL here and revoke it on the way out, rather than to
 * keep one across sessions. `image_preview` is still honoured when it happens
 * to be from this session, which saves a read on the row just added.
 */
/**
 * One of the queue's two tabs.
 *
 * Sized as a real touch target rather than a text link: it sits in the header
 * strip a right thumb reaches for, next to the refresh button, and a 20px word
 * there gets missed at speed.
 */
function QueueTab({
  label,
  count,
  on,
  onClick,
}: {
  label: string
  count: number
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`min-h-11 px-1.5 inline-flex items-center gap-1 rounded-lg text-[13px] font-semibold min-w-0 ${
        on ? 'text-fg' : 'text-faint'
      }`}
    >
      <span className="truncate">{label}</span>
      <span className={`font-normal shrink-0 ${on ? 'text-fg2' : 'text-ghost'}`}>{count}</span>
    </button>
  )
}

function Thumbnail({ draft, fallback }: { draft: QueuedDraft; fallback: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoke: string | null = null
    let cancelled = false

    void (async () => {
      const blob = await getPhoto(draft.draft_id)
      if (cancelled || !blob) return
      revoke = URL.createObjectURL(blob)
      setUrl(revoke)
    })()

    return () => {
      cancelled = true
      // Not revoking leaks the blob for as long as the app is open, and a
      // three-hour stream is two hundred photos.
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [draft.draft_id])

  // The local blob is the fast path and the one that works with no signal.
  // The fallback matters after a reinstall or a cache eviction, when the draft
  // row survives in the queue but its photo does not: without it a SKU this
  // phone listed itself would show an empty square.
  const src = url || fallback
  if (!src) return <div className="w-12 h-12 rounded-lg bg-chip shrink-0" />
  return <img src={src} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
}

/** The live record for one identifier, if a refresh has been done. */
function liveFor(live: ListingState | null, identifier: string): LiveVariant | null {
  return live?.variants.find((v) => v.identifier === identifier) ?? null
}

/**
 * The same variation on the listing, by TikTok's id where there is one.
 *
 * Not by identifier alone: a restored variation carries the identifier of the
 * removed one it replaces, and both can be in one read.
 */
function sameVariant(a: LiveVariant, b: LiveVariant): boolean {
  if (a.removed) return false
  if (b.tiktok_sku_id) return a.tiktok_sku_id === b.tiktok_sku_id
  return b.identifier !== '' && a.identifier === b.identifier
}

/**
 * The listing with one variation's stock changed to `after`.
 *
 * The total moves by the same amount. The backend builds it as available plus
 * sold, held, unrecognised and returning (Product.gs, `stock_total`), and a
 * stock change moves only the first of those.
 */
function withStock(state: ListingState, v: LiveVariant, after: number): ListingState {
  return {
    ...state,
    variants: state.variants.map((x) => {
      if (!sameVariant(x, v) || x.stock_available === null) return x
      const by = after - x.stock_available
      return {
        ...x,
        stock_available: after,
        stock_total: x.stock_total === null ? null : x.stock_total + by,
      }
    }),
  }
}

/**
 * How long ago TikTok was last read, as an age rather than a clock time.
 *
 * "checked 14:02" asks the reader to know what time it is now, mid-broadcast;
 * "checked 2 min ago" does not. Counted from when the answer reached this
 * phone, on this phone's clock — the backend's `checked_at` is on Google's,
 * and the two need not agree. It turns to the warning colour once it is older
 * than two polls, which means reads have stopped landing.
 */
function CheckedAge({
  at,
  warnAfterMs,
  short,
  title,
}: {
  at: number
  warnAfterMs: number
  /** Without "checked", for when the two tabs share the strip. */
  short: boolean
  title: string
}) {
  const visible = usePageVisible()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    // An interval is fine here, unlike for the reads: this only redraws a
    // label, so a late tick cannot pile up behind a slow one.
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [visible])
  const age = Math.max(0, now - at)
  return (
    <span
      className={`text-xs whitespace-nowrap shrink-0 ${age > warnAfterMs ? 'text-warn' : 'text-faint'}`}
      title={title}
    >
      {short ? ageText(age) : `checked ${ageText(age)}`}
    </span>
  )
}

function ageText(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ago`
}



/**
 * A variation this phone has no draft for: pushed from another phone, or added
 * in Seller Center. Read from the backend and TikTok, so what it can show is
 * what they know — TikTok's picture, the identifier, stock, review state — and
 * it can be removed like any other.
 */
function RemoteRow({
  v,
  onRemove,
  onAdjust,
  onRestore,
}: {
  v: LiveVariant
  onRemove: (v: LiveVariant) => void
  onAdjust: (v: LiveVariant) => void
  /** Only on a removed row that still has enough recorded to put back. */
  onRestore?: () => void
}) {
  // `buyable` is the backend's answer to "can somebody buy this right now",
  // decided from the version TikTok serves to buyers. It is the only thing
  // that may be drawn as Live. The product's own review state is no longer
  // consulted: a product can read ACTIVATE while the variation added to it
  // three minutes ago is still pending, which is exactly what told Brien a
  // variation was live when it was not.
  const badge = variantBadge(v)

  /**
   * A Seller Center variation can have its stock changed too, addressed by
   * TikTok's own id rather than by an identifier it does not have.
   *
   * It was read-only because the backend matched on our seller_sku, which such
   * a row has none of. On a listing the team has been running for a while most
   * of the variations are these, so "can we update the qty for items not
   * created on the app" was really "can we use this at all".
   */
  const canAdjust = v.on_tiktok && !v.removed && v.stock_available !== null && Boolean(v.tiktok_sku_id)
  const canRemove = v.on_tiktok && Boolean(v.tiktok_sku_id) && !v.removed

  return (
    <VariantRow
      identifier={v.identifier}
      name={v.variant}
      photo={
        v.image_url ? (
          <img src={v.image_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-chip shrink-0 flex items-center justify-center text-ghost text-[10px]">
            {v.external ? 'SC' : '—'}
          </div>
        )
      }
      price={v.price}
      stock={
        v.external ? (
          soldOut(v) ? (
            <span className="text-bad font-semibold tracking-wide shrink-0">SOLD OUT</span>
          ) : (
            <span className="text-fg2 shrink-0">{v.stock_available ?? 0} left</span>
          )
        ) : (
          <StockState v={v} />
        )
      }
      meta={variantMeta(v)}
      badge={<span className={`text-[12px] ${badge.cls}`}>{badge.text}</span>}
      {...(canAdjust ? { onOpen: () => onAdjust(v) } : {})}
      {...(canRemove
        ? { onDelete: () => onRemove(v), deleteLabel: `Remove ${v.identifier || v.variant} from TikTok` }
        : {})}
    >
      {onRestore && (
        <button
          onClick={onRestore}
          className="mt-1 text-[11px] px-2.5 min-h-8 inline-flex items-center gap-1 rounded-lg bg-chip hover:bg-raised text-fg2"
        >
          <Icon name="refresh" size={14} />
          Put {v.identifier} back
        </button>
      )}
    </VariantRow>
  )
}

/** The waits before each retry of a busy write: about 2, 4 and 6 seconds. */
const BUSY_RETRY_MS = [2_000, 4_000, 6_000]

/**
 * One key per tap, sent with every attempt of that tap.
 *
 * `crypto.randomUUID` needs a secure context and iOS 15.4 or later. The
 * fallback only has to be unique on this phone for the six hours the backend
 * remembers a key, which the time and two random draws comfortably are.
 */
function tapKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // Outside a secure context it throws rather than being absent.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/** A price as whole cents, so "12.9" and "12.90" are one price. Null when it is not a number. */
function centsOf(text: string): number | null {
  const t = text.trim()
  const n = Number(t)
  return t && Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * Stock and price for one live variation.
 *
 * Stock moves by steps both ways. Taking stock off used to mean "set an exact
 * number" worked out from the screen, and a harness showed where that goes:
 * the screen said 10, the operator meant to take 4 off and set 6, and TikTok —
 * sold down to 3 by then — was RAISED to 6. A step sends a delta, which the
 * backend applies to what TikTok holds at that moment. The exact set stays,
 * and carries the number it was worked out from, so the backend refuses it
 * rather than write over sales it never saw.
 *
 * Every tap carries one key, sent again with each retry of that tap and never
 * with another. Only a busy refusal is retried — the backend refused it before
 * doing anything. A reply that never came is never retried: the write may have
 * landed, and sending it again is how +10 became +20.
 */
export function StockSheet({
  v,
  listingId,
  onClose,
  onDone,
  onUnknown,
}: {
  v: LiveVariant
  listingId: string | null
  onClose: () => void
  /**
   * After TikTok has confirmed a change. `changed` is TikTok's own figure, for
   * a caller that wants to show it before its next read of the listing.
   */
  onDone: (note: string, changed?: { stock_available?: number; price?: string }) => Promise<void>
  /**
   * A write whose reply never came, and which may have landed. The caller
   * reads the listing back; the sheet never sends the write again.
   */
  onUnknown?: () => void
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  /** Said while a busy write waits for its next try. */
  const [retrying, setRetrying] = useState('')
  /** A write that may have landed. Nothing more is sent from this sheet once set. */
  const [unknown, setUnknown] = useState('')
  const [exact, setExact] = useState('')
  const [mode, setMode] = useState<'add' | 'set'>('add')
  const [priceText, setPriceText] = useState(v.price)
  const [confirming, setConfirming] = useState(false)
  const locked = busy !== '' || unknown !== ''
  useDismiss(busy ? () => {} : onClose)

  const now = v.stock_available ?? 0
  const label = v.identifier || v.variant

  // The same gate as stock: the sheet only opens on a variation with stock to
  // show, which means a live one. Not the listing's status as well — that is
  // read from the copy under review, which is what a listing is for most of a
  // stream, and the price would have been hidden exactly when it is needed.
  // TikTok's own rule (ACTIVATE only) is checked by the backend against the
  // live copy, and its refusal says so.
  const priceOffered = v.stock_available !== null && !v.removed
  const currentCents = centsOf(v.price)
  const currentText = currentCents === null ? v.price : (currentCents / 100).toFixed(2)
  const priceProblem = validatePrice(priceText)[0]?.message ?? ''
  const nextCents = priceProblem ? null : centsOf(priceText)
  const nextText = nextCents === null ? '' : (nextCents / 100).toFixed(2)
  const priceChanged = nextCents !== null && nextCents !== currentCents
  /**
   * A slip of the thumb that is still a valid price: 99 for 9.90, 1.29 for
   * 12.90. More than three times the current price, or under a third of it,
   * asks once more before it is sent.
   */
  const farOff =
    priceChanged &&
    currentCents !== null &&
    currentCents > 0 &&
    nextCents !== null &&
    (nextCents > currentCents * 3 || nextCents * 3 < currentCents)

  /**
   * Send one write. Retry it while the backend is busy, and in no other case.
   *
   * LISTING_BUSY is the lock refusing before anything ran, so the same request
   * again is safe — and the backend's own message promises a retry, which
   * nothing used to make. An answer that never arrived is the opposite case:
   * it is reported, handed to `onUnknown` to read back, and left alone.
   */
  async function write<T>(send: () => Promise<T>, saying: string, what: string): Promise<T | null> {
    setBusy(saying)
    setError('')
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await send()
        } catch (e: unknown) {
          if (e instanceof ApiError && e.code === 'LISTING_BUSY' && attempt < BUSY_RETRY_MS.length) {
            setRetrying(
              `Another change is saving first. Retrying (${attempt + 1} of ${BUSY_RETRY_MS.length})…`,
            )
            await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS[attempt]))
            continue
          }
          if (e instanceof ApiError && e.isOutcomeUnknown) {
            setUnknown(
              `Outcome unknown: no reply came, so the ${what} may already be on TikTok. ` +
                'It was not sent again. Checking the listing…',
            )
            onUnknown?.()
          } else if (e instanceof ApiError && e.code === 'LISTING_BUSY') {
            setError(
              `Still busy after ${BUSY_RETRY_MS.length} retries. Nothing was changed — try again in a minute.`,
            )
          } else {
            setError(e instanceof ApiError ? e.display : String(e))
          }
          return null
        }
      }
    } finally {
      setRetrying('')
      setBusy('')
    }
  }

  async function changeStock(body: { delta: number } | { absolute: number; expected_before: number }) {
    if (!listingId) return
    const key = tapKey()
    const r = await write(
      () =>
        api.setStock({
          listing_id: listingId,
          identifier: v.identifier,
          tiktok_sku_id: v.tiktok_sku_id,
          ...body,
          idempotency_key: key,
        }),
      'Changing stock on TikTok…',
      'stock change',
    )
    // TikTok's number, not ours. "Set to 31" is a promise; "31 left" is a fact.
    if (r) await onDone(`${r.identifier || v.variant}: ${r.after} left, was ${r.before}.`, { stock_available: r.after })
  }

  async function savePrice() {
    if (!listingId || !priceChanged) return
    if (farOff && !confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    const r = await write(
      () =>
        api.setPrice({
          listing_id: listingId,
          identifier: v.identifier,
          tiktok_sku_id: v.tiktok_sku_id,
          price: nextText,
          expected_before: v.price,
        }),
      'Changing the price on TikTok…',
      'price change',
    )
    if (!r) return
    const name = r.identifier || label
    if (r.unchanged) {
      await onDone(`${name} is already $${r.after} on TikTok. Nothing was changed.`, { price: r.after })
      return
    }
    // TikTok's figure, read back from what buyers see.
    await onDone(
      `${name}: now $${r.after}, was $${r.before}.` +
        (r.pending_price
          ? ` The listing's copy under review still shows $${r.before}; TikTok will catch up, and pushes meanwhile keep $${r.after}.`
          : ''),
      { price: r.after },
    )
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-scrim" onClick={busy ? undefined : onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${priceOffered ? 'Stock and price' : 'Stock'} for ${label}`}
        className="relative w-full sm:max-w-sm max-h-full overflow-y-auto bg-surface border-t sm:border border-line rounded-t-2xl sm:rounded-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-3"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-mono text-identifier">{v.identifier || 'Seller Center'}</p>
            <p className="text-sm text-fg truncate">{v.variant}</p>
            <p className="text-xs text-faint mt-0.5">
              {now} left on TikTok
              {v.sold !== null && v.sold > 0 && ` · ${v.sold} sold`}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy !== ''}
            className="min-h-11 min-w-11 -mr-1 -mt-1 inline-flex items-center justify-center text-muted disabled:opacity-40"
            aria-label="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {mode === 'add' ? (
          <>
            {/* The amounts a factory run actually uses, both ways, and the
                same size both ways: taking stock off is as ordinary as adding
                it. One tap, no keyboard, no mental arithmetic. */}
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Add stock</p>
              <div className="grid grid-cols-4 gap-2">
                {[1, 5, 10, 20].map((n) => (
                  <button
                    key={n}
                    onClick={() => void changeStock({ delta: n })}
                    disabled={locked}
                    aria-label={`Add ${n}`}
                    className="min-h-12 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-[15px] font-semibold text-white"
                  >
                    +{n}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Take stock off</p>
              <div className="grid grid-cols-4 gap-2">
                {[1, 5, 10].map((n) => {
                  // TikTok's floor is 1. Greyed out on the number shown; the
                  // backend refuses by name if sales have got there first.
                  const belowFloor = now - n < 1
                  return (
                    <button
                      key={n}
                      onClick={() => void changeStock({ delta: -n })}
                      disabled={locked || belowFloor}
                      aria-label={`Take ${n} off`}
                      title={belowFloor ? `Only ${now} left, and TikTok cannot go below 1` : undefined}
                      className="min-h-12 rounded-xl border border-line3 bg-chip2 hover:bg-chip disabled:opacity-40 text-[15px] font-semibold text-fg"
                    >
                      −{n}
                    </button>
                  )
                })}
              </div>
            </div>
            <button
              onClick={() => setMode('set')}
              disabled={locked}
              className="min-h-11 w-full text-xs text-muted underline disabled:opacity-40"
            >
              Set an exact number instead
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                inputMode="numeric"
                value={exact}
                onChange={(e) => setExact(e.target.value)}
                placeholder={String(now)}
                aria-label="Exact stock"
                className="flex-1 min-w-0 bg-sunken border border-line rounded-lg px-3 h-12 text-sm text-fg outline-none focus:border-accent"
              />
              <button
                onClick={() => void changeStock({ absolute: Number(exact), expected_before: now })}
                disabled={locked || !/^\d+$/.test(exact.trim()) || Number(exact) < 1}
                className="min-h-12 px-4 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-[15px] font-semibold text-white shrink-0"
              >
                Set
              </button>
            </div>
            {/* TikTok's floor is 1, not 0. Said before somebody types 0 and
                waits, rather than after. */}
            <p className="text-xs text-ghost">
              1 to 99,999. TikTok cannot set a variation to zero — remove it instead. If sales
              have moved it off {now} by the time this arrives, nothing changes and you are told.
            </p>
            <button
              onClick={() => setMode('add')}
              disabled={locked}
              className="min-h-11 w-full text-xs text-muted underline disabled:opacity-40"
            >
              Back to adding and taking off
            </button>
          </>
        )}

        {priceOffered && (
          <div className="space-y-1.5 border-t border-hair pt-3">
            <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Price</p>
            <div className="flex items-center gap-2">
              <span className="text-sm text-faint shrink-0">$</span>
              <input
                inputMode="decimal"
                value={priceText}
                onChange={(e) => {
                  setPriceText(e.target.value)
                  setConfirming(false)
                }}
                disabled={locked}
                aria-label="New price"
                className="flex-1 min-w-0 bg-sunken border border-line rounded-lg px-3 h-12 text-sm text-fg tabular-nums outline-none focus:border-accent disabled:opacity-60"
              />
              <button
                onClick={() => void savePrice()}
                disabled={locked || !priceChanged}
                className={`min-h-12 px-4 rounded-xl disabled:opacity-40 text-[15px] font-semibold shrink-0 ${
                  confirming ? 'bg-warn-solid text-on-warn' : 'bg-accent hover:bg-accent-hover text-white'
                }`}
              >
                {confirming ? `Confirm $${nextText}` : 'Save price'}
              </button>
            </div>
            {priceChanged && (
              <p className="text-xs text-fg2 tabular-nums">
                ${currentText} → ${nextText}
              </p>
            )}
            {confirming && currentCents !== null && nextCents !== null && (
              <p className="text-xs text-warn">
                {nextCents > currentCents
                  ? `That is more than three times the current $${currentText}.`
                  : `That is under a third of the current $${currentText}.`}{' '}
                Check it, then tap Confirm if ${nextText} is right.
              </p>
            )}
            {priceProblem && priceText.trim() !== v.price.trim() && (
              <p className="text-xs text-bad">{priceProblem}</p>
            )}
          </div>
        )}

        {busy && !retrying && <p className="text-xs text-info">{busy}</p>}
        {retrying && <p className="text-xs text-warn">{retrying}</p>}
        {unknown && (
          <p className="text-xs text-warn bg-warn-tint border border-warn-line rounded-lg px-3 py-2">
            {unknown}
          </p>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <p className="text-xs text-ghost">
          Stock and price changes publish immediately. Adding a variation is what sends the
          listing back through review; this does not.
        </p>
      </div>
    </div>
  )
}

/**
 * One variation, as one row, for both kinds of row there are.
 *
 * Brien, 8 Sep: "the uxui now sucks. Image size seems wrong. Each row and font
 * size all suddenly don't look aligned and neat anymore." He was right, and no
 * single change caused it: the row took six today — a bigger photo, a sold
 * count, a cancelled count, SOLD OUT, a tappable stock figure, an affordance
 * for it — each landing in whichever of the TWO duplicated row markups it
 * touched. Nothing was ever redesigned. It accreted.
 *
 * So there is one row now, and it holds to three rules.
 *
 *   1. EVERY ROW IS THE SAME HEIGHT. It was three lines for a variation with
 *      nobody recorded against it and four for one with, so the list had no
 *      rhythm and the photo matched neither. Two lines of text, always,
 *      whatever is missing.
 *   2. THE PHOTO SETS THE HEIGHT and everything centres against it. A 56px
 *      photo against a text block of 48 or 64 floated high on one row and low
 *      on the next; 48px against a fixed two lines cannot.
 *   3. TWO TEXT SIZES, NOT ONE. Everything was 12px in four different greys,
 *      which is exactly why it read as mush. 13px for what identifies the
 *      variation, 11px for what qualifies it, so the size carries the
 *      hierarchy and the colours do not have to.
 *
 * The whole row is the control for changing stock, which is why there is no
 * plus icon and no dotted underline — both were tried today and both were
 * worse. A 48px full-width target beats a 12px squiggle, costs nothing
 * visually, and is what a list row does everywhere else. Delete is a sibling
 * rather than a nested button, so the markup is valid and the two targets
 * cannot overlap.
 */
function VariantRow({
  identifier,
  name,
  photo,
  price,
  stock,
  meta,
  badge,
  onOpen,
  onDelete,
  deleteLabel,
  children,
}: {
  identifier: string
  name: string
  photo: ReactNode
  price: string
  /** The stock state, already worded and coloured. */
  stock: ReactNode
  /** Sold, cancelled, who listed it: everything that qualifies the row. */
  meta: string
  badge: ReactNode
  /** Opens the stock sheet. Absent while there is no stock to change. */
  onOpen?: () => void
  onDelete?: () => void
  deleteLabel?: string
  /** An error and a retry, below the row rather than crammed inside it. */
  children?: ReactNode
}) {
  /**
   * Read at arm's length, in a factory, holding a phone in one hand.
   *
   * Brien, 15 Sep: *"we could try to make some of the texts in the listing tab
   * bigger as it's all super small now. But don't spoil overall look."* Both
   * halves matter — an earlier pass at this scale made every row a different
   * size and he said the layout had stopped looking neat.
   *
   * So only the things somebody actually reads mid-broadcast grow, and the
   * hierarchy between them is preserved rather than flattened:
   *
   *   15px  identifier, name, price — what is called out on air
   *   13px  stock — the number a decision is made on
   *   12px  sold, refunded, who listed it — wanted, but not at a glance
   *
   * Two steps between the top and the bottom, as before. The type got bigger;
   * the relationships did not change.
   */
  const inner = (
    <>
      {photo}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-mono font-semibold text-identifier shrink-0">
            {identifier || '—'}
          </span>
          <span className="text-[15px] text-fg truncate">
            {nameWithoutIdentifier(name, identifier)}
          </span>
        </span>
        <span className="flex items-baseline gap-1.5 text-[13px] mt-0.5">
          {stock}
          {meta && <span className="text-[12px] text-ghost truncate">{meta}</span>}
        </span>
      </span>
      <span className="shrink-0 flex flex-col items-end gap-0.5 pl-1.5">
        {price && <span className="text-[15px] text-fg2 tabular-nums">${price}</span>}
        {badge}
      </span>
    </>
  )

  return (
    <li className="border-b border-hair last:border-0">
      <div className="flex items-stretch">
        {onOpen ? (
          <button
            onClick={onOpen}
            className="flex-1 min-w-0 flex items-center gap-3 py-2.5 text-left active:bg-chip rounded-lg"
            aria-label={`Stock and price for ${identifier || name}`}
          >
            {inner}
          </button>
        ) : (
          <div className="flex-1 min-w-0 flex items-center gap-3 py-2.5">{inner}</div>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="text-ghost hover:text-bad w-11 flex items-center justify-center shrink-0"
            aria-label={deleteLabel}
          >
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
      {children && <div className="pb-2 -mt-1 pl-[3.375rem]">{children}</div>}
    </li>
  )
}

/**
 * The stock state as one short phrase that never wraps.
 *
 * Split out so both kinds of row read identically, and so the states a
 * variation can be in are visible in one place rather than spread across two
 * markups — which is how "Missing" and then "Failed" both ended up wrong
 * earlier in this build.
 */
function StockState({ v }: { v: LiveVariant }) {
  // One switch on one field. Every case the backend can report has a line
  // here, so a new state cannot fall through to a stock figure that does not
  // exist — which is how "SOLD OUT" ended up on variations that had never been
  // on sale.
  switch (v.state) {
    case 'removed':
      return <span className="text-faint shrink-0">Removed</span>
    case 'reviewing':
      // TikTok has it; nobody can buy it. Deliberately not a quantity: the
      // pending version carries one, and showing it invites counting on stock
      // that is not for sale.
      return <span className="text-warn/90 shrink-0">Reviewing</span>
    case 'pending':
      // In neither version, but TikTok issued an id when it was created. In
      // flight, not lost — and telling somebody to retry one that is merely
      // pending adds a second copy.
      return <span className="text-warn/90 shrink-0">Pending</span>
    case 'not_listed':
      return <span className="text-warn/90 shrink-0">Not shown yet</span>
  }
  if (soldOut(v)) {
    return <span className="text-bad font-semibold tracking-wide shrink-0">SOLD OUT</span>
  }
  return (
    <span className="text-fg2 shrink-0">
      {v.stock_available} left
      {showsOriginalTotal(v) && <span className="text-faint"> of {v.stock_total}</span>}
    </span>
  )
}

/**
 * Put a removed variation back, asking for the stock rather than assuming it.
 *
 * The recorded figure is what it was LISTED with, not what was left when it
 * was taken off. Those differ the moment anything sells, so restoring with the
 * original number would put units back on sale that were already bought — and
 * a livestream oversell is a refund and an apology, not a rounding error.
 *
 * So the number is shown, editable, and explained. Defaulting to it and saying
 * where it came from is honest; using it silently is not.
 */
function RestoreSheet({
  v,
  listingId,
  onClose,
  onDone,
}: {
  v: LiveVariant
  listingId: string | null
  onClose: () => void
  onDone: (note: string) => Promise<void>
}) {
  useDismiss(onClose)
  const [stock, setStock] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run() {
    const want = Number(stock)
    if (!Number.isFinite(want) || want < 1) {
      setError('TikTok needs at least 1 in stock \u2014 there is no way to list a variation with none.')
      return
    }
    if (!listingId) return
    setBusy(true)
    setError('')
    try {
      const r = await api.restoreVariation(listingId, v.identifier, want)
      await onDone(
        `${r.identifier} is back on the listing with ${r.stock} in stock. ` +
          'It is a new variation, so TikTok reviews it again before anyone can buy it.',
      )
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-scrim" onClick={busy ? undefined : onClose} />
      <div className="relative w-full sm:max-w-sm bg-surface border-t sm:border border-line rounded-t-2xl sm:rounded-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-mono text-identifier">{v.identifier}</p>
            <p className="text-sm text-fg truncate">
              {nameWithoutIdentifier(v.variant, v.identifier) || v.variant}
            </p>
            <p className="text-xs text-faint mt-0.5">${v.price}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="min-h-11 min-w-11 -mr-1 -mt-1 inline-flex items-center justify-center text-muted disabled:opacity-40"
            aria-label="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="block">
          <span className="block text-xs text-muted mb-1">How many to put back on sale</span>
          <input
            autoFocus
            inputMode="numeric"
            value={stock}
            onChange={(e) => {
              setStock(e.target.value)
              setError('')
            }}
            className="w-full bg-sunken border border-line rounded-lg px-3 py-2.5 text-base text-fg outline-none focus:border-accent"
          />
        </label>
        <p className="text-[11px] text-ghost">
          Not the number it was listed with — that one is from before anything sold, and using it
          would put units back on sale that are already gone.
        </p>
        {error && (
          <p className="text-xs text-bad bg-bad-tint border border-bad-line rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 min-h-11 rounded-lg border border-line text-sm text-fg2"
          >
            Cancel
          </button>
          <button
            onClick={() => void run()}
            disabled={busy}
            className="flex-1 min-h-11 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 text-sm text-fg"
          >
            {busy ? 'Putting back\u2026' : `Put ${v.identifier} back`}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The status word for a variation, from the backend's own state.
 *
 * Shared by the two kinds of row so they cannot drift — which they did: a
 * draft row and a remote row had separate badge logic and disagreed about the
 * same variation.
 */
function variantBadge(v: LiveVariant): { text: string; cls: string } {
  switch (v.state) {
    case 'live':
      return { text: 'Live', cls: 'text-ok' }
    case 'reviewing':
      return { text: 'Reviewing', cls: 'text-warn' }
    case 'pending':
      return { text: 'Pending', cls: 'text-warn' }
    case 'removed':
      return { text: 'Removed', cls: 'text-faint' }
    default:
      return { text: 'Not on TikTok', cls: 'text-muted' }
  }
}

/** Sold, cancelled and who listed it, as one line that truncates. */
function variantMeta(v: LiveVariant): string {
  const bits: string[] = []
  if (v.sold !== null && v.sold > 0) bits.push(`${v.sold} sold`)
  // Each shown on its own, never netted into the sold figure. A factory asking
  // "why is this less than we called out" deserves the breakdown, and a single
  // number that has had deductions folded into it silently is unexplainable.
  if (v.refunded !== null && v.refunded > 0) bits.push(`${v.refunded} refunded`)
  if (v.at_risk !== null && v.at_risk > 0) bits.push(`${v.at_risk} returning`)
  if (v.held !== null && v.held > 0) bits.push(`${v.held} unconfirmed`)
  // An order nobody has paid for yet is not a cancellation. It read as one,
  // so a sale placed a moment ago showed on the row as "1 cancelled".
  if (v.unpaid != null && v.unpaid > 0) bits.push(`${v.unpaid} awaiting payment`)
  if (v.cancelled !== null && v.cancelled > 0) bits.push(`${v.cancelled} cancelled`)
  if (v.external) bits.push('added outside this app')
  else if (v.created_by) bits.push(v.created_by)
  return bits.length ? `· ${bits.join(' · ')}` : ''
}

function StatusBadge({ draft, live }: { draft: QueuedDraft; live: LiveVariant | null }) {
  /**
   * Once the backend knows about it, the backend's word is the badge.
   *
   * This used to decide Live from two things this screen could see: that the
   * variation was in the read, and that the PRODUCT's review state was
   * ACTIVATE. Both can be true while the variation itself is still pending —
   * a product stays ACTIVATE while an edit adding a variation to it goes
   * through review — which is how a variation nobody could buy was badged
   * Live during Brien's 15 Sep broadcast.
   *
   * `variantBadge` reads the backend's own state, decided from the version
   * TikTok actually serves to buyers, and is shared with the remote row so the
   * two kinds of row cannot disagree about the same variation.
   */
  if (draft.status === 'pushed') {
    if (live) {
      const badge = variantBadge(live)
      return <span className={`text-[12px] ${badge.cls}`}>{badge.text}</span>
    }
    // Pushed, and the backend has not covered it in a read yet. Accepted, not
    // yet confirmed — and not claimed as anything stronger.
    return (
      <span className="text-[12px] text-muted" title="Accepted; waiting for the next check">
        Sent
      </span>
    )
  }
  if (draft.status === 'uploading') return <span className="text-[12px] text-info">…</span>
  if (draft.status === 'failed') {
    // Still inside its automatic attempts: the queue will push it again by
    // itself (or find it already landed). "Failed" here sent someone to
    // Seller Center for a SKU that was minutes from sorting itself out.
    if (!isStuck(draft)) {
      return (
        <span className="text-[12px] text-warn" title={`attempt ${draft.attempts} of ${MAX_AUTO_ATTEMPTS}; will retry`}>
          Retrying
        </span>
      )
    }
    return (
      <span
        className="text-[12px] text-bad"
        title={
          draft.retryAfter === PARKED
            ? 'TikTok will refuse this again unchanged, so it was not retried'
            : `${draft.attempts} attempts`
        }
      >
        Failed
      </span>
    )
  }
  return <span className="text-[12px] text-faint">Queued</span>
}

/**
 * Push the SKU that was parked when its listing filled up, into a new
 * continuation listing.
 *
 * Deliberately a separate, explicit action rather than an automatic fallback:
 * it creates a product in the live shop, and the operator should know a second
 * listing now exists for the same factory run.
 */
export async function startContinuationListing(
  draft: QueuedDraft,
  streamId: string,
): Promise<void> {
  await updateDraft(draft.draft_id, {
    // A new stream key, shared by everything moving across, because these
    // drafts now belong to the continuation listing rather than the full one.
    // Clearing listing_id is what makes the first of them create it.
    stream_id: streamId,
    listing_id: null,
    // Remembered so the server can read the full listing's own title and
    // derive the continuation's from it — nobody names a product mid-stream.
    continues_from: draft.listing_id,
    status: 'queued',
    error: null,
    attempts: 0,
    retryAfter: 0,
  })
}
