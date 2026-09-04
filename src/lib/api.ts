import type { Shop, Listing, ExtractedFields, SignedInUser } from '../types'

/**
 * Client for our own backend.
 *
 * Every call goes to /api/*, which is a Netlify Function. The browser holds no
 * TikTok token and no API secret — that separation is the whole point of the
 * rebuild, since the app it replaces shipped a working API token inside its
 * public JavaScript.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** True when the session has expired and the user must sign in again. */
    readonly isAuthError = false,
    /**
     * The machine-readable code from the response, where there is one.
     *
     * Some failures are not really failures and the UI has to tell them apart
     * from the message alone otherwise — `LISTING_FULL` means offer to start a
     * continuation listing, `LISTING_BUSY` means retry shortly, a TikTok error
     * code means show TikTok's own words and stop.
     */
    readonly code?: string | number,
    /** The whole parsed body, for codes that carry detail with them. */
    readonly payload?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** True when retrying unchanged is the right response. */
  get isRetryable(): boolean {
    return this.status === 0 || this.code === 'LISTING_BUSY' || this.status >= 500
  }

  /** True when the stream has outgrown this listing and needs a continuation. */
  get isListingFull(): boolean {
    return this.code === 'LISTING_FULL'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/${path}`, {
      // The session is an HTTP-only cookie, so it must be sent explicitly.
      credentials: 'same-origin',
      ...init,
    })
  } catch (cause) {
    // Distinguish "no signal" from "server said no": the first is what the
    // offline queue exists to absorb, and the UI must not show it as an error.
    throw new ApiError(0, `No connection: ${(cause as Error).message}`)
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(response.status, `Unexpected response from the server: ${text.slice(0, 200)}`)
  }

  if (!response.ok) {
    const body = (payload ?? {}) as Record<string, unknown>
    const detail =
      (body.error as string | undefined) ??
      (body.detail as string | undefined) ??
      response.statusText
    throw new ApiError(
      response.status,
      detail,
      response.status === 401,
      body.code as string | number | undefined,
      body,
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
}

export const api = {
  me: () => request<SignedInUser>('me'),

  signOut: () => request<{ ok: true }>('sign-out', { method: 'POST' }),

  shops: () => request<Shop[]>('shops'),

  listings: (shopId: string) =>
    request<Listing[]>(`listings?shop_id=${encodeURIComponent(shopId)}`),

  addListing: (shopId: string, listingId: string) =>
    request<Listing>('listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shop_id: shopId, listing_id: listingId }),
    }),

  /** Variations already live on TikTok, used to continue the A1/A2 sequence. */
  listedSkus: (shopId: string, listingId: string) =>
    request<{ seller_sku: string | null; title: string | null }[]>(
      `listed-skus?shop_id=${encodeURIComponent(shopId)}&listing_id=${encodeURIComponent(listingId)}`,
    ),

  /**
   * Upload a photo. The function forwards it to TikTok for a `uri` and
   * archives a copy to Cloudinary.
   */
  uploadPhoto: async (shopId: string, photo: Blob) => {
    const form = new FormData()
    form.append('shop_id', shopId)
    form.append('photo', photo, 'product.jpg')
    return request<{
      tiktok_image_uri: string
      /** The same photo under use_case=ATTRIBUTE_IMAGE, for the variation gallery. */
      tiktok_attribute_image_uri: string
      cloudinary_url: string | null
      ai_image_url: string
    }>('upload-photo', { method: 'POST', body: form })
  },

  /**
   * Photo to variant name — the name of one variation within a listing.
   *
   * This is what the SKU form uses. `product_name` is the listing's own title,
   * passed so the answer distinguishes this piece rather than repeating what
   * the listing already says.
   */
  variantFromPhoto: (imageUrl: string, productName?: string, hint?: string) =>
    request<{ variant_name: string; material: string | null; problems: string[] }>('ai-variant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, product_name: productName, hint }),
    }),

  /**
   * Photo to English product title, at least 25 characters.
   *
   * For naming a listing, not a SKU — a stream needs one title and many
   * variant names.
   */
  titleFromPhoto: (imageUrl: string, hint?: string) =>
    request<ExtractedFields & { material?: string; problems: string[] }>('ai-title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, hint }),
    }),

  /** Recording to fields. Accepts English, Mandarin or both; returns English. */
  fieldsFromVoice: async (audio: Blob) => {
    const form = new FormData()
    form.append('audio', audio, 'note.webm')
    return request<
      ExtractedFields & {
        transcript_english: string
        unintelligible: boolean
        /**
         * Text fields withheld because they came back in Chinese even after a
         * retry. Price and quantity are unaffected — digits have no language.
         */
        dropped: string[] | null
      }
    >('ai-voice', { method: 'POST', body: form })
  },

  /**
   * Add one SKU to a livestream.
   *
   * Adds a variation to `listing_id` when one is given, and creates the
   * stream's listing when it is not — the returned `listing_id` is then what
   * every later SKU appends to.
   *
   * A retry is safe either way: a create is guarded by TikTok's own
   * `idempotency_key`, and an append is guarded by the product itself, which
   * already knows whether this identifier is one of its variations.
   */
  pushDraft: (body: {
    shop_id: string
    /** Omit to start the stream's listing with this SKU as its first variation. */
    listing_id?: string
    /**
     * The listing this one continues, when the previous filled up. The server
     * reads that product's title and derives this listing's from it.
     */
    continues_from?: string
    identifier: string
    title: string
    variant_name: string | null
    price: string
    stock: number
    weight_kg: string
    dimensions: { length: string; width: string; height: string } | null
    tiktok_image_uri: string
    tiktok_attribute_image_uri?: string
    idempotency_key: string
    /** Accept a continuation listing after the current one filled up. */
    start_new_listing?: boolean
  }) =>
    request<PushResult>('push-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** Remaining product uploads for today, against the shop's daily cap. */
  listingAllowance: (shopId: string) =>
    request<{ used: number | null; cap: number; remaining: number | null; tracked: boolean }>(
      `allowance?shop_id=${encodeURIComponent(shopId)}`,
    ),
}
