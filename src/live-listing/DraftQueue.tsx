import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { afterAttempt, backfillListingId, allDrafts, MAX_AUTO_ATTEMPTS, nextBatch, getPhoto, needsAttention, updateDraft } from '../offline/queue'
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
  onChanged,
  onDelete,
}: {
  drafts: QueuedDraft[]
  onChanged: () => Promise<void>
  onDelete: (draftId: string) => void | Promise<void>
}) {
  const online = useOnlineStatus()
  const [working, setWorking] = useState(false)

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
    return <p className="text-xs text-gray-600 text-center py-4">No SKUs yet.</p>
  }

  return (
    <div className="bg-raised border border-white/8 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
          SKUs ({pushed.length}/{drafts.length} live)
        </p>
        {working && <span className="text-xs text-blue-400">Uploading…</span>}
        {!online && <span className="text-xs text-amber-400">Waiting for a connection</span>}
      </div>

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
              {/* TikTok's own rejection text, verbatim. A generic "failed" is
                  what makes the current app hard to recover from. */}
              {draft.error && (
                <p className="text-xs text-red-400 mt-0.5">
                  {/* The marker is for the code, not the operator. */}
                  {draft.error.replace(LISTING_FULL_MARKER, '').trim()}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-gray-500">${draft.price}</span>
              <StatusBadge draft={draft} />
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

function StatusBadge({ draft }: { draft: QueuedDraft }) {
  if (draft.status === 'pushed') return <span className="text-xs text-emerald-400">Live</span>
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
    let imageUri = draft.tiktok_image_uri
    let attributeImageUri = draft.tiktok_attribute_image_uri

    // The photo may not have uploaded yet — it was taken with no signal.
    if (!imageUri || !attributeImageUri) {
      const photo = await getPhoto(draft.draft_id)
      if (!photo) throw new Error('The photo for this SKU is missing from this device.')
      const uploaded = await api.uploadPhoto(draft.shop_id, photo)
      imageUri = uploaded.tiktok_image_uri
      attributeImageUri = uploaded.tiktok_attribute_image_uri
      await updateDraft(draft.draft_id, {
        tiktok_image_uri: imageUri,
        tiktok_attribute_image_uri: attributeImageUri,
      })
    }

    const result = await api.pushDraft({
      shop_id: draft.shop_id,
      // Omitted for the first SKU of a stream, which creates the listing.
      ...(draft.listing_id ? { listing_id: draft.listing_id } : {}),
      identifier: draft.identifier,
      title: draft.title,
      variant_name: draft.variant_name,
      price: draft.price,
      stock: draft.stock,
      weight_kg: draft.weight_kg,
      dimensions: draft.dimensions,
      tiktok_image_uri: imageUri,
      tiktok_attribute_image_uri: attributeImageUri,
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
    status: 'queued',
    error: null,
    attempts: 0,
    retryAfter: 0,
  })
}
