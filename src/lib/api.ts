import type { Shop, Listing, ExtractedFields, SignedInUser } from '../types'
import { call, getIdToken, ScriptError } from './script-api'

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
async function fn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const token = getIdToken()
  if (!token) throw new ScriptError(401, 'Sign in with Google to continue.')

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
  /** False means the push never landed, whatever this device recorded. */
  on_tiktok: boolean
  stock_set: number
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
  listings: number
  units: number
  revenue: number
  cost_divisor: number | null
}

/** Identity plus what the allowlist says this person may do. */
export type Me = SignedInUser & { role: string; approved: boolean; admin: boolean }

export const api = {
  /** Who the backend thinks you are, and whether you may act yet. */
  me: () => call<Me>('whoami'),

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
    call<ListingState>('listingState', { body: { listing_id: listingId } }),

  /** Pull a window of orders down from TikTok into the Sheet. */
  syncOrders: (body: {
    shop_id: string
    from_date: string
    from_time: string
    to_date: string
    to_time: string
  }) => call<SyncResult>('syncOrders', { body }),

  /** Per-listing totals inside a date and time window. */
  orderSummary: (shopId: string, w: DateWindow) =>
    call<OrderSummary>('orderSummary', { body: { shop_id: shopId, ...w } }),

  /** The variations behind one listing's total, in the same window. */
  listingOrders: (listingId: string, w: DateWindow) =>
    call<ListingOrders>('listingOrders', { body: { listing_id: listingId, ...w } }),

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
    call<ExportResult>('exportOrders', { body: { ...body } }),

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
    tiktok_image_uri?: string
    idempotency_key: string
  }) => call<PushResult>('pushSku', { body }),

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
