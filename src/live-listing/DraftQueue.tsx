import { useEffect, useState } from 'react'
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
import { MAX_SKUS_PER_PRODUCT } from '../lib/tiktok-rules'

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
  onDelete,
}: {
  drafts: QueuedDraft[]
  /** The listing these SKUs belong to, so its live state can be read back. */
  listingId: string | null
  onChanged: () => Promise<void>
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

  async function refresh() {
    if (!listingId) return
    setChecking(true)
    setCheckError('')
    try {
      setLive(await api.listingState(listingId))
    } catch (e: unknown) {
      setCheckError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  // Checked once when there is something to check, and after that on request.
  // Not polled: it is a TikTok call per refresh, review takes minutes rather
  // than seconds, and a timer firing through a three-hour broadcast would
  // spend the shop's rate limit on nothing.
  const pushedCount = drafts.filter((d) => d.status === 'pushed').length
  useEffect(() => {
    if (!listingId || pushedCount === 0 || live || checking) return
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId, pushedCount])

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
  const pushed = drafts.filter((d) => d.status === 'pushed')

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

  if (drafts.length === 0) {
    // A card rather than bare text, because on an iPad this is a whole column.
    // Floating grey words in an empty half-screen read as something failing to
    // load; a panel reads as a place where SKUs will appear.
    return (
      <div className="bg-raised border border-white/8 border-dashed rounded-xl px-4 py-8 text-center">
        <p className="text-sm text-gray-500">No SKUs yet</p>
        <p className="text-xs text-gray-600 mt-1">
          They appear here as you add them, and upload themselves.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-raised border border-white/8 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {/* "Sent", not "live". A push landing means TikTok accepted the SKU;
            whether buyers can see it is a separate question that only a
            refresh can answer. */}
        <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
          SKUs ({pushed.length}/{drafts.length} sent)
        </p>
        {working && <span className="text-xs text-blue-400">Uploading…</span>}
        {!online && <span className="text-xs text-amber-400">Waiting for a connection</span>}
        <span className="flex-1" />
        {listingId && pushed.length > 0 && (
          <button
            onClick={() => void refresh()}
            disabled={checking}
            className="text-xs px-2.5 min-h-8 rounded-lg border border-white/10 text-gray-300 hover:border-accent/50 disabled:opacity-50"
          >
            {checking ? 'Checking…' : '↻ Check TikTok'}
          </button>
        )}
      </div>

      {/* The listing's own review state. TikTok resends the whole product for
          review on every edit, so this is normal after each variation rather
          than a sign of trouble — and saying so is the difference between
          waiting calmly and opening Seller Center to check. */}
      {live && <ReviewBanner live={live} />}

      {checkError && (
        <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {checkError}
        </p>
      )}

      {/* A full listing is not a fault — Singapore allows 100 variations per
          product, so a long factory run simply outgrows one. It gets its own
          banner and its own action, well away from the failure banner, so
          nobody reads "could not be listed" and assumes something broke. */}
      {full.length > 0 && (
        <div className="text-xs bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5 space-y-2">
          <p className="text-amber-200">
            This listing is full at {MAX_SKUS_PER_PRODUCT} variations — TikTok's limit for
            Singapore. {full.length} SKU{full.length === 1 ? '' : 's'} waiting.
          </p>
          <button
            onClick={() => void continueInNewListing()}
            className="min-h-11 w-full rounded-lg bg-amber-400 px-3 font-medium text-black active:scale-[0.99] transition-transform"
          >
            Start continuation listing
          </button>
          <p className="text-amber-200/60">
            Creates a second listing for the same factory run. Your SKU numbering carries on.
          </p>
        </div>
      )}

      {stuck.length > 0 && (
        <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {stuck.length} SKU{stuck.length === 1 ? '' : 's'} could not be listed and stopped
          retrying. Fix the problem shown, then retry.
        </p>
      )}

      <ul className="space-y-1 max-h-80 overflow-y-auto">
        {drafts.map((draft) => (
          <li
            key={draft.draft_id}
            className="flex items-start gap-2 py-1.5 border-b border-white/5 last:border-0"
          >
            {draft.image_preview ? (
              <img
                src={draft.image_preview}
                alt=""
                className="w-9 h-9 rounded object-cover shrink-0"
              />
            ) : (
              <div className="w-9 h-9 rounded bg-white/5 shrink-0" />
            )}

            <div className="min-w-0 flex-1">
              <p className="text-xs font-mono text-identifier">{draft.identifier}</p>
              <p className="text-xs text-gray-400 truncate">{draft.title}</p>

              {/* Stock as TikTok has it, once a refresh has been done. Sold is
                  derived — set minus what remains — because the product API
                  reports no sold count; that lives in orders. Labelled so
                  nobody takes it for TikTok's own figure. */}
              {liveFor(live, draft.identifier) && <StockLine v={liveFor(live, draft.identifier)!} />}

              {/* TikTok's own rejection text, verbatim. A generic "failed" is
                  what makes the current app hard to recover from. */}
              {draft.error && (
                <p className="text-xs text-red-400 mt-0.5">
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
                  className="mt-1 text-xs px-2.5 min-h-8 rounded-lg bg-accent/90 hover:bg-accent text-white"
                >
                  ↻ Retry {draft.identifier}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-gray-500">${draft.price}</span>
              <StatusBadge
                draft={draft}
                live={liveFor(live, draft.identifier)}
                productStatus={live?.product_status ?? null}
              />
              {draft.status !== 'pushed' && (
                <button
                  onClick={() => void onDelete(draft.draft_id)}
                  className="text-gray-600 hover:text-red-400 text-xs"
                  aria-label={`Delete ${draft.identifier}`}
                >
                  ✕
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The live record for one identifier, if a refresh has been done. */
function liveFor(live: ListingState | null, identifier: string): LiveVariant | null {
  return live?.variants.find((v) => v.identifier === identifier) ?? null
}

/**
 * TikTok's product statuses, in the words of someone standing in a factory.
 *
 * Only the ones that can be seen from here are named. An unrecognised status
 * is shown verbatim rather than mapped to "unknown", because a status this
 * code has not met before is exactly the one worth reading.
 */
const PRODUCT_STATUS: Record<string, { label: string; tone: string; note: string }> = {
  ACTIVATE: {
    label: 'Live',
    tone: 'emerald',
    note: 'Approved and buyable.',
  },
  PENDING: {
    label: 'Under review',
    tone: 'amber',
    note: 'TikTok reviews the whole product after every change, so this is normal each time a variation is added. Variations already approved stay buyable throughout.',
  },
  FAILED: {
    label: 'Rejected',
    tone: 'red',
    note: 'TikTok refused this listing. The reasons are below.',
  },
  DRAFT: { label: 'Draft', tone: 'gray', note: 'Not submitted yet.' },
  SELLER_DEACTIVATED: {
    label: 'Deactivated by you',
    tone: 'gray',
    note: 'Turned off in Seller Center, not by this app.',
  },
  PLATFORM_DEACTIVATED: {
    label: 'Deactivated by TikTok',
    tone: 'red',
    note: 'TikTok took this listing down.',
  },
  FREEZE: { label: 'Frozen', tone: 'red', note: 'TikTok has frozen this listing.' },
  DELETED: { label: 'Deleted', tone: 'red', note: 'This listing no longer exists on TikTok.' },
}

const TONES: Record<string, string> = {
  emerald: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  amber: 'text-amber-200 bg-amber-500/10 border-amber-500/30',
  red: 'text-red-300 bg-red-500/10 border-red-500/30',
  gray: 'text-gray-300 bg-white/5 border-white/10',
}

function ReviewBanner({ live }: { live: ListingState }) {
  const known = PRODUCT_STATUS[live.product_status]
  const tone = TONES[known?.tone ?? 'gray']
  const checked = new Date(live.checked_at).toLocaleTimeString('en-SG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Singapore',
  })

  return (
    <div className={`text-xs border rounded-lg px-3 py-2.5 space-y-1 ${tone}`}>
      <p className="font-medium">
        {known?.label ?? (live.product_status || "Status unavailable")}
        <span className="font-normal opacity-60">
          {' '}
          · {live.variations_on_tiktok} of {live.max_skus} variations · checked {checked}
        </span>
      </p>
      {known?.note && <p className="opacity-70">{known.note}</p>}
      {live.audit_reasons.length > 0 && (
        <ul className="list-disc pl-4 space-y-0.5 opacity-90">
          {live.audit_reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StockLine({ v }: { v: LiveVariant }) {
  if (!v.on_tiktok) {
    // The device thinks this was sent and TikTok has never heard of it. Worth
    // saying loudly: it is the one failure the queue cannot detect by itself.
    return <p className="text-xs text-red-400 mt-0.5">Not on TikTok — retry this SKU.</p>
  }
  return (
    <p className="text-xs text-gray-500 mt-0.5">
      <span className="text-gray-300">{v.stock_available}</span> left of {v.stock_set}
      {v.sold !== null && v.sold > 0 && (
        <span className="text-emerald-400/80"> · {v.sold} sold</span>
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
    if (live && !live.on_tiktok) return <span className="text-xs text-red-400">Missing</span>
    // Buyable requires two things: TikTok has the variation, and the product
    // it belongs to has cleared review. A variation can exist while the
    // product is still PENDING, and it is not purchasable then.
    if (live?.on_tiktok && productStatus === 'ACTIVATE') {
      return <span className="text-xs text-emerald-400">Live</span>
    }
    return (
      <span className="text-xs text-gray-400" title="Accepted by TikTok; see the listing status above">
        Sent
      </span>
    )
  }
  if (draft.status === 'uploading') return <span className="text-xs text-blue-400">…</span>
  if (draft.status === 'failed') {
    return (
      <span className="text-xs text-red-400" title={`${draft.attempts} attempts`}>
        Failed
      </span>
    )
  }
  return <span className="text-xs text-gray-500">Queued</span>
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
