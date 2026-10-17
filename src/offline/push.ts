import { api, ApiError } from '../lib/api'
import {
  credentialEpoch,
  credentialsToSend,
  getIdToken,
  getSessionToken,
  hasCredential,
  setIdToken,
  setSessionToken,
} from '../lib/script-api'
import { toBase64 } from '../lib/bytes'
import { toSquareJpeg } from '../capture/camera'
import { landed } from '../live-listing/reconcile'
import {
  afterAttempt,
  allDrafts,
  backfillListingId,
  getDraft,
  getPhoto,
  MAX_AUTO_ATTEMPTS,
  updateDraft,
  type QueuedDraft,
} from './queue'

/**
 * Pushing one SKU, moved out of the listing screen unchanged.
 *
 * It lived inside DraftQueue.tsx, so only that screen could push — and only
 * while it was on screen and its React effect had not been torn down. The
 * background runner (runner.ts) now calls it, wherever the person is in the
 * app. The rules inside it are exactly what they were.
 */

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
 * How long a step on the phone itself may take before the push gives up on it.
 *
 * The network call has a deadline; reading the photo from IndexedDB, encoding
 * it and making the thumbnail did not. If one of those never settles — a
 * WebKit IndexedDB or image-decode stall after the app comes back from the
 * background — the push never finished and the queue waited on it for good.
 * Thirty seconds is far beyond a normal photo (well under a second) and short
 * enough not to cost a stream. Nothing has been sent at this point, so a
 * retry is safe.
 */
export const PREP_DEADLINE_MS = 30_000

/** The deadline in force. A field rather than the constant so a test can shorten it. */
export const prepTiming = { deadlineMs: PREP_DEADLINE_MS }

/**
 * How long a push that reached nobody waits before it goes again.
 *
 * A connection that failed outright, or a device with nobody signed in, is no
 * verdict on the SKU, so it costs none of the five automatic attempts —
 * otherwise a few minutes of factory Wi-Fi with no uplink parks every SKU in
 * the queue, each needing its own Retry tap mid-broadcast. Ten seconds keeps
 * the phone from re-encoding every photo on every heartbeat while it waits.
 */
export const UNREACHED_RETRY_MS = 10_000

/**
 * How long a push the backend refused for a deployment or sign-in fault that
 * is not a dead credential waits — a misconfigured backend or Google being
 * unreachable. Every push would fail the same way, so not every ten seconds.
 */
export const AUTH_FAULT_RETRY_MS = 60_000
/** The refusals that mean that. Anything else about sign-in is retried as soon as an outage is. */
const AUTH_FAULTS = new Set(['BACKEND_NOT_CONFIGURED', 'CLIENT_ID_MISMATCH', 'GOOGLE_UNREACHABLE'])

