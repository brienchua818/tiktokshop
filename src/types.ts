/**
 * Shared types. Field names deliberately mirror TikTok Shop's API where they
 * cross the wire to it, so there is no silent translation layer to get wrong.
 */

/** A TikTok Shop seller account. One per brand today; more is a row, not a code change. */
export interface Shop {
  shop_id: string
  /** Brand label the team actually uses — "HOUZE", not a numeric shop id. */
  brand: string
  tiktok_handle: string
  /** Legal entity the shop trades under. Needed once exports become purchase orders. */
  entity: string | null
  /** TikTok's opaque per-shop identifier, sent on nearly every API call. */
  shop_cipher: string | null
  authorised: boolean
  /** Set when TikTok reports the shop is still in its 100-listings-a-day probation. */
  daily_listing_cap: number
  listings_used_today: number
}

/** A factory livestream. One row per stream, keyed by the TikTok listing id. */
export interface Listing {
  listing_id: string
  shop_id: string
  product_name: string | null
  /** Supplier this stream was filmed at, once we start recording it. */
  supplier: string | null
  /**
   * Default package weight for SKUs in this stream, in kilograms. TikTok makes
   * weight mandatory, and products from one factory run are usually similar —
   * so it is set once per stream rather than typed 200 times.
   */
  default_weight_kg: string | null
  created_at: string
}

export type DraftStatus = 'queued' | 'uploading' | 'pushed' | 'failed'

/** A SKU being built. Lives locally first, so a dropout cannot lose it. */
export interface Draft {
  draft_id: string
  listing_id: string
  shop_id: string
  /** Sequential identifier — "A1", "A2". Also becomes the TikTok seller_sku. */
  identifier: string
  title: string
  variant_name: string | null
  price: string
  stock: number
  /** Mandatory for TikTok in Singapore, in kilograms. */
  weight_kg: string
  dimensions: Dimensions | null
  include_dims_in_title: boolean
  /** Local object URL or Cloudinary URL for display. */
  image_preview: string | null
  /** TikTok's own image reference, returned by their upload endpoint. */
  tiktok_image_uri: string | null
  status: DraftStatus
  error: string | null
  /** Guards against a timed-out push creating the product twice. */
  idempotency_key: string
  created_at: string
}

/** Centimetres — the only unit TikTok accepts for Singapore. */
export interface Dimensions {
  length: string
  width: string
  height: string
}

/** What the AI calls return. Every field optional: the model may only be sure of some. */
export interface ExtractedFields {
  title?: string
  variant_name?: string
  price?: string
  stock?: number
  weight_kg?: string
  dimensions?: Dimensions
}

export interface SignedInUser {
  email: string
  name: string
  picture: string | null
}
