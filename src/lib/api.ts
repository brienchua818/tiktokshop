import type { Shop, Listing, ExtractedFields, SignedInUser } from '../types'
import { call, getIdToken, ScriptError, setIdToken, setSessionToken, tokenNeedsRenewal } from './script-api'
import { onToken, promptSilently } from '../auth/google'

/**
 * The app's backend, from the browser's point of view.
 *
 * Two servers sit behind this, split by what each one has that the other does
 * not:
 *
 *   - **Apps Script** holds the TikTok tokens, the Sheet, the allowlist and the
 *     Drive folders. Everything about listings, shops and people goes there.
 *   - **Netlify Functions** hold the Anthropic and Gemini API keys, and nothing
 *     else. Only the two AI calls go there.
 *
 * Both authenticate with the same Google ID token, and neither ever hands the
 * browser a TikTok credential. That separation is the whole point of the
 * rebuild: the app this replaces shipped a working API token inside its public
 * JavaScript.
 */

/** Re-exported so callers catch one error type regardless of which server answered. */
export { ScriptError as ApiError } from './script-api'

/** Netlify Functions base. Same origin, so no CORS and no preflight to worry about. */
const FN = '/api'

/**
 * Call a Netlify AI function.
 *
 * The ID token goes in the body rather than a header, for symmetry with the
 * Apps Script client — there are only two of these functions, and two
 * different conventions would be two things to remember.
 */
/**
 * A Google ID token good enough to send, renewing it first if it is not.
 *
 * These two functions verify the Google token directly; they have no session
 * of their own. A Google ID token lives ONE HOUR, and nothing renewed it once
 * past the sign-in screen: `onToken` and `promptSilently` were wired only into
 * SignIn.tsx. So an hour into every stream, AI name and Voice began refusing
 * with "Sign in with Google to continue." while the app showed the person
 * signed in for another thirteen hours — because the backend session, which is
 * what the rest of the app uses, was indeed still good.
 *
 * Two features silently stopping an hour in, on the two things somebody stands
 * in a factory using. So the token is checked before it is sent, and renewed
 * through Google's own silent prompt if it is short. That prompt is best
 * effort by design: it can decline. If it does, the message says which
 * features need the sign-in refreshed rather than claiming the person is
 * signed out.
 */
async function freshIdToken(): Promise<string> {
  if (!tokenNeedsRenewal()) {
    const current = getIdToken()
    if (current) return current
  }

  // Ask Google, then wait briefly for the credential to come back through
  // onToken. Short, because this sits in front of a control someone just
  // pressed: a slow renewal must not read as a slow AI.
  await promptSilently().catch(() => {})
  const renewed = await new Promise<string | null>((resolve) => {
    const stop = onToken((t) => {
      stop()
      clearTimeout(timer)
      resolve(t)
    })
    const timer = setTimeout(() => {
      stop()
      resolve(null)
    }, 4_000)
  })
  if (renewed) {
    setIdToken(renewed)
    return renewed
  }

  const existing = getIdToken()
  if (existing) return existing
  throw new ScriptError(
    401,
    'Google needs to check your sign-in again before AI name and Voice will work. Everything else is fine. Open More and sign out, then back in.',
    'GOOGLE_TOKEN_STALE',
  )
}

