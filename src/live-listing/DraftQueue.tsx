import { useEffect, useMemo, useState } from 'react'
import { api, ApiError, type ListingState, type LiveVariant } from '../lib/api'
import { toBase64 } from '../lib/bytes'
import {
  afterAttempt,
  backfillListingId,
  allDrafts,
  MAX_AUTO_ATTEMPTS,
  nextBatch,
  getPhoto,
  needsAttention,
  retryDraft,
  updateDraft,
} from '../offline/queue'
import type { QueuedDraft } from '../offline/queue'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { toSquareJpeg } from '../capture/camera'
import { driftedDrafts, landed, mergeRows, soldOut, splitRows } from './reconcile'
import { MAX_SKUS_PER_PRODUCT } from '../lib/tiktok-rules'
import Icon from '../ui/Icon'
import { useDismiss } from '../ui/useDismiss'

/**
 * Marks a draft parked because its listing is full, as opposed to one parked
 * because TikTok refused it.
 *
 * A string marker rather than a status field because the two are the same
 * queue state — out of automatic attempts, waiting for a person — differing
 * only in what the person should do about it.
 */
export const LISTING_FULL_MARKER = '[listing-full]'

/**
 * Side of the export thumbnail made at push time. 400 px is 160,000 pixels —
 * a sixth of Sheets' cap — and still three times the 128 px it is drawn at.
 */