export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s. It will try again.`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * Record a failed attempt, unless another attempt has settled the SKU since.
 *
 * A push the sender's watchdog gave up on can still be running, and be sent
 * again beside it. If the second lands first, the first one's failure must
 * not turn a SKU that is live back into a failed one.
 */
async function recordFailure(draft: QueuedDraft, patch: Partial<QueuedDraft>): Promise<void> {
  const now = await getDraft(draft.draft_id)
  if (!now || now.settled) return
  await updateDraft(draft.draft_id, patch)
}

/** Still working on it: keeps `revivable` from taking a live push for a dead one. */
function stillUploading(draft: QueuedDraft): Promise<unknown> {
  return updateDraft(draft.draft_id, { uploading_at: Date.now() })
}

/**
 * Push one draft, recording the outcome either way.
 *
 * Marking it `uploading` first is what makes the attempt visible to
 * `nextBatch`, so a reconnect firing mid-push cannot pick the same SKU up a
 * second time — nor start a second push on the same stream, which would be a
 * read-modify-write race whose consequence is a deleted variation.
 */
export async function pushOne(draft: QueuedDraft): Promise<void> {
  // Stamped as the push starts, so `revivable` can tell this row from one whose
  // app died mid-flight without having to know when it is being asked.
  await updateDraft(draft.draft_id, { status: 'uploading', uploading_at: Date.now() })
  // Which credential this push carries, so a refusal of it cannot sign out one
  // the person has signed in with since.
  const carried = credentialEpoch()
  // And the credentials themselves, as sent: a renewal or a sign-in replaces
  // them without moving the epoch.
  let sent: { session: string | null; token: string | null } | null = null

  try {
    // Nobody signed in: say so now, before the photo is read and encoded for
    // a request that cannot be sent.
    if (!hasCredential()) throw new ApiError(401, 'Sign in with Google to continue.', 'NO_CREDENTIAL_ON_DEVICE')

    // The photo lives in IndexedDB beside the draft and is encoded here, at
    // push time. One call carries the SKU and its photo together, so there is
    // no half-finished state to reconcile when the connection drops between
    // an upload and a push — which on factory Wi-Fi is exactly when it drops.
    const photo = await withDeadline(getPhoto(draft.draft_id), prepTiming.deadlineMs, 'Reading the photo from this phone')
    if (!photo) throw new Error('The photo for this SKU is missing from this device.')
    const photoBase64 = await withDeadline(toBase64(photo), prepTiming.deadlineMs, 'Preparing the photo')

    // The purchase-order export needs a small copy of this photo — Sheets caps
    // an inserted image at 1,000,000 pixels and the full photo is 2.56M — and
    // the phone is the only place in the system that can resize an image for
    // free. Best effort: a SKU must never fail to list because a thumbnail
    // could not be made.
    let thumbBase64: string | undefined
    try {
      // Bounded as well as caught: a catch handles a failure, not a hang, and
      // a thumbnail is never worth holding the queue for.
      thumbBase64 = await withDeadline(
        toSquareJpeg(photo, { target: EXPORT_THUMB_PX, quality: 0.8 }).then(toBase64),
        prepTiming.deadlineMs,
        'Making the export thumbnail',
      )
    } catch {
      thumbBase64 = undefined
    }

    // Stamped again at each long step — here, before the 120 s request, and
    // before the check of what landed — so no live step outlasts the 150 s
    // after which `revivable` would call the push dead.
    await stillUploading(draft)
    sent = credentialsToSend()
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
      await recordFailure(
        draft,
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
      await recordFailure(draft, {
        status: 'failed',
        error: `${LISTING_FULL_MARKER} ${api_error.message}`,
        attempts: MAX_AUTO_ATTEMPTS,
        retryAfter: Number.MAX_SAFE_INTEGER,
      })
      return
    }

    // Signed out, or a session the backend no longer takes. Nothing reached
    // TikTok and it is not this SKU's doing: it was parked as a rejection, so
    // signing out mid-stream left every waiting SKU needing its own Retry. It
    // waits, says why, and goes once someone is signed in.
    if (api_error?.isAuthError) {
      const local = api_error.code === 'NO_CREDENTIAL_ON_DEVICE'
      // A credential the backend calls dead is dropped, as at app start. The
      // next try then stops here on the phone instead of re-sending the photo
      // every ten seconds, and the app shell sends the person to sign in.
      // Only what this push sent and the phone still holds: one renewed or
      // signed in since is good, whatever the old one's refusal says.
      if (api_error.isCredentialDead && !local && sent && credentialEpoch() === carried) {
        if (sent.token && getIdToken() === sent.token) setIdToken(null)
        if (sent.session && getSessionToken() === sent.session) setSessionToken(null)
      }
      await recordFailure(draft, {
        status: 'failed',
        error: api_error.message,
        retryAfter: Date.now() + (AUTH_FAULTS.has(String(api_error.code)) ? AUTH_FAULT_RETRY_MS : UNREACHED_RETRY_MS),
        settled: false,
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
        await stillUploading(draft)
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
    const next = afterAttempt(draft, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable,
    })
    // The connection failed outright ("No connection", no code — a timeout is
    // coded and still counts). Any copy that did reach the backend is caught
    // by the idempotency key, so going again costs nothing.
    const unreached = api_error?.status === 0 && api_error.code === undefined
    await recordFailure(
      draft,
      unreached ? { ...next, attempts: draft.attempts, retryAfter: Date.now() + UNREACHED_RETRY_MS } : next,
    )
  }
}
