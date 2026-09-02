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
  ) {
    super(message)
    this.name = 'ApiError'
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
    const detail =
      (payload as { error?: string; detail?: string }).error ??
      (payload as { detail?: string }).detail ??
      response.statusText
    throw new ApiError(response.status, detail, response.status === 401)
  }

  return payload as T
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
    return request<{ tiktok_image_uri: string; cloudinary_url: string; ai_image_url: string }>(
      'upload-photo',
      { method: 'POST', body: form },
    )
  },

  /** Photo to English title, at least 25 characters. */
  titleFromPhoto: (imageUrl: string, hint?: string) =>
    request<ExtractedFields & { material?: string }>('ai-title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, hint }),
    }),

  /** Recording to fields. Accepts English, Mandarin or both; returns English. */
  fieldsFromVoice: async (audio: Blob) => {
    const form = new FormData()
    form.append('audio', audio, 'note.webm')
    return request<ExtractedFields & { transcript_english: string; unintelligible: boolean }>(
      'ai-voice',
      { method: 'POST', body: form },
    )
  },

  /**
   * Push one draft to TikTok. `idempotency_key` makes a retry after a timeout
   * safe — TikTok returns the original product rather than creating a second.
   */
  pushDraft: (body: {
    shop_id: string
    listing_id: string
    identifier: string
    title: string
    variant_name: string | null
    price: string
    stock: number
    weight_kg: string
    dimensions: { length: string; width: string; height: string } | null
    tiktok_image_uri: string
    idempotency_key: string
  }) =>
    request<{ product_id: string }>('push-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** Remaining product uploads for today, against the shop's daily cap. */
  listingAllowance: (shopId: string) =>
    request<{ used: number; cap: number; remaining: number }>(
      `allowance?shop_id=${encodeURIComponent(shopId)}`,
    ),
}
