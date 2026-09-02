import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { afterAttempt, dueForPush, getPhoto, needsAttention, updateDraft } from '../offline/queue'
import type { QueuedDraft } from '../offline/queue'
import { useOnlineStatus } from '../hooks/useOnlineStatus'

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
    const due = dueForPush(drafts)
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

  const stuck = needsAttention(drafts)
  const pushed = drafts.filter((d) => d.status === 'pushed')

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
              {draft.error && <p className="text-xs text-red-400 mt-0.5">{draft.error}</p>}
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
 * `dueForPush`, so a reconnect firing mid-push cannot pick the same SKU up a
 * second time.
 */
async function pushOne(draft: QueuedDraft): Promise<void> {
  await updateDraft(draft.draft_id, { status: 'uploading' })

  try {
    let imageUri = draft.tiktok_image_uri

    // The photo may not have uploaded yet — it was taken with no signal.
    if (!imageUri) {
      const photo = await getPhoto(draft.draft_id)
      if (!photo) throw new Error('The photo for this SKU is missing from this device.')
      const uploaded = await api.uploadPhoto(draft.shop_id, photo)
      imageUri = uploaded.tiktok_image_uri
      await updateDraft(draft.draft_id, { tiktok_image_uri: imageUri })
    }

    const result = await api.pushDraft({
      shop_id: draft.shop_id,
      listing_id: draft.listing_id,
      identifier: draft.identifier,
      title: draft.title,
      variant_name: draft.variant_name,
      price: draft.price,
      stock: draft.stock,
      weight_kg: draft.weight_kg,
      dimensions: draft.dimensions,
      tiktok_image_uri: imageUri,
      idempotency_key: draft.idempotency_key,
    })

    // A success with no product id is not a success. Marking a draft Live
    // without one loses the only handle we have on the product, and the SKU
    // would look done while being untraceable.
    if (!result?.product_id) {
      throw new Error('TikTok accepted the product but returned no product ID.')
    }

    await updateDraft(
      draft.draft_id,
      afterAttempt(draft, { ok: true, tiktokProductId: result.product_id }),
    )
  } catch (error: unknown) {
    // A connection failure is retryable; a rejection from TikTok is not, and
    // retrying it would burn part of the shop's daily listing allowance.
    const retryable = error instanceof ApiError ? error.status === 0 || error.status >= 500 : true
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