async function fn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const token = await freshIdToken()

  let response: Response
  try {
    response = await fetch(`${FN}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, id_token: token }),
    })
  } catch (cause) {
    throw new ScriptError(0, `No connection: ${(cause as Error).message}`)
  }

  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    throw new ScriptError(response.status, `Unexpected response: ${text.slice(0, 200)}`)
  }

  if (!response.ok) {
    throw new ScriptError(
      response.status,
      (payload.error as string) ?? response.statusText,
      payload.code as string | number | undefined,
      payload,
    )
  }
  return payload as T
}

/** What a successful push reports back. */
export interface PushResult {
  mode: 'variation_added' | 'listing_created'
  listing_id: string
  product_id: string
  sku_id?: string | null
  variant_name?: string
  /** How many variations the listing now holds, and how many more it can take. */
  variations_now?: number
  remaining?: number
  /**
   * Present when TikTok has resent the product for review. Existing variations
   * stay live and buyable; the new one is not purchasable until it clears.
   */
  audit?: 'pending'
  /** True when this identifier was already a variation, so nothing was sent. */
  deduplicated?: boolean
  /** Where the photo was filed in Drive, under the creator's name. */
  photo_url?: string
}

/** One product on TikTok, as the stream picker shows it. */
export interface TikTokProduct {
  listing_id: string
  product_name: string
  /** Variations already on it — how full it is against Singapore's cap of 100. */
  sku_count: number
  status: string
  image: string
}

/** One variation as TikTok currently has it. */
export interface LiveVariant {
  identifier: string
  variant: string
  price: string
  status: string
  /** Listed outside this app — Seller Center or another tool. Shown, read-only. */
  external: boolean
  /** TikTok's own id, needed to remove it. Empty only for a never-seen pending row. */
  tiktok_sku_id: string
  /** TikTok's public picture of it — the thumbnail for a row this phone has no photo for. */
  image_url: string
  /** When this app recorded it (ISO), empty for a variation listed outside the app. */
  created_at: string
  /** Who pushed it, from the backend's row; empty for external. */
  created_by: string
  /** False means TikTok is not returning it — see `under_review` before alarming. */
  on_tiktok: boolean
  /**
   * TikTok issued an id for it but is not returning it yet.
   *
   * Get Product omits a variation under review, so absence is not proof of
   * loss. Only a variation with no TikTok id is genuinely unaccounted for.
   */
  under_review: boolean
  /**
   * Not returned, and no TikTok id to prove it was ever taken.
   *
   * Ambiguous by nature — pending and never-created are indistinguishable
   * here. Rows pushed before the id was recorded all land in this state.
   */
  unaccounted: boolean
  /** Was live, then deleted — in Seller Center or here. Not a fault. */
  removed: boolean
  /** Null for a variation this app did not list — we never set its stock. */
  stock_set: number | null
  /** Null when TikTok has no such variation. */
  stock_available: number | null
  /** Derived as set − available, not a figure TikTok reports. */
  sold: number | null
}

/** A listing's live review state and stock, read back from TikTok. */
export interface ListingState {
  listing_id: string
  title: string
  /**
   * TikTok's own product status. `ACTIVATE` is live and buyable; `PENDING` is
   * under review, which is what every edit triggers; `FAILED` carries reasons.
   */
  product_status: string
  audit_reasons: string[]
  variations_on_tiktok: number
  max_skus: number
  variants: LiveVariant[]
  checked_at: string
}

/**
 * A date and time range in Singapore time — the only timezone this app uses.
 *
 * Named DateWindow rather than Window because the latter is a DOM global, and
 * shadowing it in a module that other files import is the kind of thing that
 * compiles fine until someone types `window` and gets a date range.
 */
export interface DateWindow {
  from_date: string
  from_time: string
  to_date: string
  to_time: string
}

export interface SyncResult {
  orders: number
  items: number
  from: string
  to: string
}

/** One listing's takings inside the window. */
export interface ListingTotals {
  listing_id: string
  product_name: string
  order_count: number
  units: number
  /** Cancelled or unpaid — shown rather than dropped, so totals reconcile. */
  unsold_units: number
  revenue: number
  latest_order_sgt: string
}

export interface OrderSummary {
  from: string
  to: string
  listings: ListingTotals[]
  /** Distinct orders in the window — not the sum of the per-listing counts. */
  total_orders: number
  total_units: number
  total_revenue: number
}

export interface VariationTotals {
  seller_sku: string
  variation: string
  units: number
  unsold_units: number
  revenue: number
  price: string
}

export interface ListingOrders {
  listing_id: string
  from: string
  to: string
  variations: VariationTotals[]
  order_count: number
  total_units: number
  total_revenue: number
}

export interface ExportRequest extends DateWindow {
  shop_id: string
  /** Empty or omitted means every listing with orders in the window. */
  listing_ids?: string[]
  cost_divisor?: number
}

export interface ExportResult {
  url: string
  name: string
  /** Where in the shared drive it went, e.g. "Exports/2026/2026-09/2026-09-06". */
  folder?: string
  folder_url?: string
  /** Variation photos placed in the workbook, and those that fell back to a link. */
  photos_placed?: number
  photos_missing?: number
  listings: number
  units: number
  revenue: number
  cost_divisor: number | null
}

/** Identity plus what the allowlist says this person may do. */
/** Where the data lives, served by the backend so no id is hardcoded here. */
export interface DriveLinks {
  sheet: string
  log: string
  exports: string
  photos: string
  root: string
}

/** One row of the allowlist, as the Users screen shows it. */
export interface UserRow {
  email: string
  name: string
  role: string
  first_seen: string
  last_seen: string
  approved_by: string
  note: string
}

export type Me = SignedInUser & {
  role: string
  approved: boolean
  admin: boolean
  links?: DriveLinks
  /** A session this backend issued, good for a working day. Stored by `me()`. */
  session_token?: string
  session_expires_at?: string
}

export const api = {
  /** Who the backend thinks you are, and whether you may act yet. */
  me: async () => {
    const me = await call<Me>('whoami')
    // The Google token bought this; the session is what every later call
    // uses, so a phone is not sent back to sign in every hour.
    if (me.session_token) setSessionToken(me.session_token)
    return me
  },

  shops: () => call<Shop[]>('shops'),

  listings: (shopId: string) => call<Listing[]>('listings', { body: { shop_id: shopId } }),

  /**
   * The shop's live products on TikTok, so a stream can be picked from a list.
   *
   * The alternative is reading a nineteen-digit id off Seller Center and
   * retyping it on a phone, in a factory — which is a transcription error
   * waiting to happen, against credentials that can simply ask.
   */
  tiktokProducts: (shopId: string, pageToken?: string) =>
    call<{ products: TikTokProduct[]; next_page_token: string }>('tiktokProducts', {
      body: { shop_id: shopId, ...(pageToken ? { page_token: pageToken } : {}) },
    }),

  /** `productName` is passed when the picker already knows it, saving a lookup. */
  addListing: (shopId: string, listingId: string, productName?: string) =>
    call<Listing>('addListing', {
      body: {
        shop_id: shopId,
        listing_id: listingId,
        ...(productName ? { product_name: productName } : {}),
      },
    }),

  /**
   * Variations already live on TikTok, used to continue the A1/A2 sequence.
   *
   * The shop id is unused — the backend resolves the shop from the listing —
   * but kept in the signature so callers do not have to know that, and so
   * adding it back later is not a change at every call site.
   */
  listedSkus: (_shopId: string, listingId: string) =>
    call<{ seller_sku: string | null; title: string | null }[]>('skus', {
      body: { listing_id: listingId },
    }),

  /**
   * What TikTok shows for this listing right now.
   *
   * The one call that answers "did it actually land, and is it live yet"
   * without opening Seller Center.
   */
  listingState: (listingId: string) =>
    call<ListingState>('listingState', { body: { listing_id: listingId }, timeoutMs: 40_000 }),

  /** Pull a window of orders down from TikTok into the Sheet. */
  syncOrders: (body: {
    shop_id: string
    from_date: string
    from_time: string
    to_date: string
    to_time: string
  }) => call<SyncResult>('syncOrders', { body, timeoutMs: 180_000 }),

  /** Per-listing totals inside a date and time window. */
  /**
   * 60 seconds, not the 25 second default.
   *
   * The backend reads the WHOLE Order Items tab and filters it in memory, so
   * this read costs what the whole history costs, not what the chosen window
   * costs. It gets slower every stream. Brien saw the 25 second deadline fire
   * on 7 Sep, and that deadline was telling the truth: the request really had
   * not answered. Giving up on it and starting again only makes the backend do
   * the same expensive work twice.
   *
   * A wider deadline is the honest short-term answer, not the real one. The
   * real one is to stop reading the entire tab per request.
   */
  orderSummary: (shopId: string, w: DateWindow) =>
    call<OrderSummary>('orderSummary', { body: { shop_id: shopId, ...w }, timeoutMs: 60_000 }),

  /** The variations behind one listing's total, in the same window. */
  /** Same whole-tab read as the summary, so the same deadline. */
  listingOrders: (listingId: string, w: DateWindow) =>
    call<ListingOrders>('listingOrders', { body: { listing_id: listingId, ...w }, timeoutMs: 60_000 }),

  /**
   * Build the purchase order for a window and file it in Drive.
   *
   * `costDivisor` derives the factory price from the selling price. Omit it for
   * a sheet with selling prices only — the figure is printed in the workbook
   * either way, since a purchase order nobody can reproduce is not one anyone
   * should sign.
   */
  exportOrders: (body: ExportRequest) =>
    // Spread rather than passed straight through: an interface is not
    // assignable to Record<string, unknown>, because TypeScript cannot rule out
    // a subtype adding an incompatible field. Spreading produces the plain
    // object the call actually sends.
    call<ExportResult>('exportOrders', { body: { ...body }, timeoutMs: 240_000 }),

  /**
   * Remove one variation from TikTok. Confirmed by the person first — this is
   * the one write in the app that takes something away from buyers.
   */
  removeVariation: (listingId: string, tiktokSkuId: string) =>
    call<{ removed: string; listing_id: string; variations_now: number; audit: 'pending' }>(
      'removeVariation',
      { body: { listing_id: listingId, tiktok_sku_id: tiktokSkuId }, timeoutMs: 90_000 },
    ),

  /** The allowlist. Admins only; the backend refuses everyone else with 403. */
  users: () => call<UserRow[]>('users'),

  /**
   * Approve, demote or block someone.
   *
   * POST-only on the backend on purpose, so there is exactly one way to change
   * a role and it cannot happen by following a link.
   */
  setRole: (email: string, role: string) =>
    call<{ email: string; role: string }>('setRole', {
      body: { email, role },
      timeoutMs: 45_000,
    }),

  /** Remaining product uploads for today, against the shop's daily cap. */
  listingAllowance: (shopId: string) =>
    call<{ used: number | null; cap: number; remaining: number | null }>('allowance', {
      body: { shop_id: shopId },
    }),

  /**
   * Add one SKU to a livestream.
   *
   * The photo travels with it as base64 rather than being uploaded separately.
   * The backend files it in Drive under the creator's name AND uploads it to
   * TikTok, and doing both in one call means there is no half-finished state to
   * reconcile when the connection drops between two of them.
   */
  pushDraft: (body: {
    shop_id: string
    /** Omit to start the stream's listing with this SKU as its first variation. */
    listing_id?: string
    /** The listing this one continues, when the previous filled up. */
    continues_from?: string
    identifier: string
    title: string
    variant_name: string | null
    price: string
    stock: number
    weight_kg: string
    photo_base64?: string
    photo_mime?: string
    /** A 400 px JPEG of the same photo, for the purchase-order export. */
    thumb_base64?: string
    tiktok_image_uri?: string
    idempotency_key: string
  }) => call<PushResult>('pushSku', { body, timeoutMs: 120_000 }),

  /**
   * Photo to variant name — the name of one variation within a listing.
   *
   * `productName` is the listing's own title, passed so the answer
   * distinguishes this piece rather than repeating what the listing says.
   */
  variantFromPhoto: (imageBase64: string, productName?: string, hint?: string) =>
    fn<{ variant_name: string; material: string | null; problems: string[] }>('ai-variant', {
      image_base64: imageBase64,
      image_mime: 'image/jpeg',
      product_name: productName,
      hint,
    }),

  /** Recording to fields. Accepts English, Mandarin or both; returns English. */
  fieldsFromVoice: (audioBase64: string, audioMime: string) =>
    fn<
      ExtractedFields & {
        transcript_english: string
        unintelligible: boolean
        dropped: string[] | null
      }
    >('ai-voice', { audio_base64: audioBase64, audio_mime: audioMime }),
}
