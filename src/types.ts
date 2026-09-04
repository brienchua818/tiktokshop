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

/**
 * A factory livestream.
 *
 * `listing_id` is the TikTok **product id**: a stream is one product, and every
 * SKU called out on air is a variation of it. That is why the field is not
 * called product_id — it is the identifier the operator pastes in, and the app
 * it replaces called it a listing id too.
 */
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
  /**
   * The TikTok product this SKU becomes a variation of.
   *
   * Null until the stream's listing exists. The first SKU of a new stream
   * creates the product; the rest are back-filled with its id and appended to
   * it. Two drafts pushing while this is still null would create two products,
   * which is why the queue only ever pushes one draft per stream at a time.
   */
  listing_id: string | null
  /**
   * Local grouping key for the stream, assigned on the device.
   *
   * Exists because `listing_id` cannot do the job before the listing does —
   * something has to say "these drafts belong to the same factory run" while
   * TikTok still knows nothing about it.
   */
  stream_id: string
  /**
   * The listing this one continues, when the previous filled up.
   *
   * Set only on the drafts that move across after a listing hits TikTok's
   * 100-variation ceiling. The server reads that product's own title and
   * derives the new listing's — so nobody has to invent a product name
   * mid-broadcast.
   */
  continues_from: string | null
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
  /** TikTok's own image reference for the product hero, from use_case=MAIN_IMAGE. */
  tiktok_image_uri: string | null
  /**
   * The same photo under use_case=ATTRIBUTE_IMAGE.
   *
   * A separate field because TikTok issues a uri per use case and refuses one
   * in the other's place — a MAIN_IMAGE uri used as a variation photo fails at
   * the point of listing.
   */
  tiktok_attribute_image_uri: string | null
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