export const EXPORT_THUMB_PX = 400

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
  const [working, setWorking] = useState(false)

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

  async function refresh() {
    if (!listingId) return
    setChecking(true)
    setCheckError('')
    try {
      const state = await api.listingState(listingId)
      setLive(state)
      onLive?.(state)
      await reconcile(state)
    } catch (e: unknown) {
      setCheckError(e instanceof ApiError ? e.display : String(e))
    } finally {
      setChecking(false)
    }
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
    const drifted = driftedDrafts(drafts, state)
    if (!drifted.length) return
    for (const d of drifted) {
      await updateDraft(d.draft_id, {
        status: 'pushed',
        error: null,
        settled: true,
        listing_id: d.listing_id ?? state.listing_id,
      })
    }
    await onChanged()
  }

  // Checked once when there is something to check, and after that on request.
  // Not polled: it is a TikTok call per refresh, review takes minutes rather
  // than seconds, and a timer firing through a three-hour broadcast would
  // spend the shop's rate limit on nothing.
  // Whenever there is a listing: a second phone with no drafts of its own
  // still has to see what the first phone and Seller Center have put on it.
  const pushedCount = drafts.filter((d) => d.status === 'pushed').length
  useEffect(() => {
    if (!listingId || live || checking) return
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId, pushedCount])

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
  const { active, removed } = useMemo(() => splitRows(rows), [rows])
  const [tab, setTab] = useState<'active' | 'removed'>('active')

  // The tab only exists while there is something in it, and the moment it
  // empties the view goes back rather than showing an empty pane.
  useEffect(() => {
    if (removed.length === 0 && tab === 'removed') setTab('active')
  }, [removed.length, tab])

  const shown = tab === 'removed' ? removed : active

  /** When TikTok was last asked, in Singapore time. Empty until it has been. */
  const checkedAt = live
    ? new Date(live.checked_at).toLocaleTimeString('en-SG', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Singapore',
      })
    : ''

  // Drain the queue whenever the connection returns or new work appears.
  // A single in-flight guard keeps a reconnect from starting a second pass
  // over the same items.
  useEffect(() => {
    if (!online || working) return
    const due = nextBatch(drafts)
    if (due.length === 0) return

    let cancelled = false
    setWorking(true)
    void (async () => {
      for (const draft of due) {
        if (cancelled) break
        await pushOne(draft)
        await onChanged()
      }
      if (!cancelled) setWorking(false)
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const renderDraft = (draft: QueuedDraft) => (
    <li
      key={draft.draft_id}
      className="flex items-start gap-2 py-1.5 border-b border-hair last:border-0"
    >
      <Thumbnail draft={draft} fallback={liveFor(live, draft.identifier)?.image_url ?? ''} />

      <div className="min-w-0 flex-1">
        <p className="text-xs font-mono text-identifier">{draft.identifier}</p>
        <p className="text-xs text-muted truncate">{draft.title}</p>

        {/* Stock as TikTok has it, once a refresh has been done. Sold is
            derived — set minus what remains — because the product API
            reports no sold count; that lives in orders. Labelled so
            nobody takes it for TikTok's own figure. */}
        {liveFor(live, draft.identifier) && <StockLine v={liveFor(live, draft.identifier)!} />}

        {/* TikTok's own rejection text, verbatim. A generic "failed" is
            what makes the current app hard to recover from. */}
        {draft.error && (
          <p className="text-xs text-bad mt-0.5">
            {/* The marker is for the code, not the operator. */}
            {draft.error.replace(LISTING_FULL_MARKER, '').trim()}
          </p>
        )}

        {/* Only on a SKU that has stopped trying by itself. Offering it
            on one still counting down would invite a second push of
            something already in flight. */}
        {draft.status === 'failed' && draft.attempts >= MAX_AUTO_ATTEMPTS && (
          <button
            onClick={() => void retryDraft(draft.draft_id).then(onChanged)}
            className="mt-1 text-xs px-2.5 min-h-8 inline-flex items-center gap-1 rounded-lg bg-accent/90 hover:bg-accent text-white"
          >
            <Icon name="refresh" size={14} />
            Retry {draft.identifier}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-faint">${draft.price}</span>
        <StatusBadge
          draft={draft}
          live={liveFor(live, draft.identifier)}
          productStatus={live?.product_status ?? null}
        />
        {draft.status !== 'pushed' ? (
          // Not on TikTok yet: deleting only discards the local draft, so
          // no confirmation stands between the tap and the result.
          <button
            onClick={() => void onDelete(draft.draft_id)}
            className="text-ghost hover:text-bad min-h-11 min-w-9 flex items-center justify-center"
            aria-label={`Delete ${draft.identifier}`}
          >
            <Icon name="trash" size={16} />
          </button>
        ) : (
          // On TikTok: this takes something away from buyers, so it asks
          // first. Only offered once TikTok is actually showing it —
          // there is nothing to remove by id until then.
          (() => {
            const v = liveFor(live, draft.identifier)
            return v?.on_tiktok && v.tiktok_sku_id && !v.removed ? (
              <button
                onClick={() => setRemoving(v)}
                className="text-ghost hover:text-bad min-h-11 min-w-9 flex items-center justify-center"
                aria-label={`Remove ${draft.identifier} from TikTok`}
              >
                <Icon name="trash" size={16} />
              </button>
            ) : null
          })()
        )}
      </div>
    </li>
  )

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
        {removed.length === 0 ? (
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
              count={removed.length}
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
          checkedAt && (
            <span
              className="text-xs text-faint whitespace-nowrap shrink-0"
              title={`TikTok last checked at ${checkedAt}`}
            >
              {removed.length === 0 ? `checked ${checkedAt}` : checkedAt}
            </span>
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

      <ul className="space-y-1 max-h-80 overflow-y-auto">
        {shown.map((row) =>
          row.kind === 'draft' ? (
            renderDraft(row.draft)
          ) : (
            <RemoteRow
              key={row.key}
              v={row.live}
              productStatus={live?.product_status ?? null}
              onRemove={setRemoving}
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
  if (!src) return <div className="w-14 h-14 rounded-lg bg-chip shrink-0" />
  return <img src={src} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />
}

/** The live record for one identifier, if a refresh has been done. */
function liveFor(live: ListingState | null, identifier: string): LiveVariant | null {
  return live?.variants.find((v) => v.identifier === identifier) ?? null
}



/**
 * A variation this phone has no draft for: pushed from another phone, or added
 * in Seller Center. Read from the backend and TikTok, so what it can show is
 * what they know — TikTok's picture, the identifier, stock, review state — and
 * it can be removed like any other.
 */
function RemoteRow({
  v,
  productStatus,
  onRemove,
}: {
  v: LiveVariant
  productStatus: string | null
  onRemove: (v: LiveVariant) => void
}) {
  const badge = v.external
    ? { text: 'Live', cls: 'text-ok' }
    : v.removed
      ? { text: 'Removed', cls: 'text-faint' }
      : !v.on_tiktok
        ? { text: 'Reviewing', cls: 'text-warn' }
        : productStatus === 'ACTIVATE'
          ? { text: 'Live', cls: 'text-ok' }
          : { text: 'Sent', cls: 'text-muted' }
  const who = v.external ? 'added outside this app' : v.created_by ? `listed by ${v.created_by}` : 'listed from another phone'
  return (
    <li className="flex items-start gap-2 py-1.5 border-b border-hair last:border-0">
      {v.image_url ? (
        <img src={v.image_url} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />
      ) : (
        <div className="w-14 h-14 rounded-lg bg-chip shrink-0 flex items-center justify-center text-ghost text-[10px]">
          {v.external ? 'SC' : '—'}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-mono text-identifier">{v.identifier || '—'}</p>
        <p className="text-xs text-muted truncate">{v.variant}</p>
        <p className="text-xs text-ghost">{who}</p>
        {!v.external && <StockLine v={v} />}
        {v.external && (
          soldOut(v) ? (
            <p className="text-xs mt-0.5">
              <span className="text-bad font-semibold tracking-wide">SOLD OUT</span>
            </p>
          ) : (
            <p className="text-xs text-faint mt-0.5">{v.stock_available ?? 0} in stock</p>
          )
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {v.price && <span className="text-xs text-faint">${v.price}</span>}
        <span className={`text-xs ${badge.cls}`}>{badge.text}</span>
        {v.on_tiktok && v.tiktok_sku_id && !v.removed && (
          <button
            onClick={() => onRemove(v)}
            className="text-ghost hover:text-bad min-h-11 min-w-9 flex items-center justify-center"
            aria-label={`Remove ${v.identifier || v.variant} from TikTok`}
          >
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
    </li>
  )
}

function StockLine({ v }: { v: LiveVariant }) {
  if (!v.on_tiktok) {
    // Deleted on purpose. Stated plainly and without alarm — somebody made
    // this decision, and the app agreeing with reality beats it insisting the
    // SKU should still be there.
    if (v.removed) {
      return <p className="text-xs text-faint mt-0.5">Removed from TikTok.</p>
    }
    // Absence is not loss. TikTok omits a variation still under review, so a
    // SKU it has issued an id for is waiting, not gone — B5 read as missing
    // and went live minutes later. Calling that "retry this SKU" invites a
    // second copy of something already on its way.
    if (v.under_review) {
      return (
        <p className="text-xs text-warn/90 mt-0.5">
          Under review — not shown by TikTok yet. Nothing to do.
        </p>
      )
    }
    // Ambiguous, and said so. Telling someone to retry a variation that is
    // merely pending adds a second copy, so this stops short of advising it.
    return (
      <p className="text-xs text-warn/90 mt-0.5">
        Not shown by TikTok yet. If it has not appeared in 30 minutes it was not added.
      </p>
    )
  }
  // Nothing left. Said in red and in words, because "0 left of 2" is the same
  // shape as every other stock line and gets read as a number rather than as
  // the one state that needs acting on mid-broadcast.
  if (soldOut(v)) {
    return (
      <p className="text-xs mt-0.5">
        <span className="text-bad font-semibold tracking-wide">SOLD OUT</span>
        {v.sold !== null && v.sold > 0 && (
          <span className="text-faint"> · all {v.sold} sold</span>
        )}
      </p>
    )
  }
  return (
    <p className="text-xs text-faint mt-0.5">
      <span className="text-fg2">{v.stock_available}</span> left of {v.stock_set}
      {v.sold !== null && v.sold > 0 && (
        <span className="text-ok/80"> · {v.sold} sold</span>
      )}
    </p>
  )
}

/**
 * The state of one SKU, from this device's view and TikTok's.
 *
 * "Pushed" used to be drawn as "Live", which was wrong in a way that mattered:
 * TikTok accepting a SKU only starts a review, and every added variation sends
 * the whole product back through it. So a sent SKU reads as "Sent" until a
 * refresh confirms the listing is ACTIVATE, and only then as "Live".
 */
function StatusBadge({
  draft,
  live,
  productStatus,
}: {
  draft: QueuedDraft
  live: LiveVariant | null
  /** TikTok's review state for the whole product — what decides "Live". */
  productStatus: string | null
}) {
  if (draft.status === 'pushed') {
    if (live && !live.on_tiktok) {
      if (live.removed) return <span className="text-xs text-faint">Removed</span>
      return <span className="text-xs text-warn">Reviewing</span>
    }
    // Buyable requires two things: TikTok has the variation, and the product
    // it belongs to has cleared review. A variation can exist while the
    // product is still PENDING, and it is not purchasable then.
    if (live?.on_tiktok && productStatus === 'ACTIVATE') {
      return <span className="text-xs text-ok">Live</span>
    }
    return (
      <span className="text-xs text-muted" title="Accepted by TikTok; see the listing status above">
        Sent
      </span>
    )
  }
  if (draft.status === 'uploading') return <span className="text-xs text-info">…</span>
  if (draft.status === 'failed') {
    // Still inside its automatic attempts: the queue will push it again by
    // itself (or find it already landed). "Failed" here sent someone to
    // Seller Center for a SKU that was minutes from sorting itself out.
    if (draft.attempts < MAX_AUTO_ATTEMPTS) {
      return (
        <span className="text-xs text-warn" title={`attempt ${draft.attempts} of ${MAX_AUTO_ATTEMPTS}; will retry`}>
          Retrying
        </span>
      )
    }
    return (
      <span className="text-xs text-bad" title={`${draft.attempts} attempts`}>
        Failed
      </span>
    )
  }
  return <span className="text-xs text-faint">Queued</span>
}

/**
 * Push one draft, recording the outcome either way.
 *
 * Marking it `uploading` first is what makes the attempt visible to
 * `nextBatch`, so a reconnect firing mid-push cannot pick the same SKU up a
 * second time — nor start a second push on the same stream, which would be a
 * read-modify-write race whose consequence is a deleted variation.
 */
async function pushOne(draft: QueuedDraft): Promise<void> {
  await updateDraft(draft.draft_id, { status: 'uploading' })

  try {
    // The photo lives in IndexedDB beside the draft and is encoded here, at
    // push time. One call carries the SKU and its photo together, so there is
    // no half-finished state to reconcile when the connection drops between
    // an upload and a push — which on factory Wi-Fi is exactly when it drops.
    const photo = await getPhoto(draft.draft_id)
    if (!photo) throw new Error('The photo for this SKU is missing from this device.')
    const photoBase64 = await toBase64(photo)

    // The purchase-order export needs a small copy of this photo — Sheets caps
    // an inserted image at 1,000,000 pixels and the full photo is 2.56M — and
    // the phone is the only place in the system that can resize an image for
    // free. Best effort: a SKU must never fail to list because a thumbnail
    // could not be made.
    let thumbBase64: string | undefined
    try {
      thumbBase64 = await toBase64(await toSquareJpeg(photo, { target: EXPORT_THUMB_PX, quality: 0.8 }))
    } catch {
      thumbBase64 = undefined
    }

    const result = await api.pushDraft({
      shop_id: draft.shop_id,
      // Omitted for the first SKU of a stream, which creates the listing.
      ...(draft.listing_id ? { listing_id: draft.listing_id } : {}),
      ...(draft.continues_from ? { continues_from: draft.continues_from } : {}),
      identifier: draft.identifier,
      title: draft.title,
      variant_name: draft.variant_name,
      price: draft.price,
      stock: draft.stock,
      weight_kg: draft.weight_kg,
      photo_base64: photoBase64,
      photo_mime: photo.type || 'image/jpeg',
      ...(thumbBase64 ? { thumb_base64: thumbBase64 } : {}),
      idempotency_key: draft.idempotency_key,
    })

    // A success with no listing id is not a success. Marking a draft Live
    // without one loses the only handle we have on the product — and for the
    // first SKU of a stream it would also lose the id every later SKU needs to
    // append to, silently splitting the run across separate listings.
    if (!result?.listing_id) {
      throw new Error('TikTok accepted the SKU but returned no listing ID.')
    }

    await updateDraft(
      draft.draft_id,
      afterAttempt(draft, {
        ok: true,
        tiktokProductId: result.product_id,
        listingId: result.listing_id,
      }),
    )

    // The stream now has a listing. Stamp it onto the siblings still waiting,
    // so the next one adds a variation instead of creating a second product.
    if (result.mode === 'listing_created') {
      for (const sibling of backfillListingId(await allDrafts(), draft.stream_id, result.listing_id)) {
        await updateDraft(sibling.draft_id, { listing_id: sibling.listing_id })
      }
    }
  } catch (error: unknown) {
    const api_error = error instanceof ApiError ? error : null

    // Losing the race for the listing's lease is not this SKU's fault, so it
    // goes back to the queue without consuming an attempt.
    if (api_error?.code === 'LISTING_BUSY') {
      await updateDraft(
        draft.draft_id,
        afterAttempt(draft, {
          ok: false,
          error: api_error.message,
          retryable: true,
          contended: true,
        }),
      )
      return
    }

    // The stream has outgrown one product. Singapore allows 100 variations per
    // product, so this is expected on a long run rather than a fault — but
    // creating a second listing is visible in the seller's shop, so it waits
    // for a person to accept it.
    if (api_error?.isListingFull) {
      await updateDraft(draft.draft_id, {
        status: 'failed',
        error: `${LISTING_FULL_MARKER} ${api_error.message}`,
        attempts: MAX_AUTO_ATTEMPTS,
        retryAfter: Number.MAX_SAFE_INTEGER,
      })
      return
    }

    /**
     * Ask TikTok before declaring a failure whose outcome is unknown.
     *
     * A lost reply is not a failed write. The push may have reached Apps
     * Script, uploaded the photo, edited the product and only lost the
     * response on the way home — which is precisely what happened on a real
     * SKU: the listing showed four variations while the app showed the fourth
     * as failed. Reporting that as a failure sends someone to Seller Center to
     * find out, which is the errand this whole screen exists to remove.
     *
     * Cheap, and only on the unknown-outcome path: a rejection from TikTok is
     * a decision and needs no second opinion.
     */
    if (api_error?.isOutcomeUnknown && draft.listing_id) {
      try {
        const live = await api.listingState(draft.listing_id)
        // "Recorded by the backend", not "shown by TikTok": a variation just
        // added is under review and absent from TikTok's read for minutes.
        // Asking the second question is exactly how B9 read as failed while
        // the backend had it as pushed since 12:14:17.
        if (landed(live, draft.identifier)) {
          await updateDraft(draft.draft_id, {
            status: 'pushed',
            error: null,
            settled: true,
            listing_id: draft.listing_id,
          })
          return
        }
      } catch {
        // The check itself failed. Falls through and is reported as before —
        // an unanswered question is still better recorded than guessed at.
      }
    }

    // A connection failure is retryable; a rejection from TikTok is not, and
    // retrying it would burn part of the shop's daily listing allowance.
    const retryable = api_error ? api_error.isRetryable : true
    await updateDraft(
      draft.draft_id,
      afterAttempt(draft, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable,
      }),
    )
  }
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
