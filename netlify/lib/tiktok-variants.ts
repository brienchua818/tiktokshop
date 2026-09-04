/**
 * Adding variations to an existing TikTok product.
 *
 * This is the shape a factory livestream actually has: one product per stream,
 * and every SKU called out on air — A1, A2, A3 — is a *variation* of it, not a
 * product of its own. The app this replaces worked that way, and it was right
 * to.
 *
 * ---
 *
 * The single most dangerous fact about TikTok's edit API, quoted from the
 * Partial Edit Product reference:
 *
 *   "You must pass in all existing SKUs. Any existing SKU IDs not listed here
 *    will result in the deletion of those SKUs. For example, if this product
 *    contains 5 SKUs and you only provide 2 SKU IDs, the remaining 3 will be
 *    deleted."
 *
 * So there is no "append" call. Adding the 51st variation means sending all 51,
 * the 50 existing ones carrying their `id`, the new one with its `id` left
 * blank. Send only the new one and the livestream's entire back catalogue is
 * deleted — silently, with a success response.
 *
 * Every function here exists to make that impossible to get wrong by accident:
 * the payload is built from a snapshot read back from TikTok moments earlier,
 * and `buildAppendPayload` refuses to emit a payload that would drop a SKU.
 *
 * @see https://partner.tiktokshop.com/docv2/page/partial-edit-product-202509
 */

import { call } from './tiktok-api'
import {
  CATEGORY_VERSION,
  CURRENCY,
  MAX_SKUS_PER_PRODUCT,
  STOCK_MAX,
  STOCK_MIN,
  VALUE_NAME_MAX,
  VARIANT_ATTRIBUTE_NAME,
  validateTextCharacters,
} from '../../src/lib/tiktok-rules'

// Re-exported so callers of this module get the whole variant vocabulary from
// one place, even though the constants themselves are shared facts about TikTok.
export { VALUE_NAME_MAX, VARIANT_ATTRIBUTE_NAME } from '../../src/lib/tiktok-rules'
import type { Credentials } from './tiktok-product'

/**
 * A variation already live on the product, as read back from TikTok.
 *
 * `priceAmount` deliberately does not mirror the field it was read from. Get
 * Product returns the price as `price.sale_price`; every write endpoint takes
 * it as `price.amount`. Reading one and writing the other blanks the price of
 * every existing variation, so the translation happens once, here, rather than
 * at each call site.
 */
export interface ExistingSku {
  /** TikTok's SKU id. Its presence is what marks a SKU as "keep, do not delete". */
  id: string
  sellerSku: string | null
  attributeId: string | null
  attributeName: string | null
  valueId: string | null
  valueName: string | null
  skuImgUri: string | null
  priceAmount: string
  quantity: number
  warehouseId: string
}

/** A product and its variations, read immediately before an edit. */
export interface ProductSnapshot {
  productId: string
  title: string
  skus: ExistingSku[]
}

/** A variation to add. */
export interface VariantAddition {
  /** Becomes `seller_sku` — "A1". No spaces, 1–50 characters. */
  identifier: string
  /** Buyer-visible variant name. Leads with the identifier so it matches what the host says on air. */
  variantName: string
  price: string
  stock: number
  /** From `images/upload` with `use_case=ATTRIBUTE_IMAGE`. */
  imageUri: string
}

/** Raw shapes as TikTok returns them from Get Product. */
interface RawSku {
  id?: string
  seller_sku?: string | null
  sales_attributes?: {
    id?: string
    name?: string
    value_id?: string
    value_name?: string
    sku_img?: { uri?: string }
  }[]
  price?: { sale_price?: string; amount?: string; currency?: string }
  inventory?: { quantity?: number; warehouse_id?: string }[]
}

/**
 * Thrown when the product is full.
 *
 * Singapore caps a product at 100 SKUs — "Max SKUs for BR, EU, JP, MX, UK, US:
 * 300. Max SKUs for other regions: 100". A 200-SKU stream therefore cannot be
 * one product, however much we would like it to be, and discovering that at
 * SKU 101 mid-broadcast would be the worst possible moment.
 *
 * This is a distinct type so the caller can roll over to a continuation
 * product rather than surfacing a failure.
 */
export class ProductFullError extends Error {
  readonly productId: string
  readonly skuCount: number
  constructor(productId: string, skuCount: number) {
    super(
      `This listing already holds ${skuCount} of the ${MAX_SKUS_PER_PRODUCT} variations TikTok allows per product in Singapore. A continuation listing is needed.`,
    )
    this.name = 'ProductFullError'
    this.productId = productId
    this.skuCount = skuCount
  }
}

/**
 * Thrown when the product's existing variations are not a shape we can extend.
 *
 * TikTok requires that "Each SKU must include the same number and type of
 * sales attributes" — so a product built elsewhere around Colour *and* Size
 * cannot have a Design-only variation bolted on. Rather than emit a payload
 * TikTok will reject opaquely, say what is actually wrong.
 */
export class UnsupportedVariantShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedVariantShapeError'
  }
}

/**
 * Read a product and its variations.
 *
 * Called immediately before every edit, and its result is the only safe basis
 * for one. A cached snapshot is worse than no snapshot: any variation added
 * since it was taken is absent from it, and absent means deleted.
 */
export async function readProduct(
  creds: Credentials,
  productId: string,
): Promise<ProductSnapshot> {
  const result = await call<{ id?: string; title?: string; skus?: RawSku[] }>({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    accessToken: creds.accessToken,
    ...(creds.shopCipher ? { shopCipher: creds.shopCipher } : {}),
    path: `/product/202309/products/${productId}`,
    method: 'GET',
    query: { category_version: CATEGORY_VERSION },
  })

  return {
    productId: result.id ?? productId,
    title: result.title ?? '',
    skus: (result.skus ?? []).map(parseSku),
  }
}

/** Normalise one SKU from TikTok's read shape into ours. */
function parseSku(raw: RawSku): ExistingSku {
  const attribute = raw.sales_attributes?.[0]
  const inventory = raw.inventory?.[0]
  return {
    id: raw.id ?? '',
    sellerSku: raw.seller_sku ?? null,
    attributeId: attribute?.id ?? null,
    attributeName: attribute?.name ?? null,
    valueId: attribute?.value_id ?? null,
    valueName: attribute?.value_name ?? null,
    skuImgUri: attribute?.sku_img?.uri ?? null,
    // sale_price on read, amount on write. See ExistingSku.priceAmount.
    priceAmount: raw.price?.sale_price ?? raw.price?.amount ?? '',
    quantity: inventory?.quantity ?? 0,
    warehouseId: inventory?.warehouse_id ?? '',
  }
}

/**
 * The buyer-visible name for a variation.
 *
 * Leads with the identifier on purpose. In a factory livestream the host says
 * "A7 is the blue one" and the buyer looks for A7 in the variant picker — the
 * identifier is the shared vocabulary of the whole broadcast, so burying it
 * would break the one interaction that matters.
 *
 * Truncated to TikTok's 50-character ceiling at a word boundary where one is
 * available, because a name cut mid-word looks like a bug to a buyer.
 */
export function variantValueName(identifier: string, variantName: string): string {
  const name = variantName.trim().replace(/\s+/g, ' ')
  const combined = name ? `${identifier} ${name}` : identifier
  if (combined.length <= VALUE_NAME_MAX) return combined

  const clipped = combined.slice(0, VALUE_NAME_MAX)
  const lastSpace = clipped.lastIndexOf(' ')
  // Only prefer the word boundary if it does not cost most of the name.
  return lastSpace > VALUE_NAME_MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped.trimEnd()
}

/**
 * The attribute identity every SKU on this product must share.
 *
 * Prefers the id TikTok generated over the name we sent, because "if both are
 * provided, the ID takes priority" — so sending a name that disagrees with the
 * id would be silently ignored, and the mismatch would only show up as a
 * duplicate attribute later.
 */
function attributeIdentity(
  skus: readonly ExistingSku[],
): { id?: string; name?: string } {
  const withAttribute = skus.find((s) => s.attributeId || s.attributeName)
  if (!withAttribute) return { name: VARIANT_ATTRIBUTE_NAME }
  return withAttribute.attributeId
    ? { id: withAttribute.attributeId }
    : { name: withAttribute.attributeName ?? VARIANT_ATTRIBUTE_NAME }
}

/**
 * Check the existing variations are a shape we can extend, and say precisely
 * what is wrong when they are not.
 */
function assertExtendable(snapshot: ProductSnapshot): void {
  if (snapshot.skus.length === 0) {
    throw new UnsupportedVariantShapeError(
      'This listing has no variations to extend. TikTok requires at least one sales attribute on a product, so the first variation has to be created with the product itself.',
    )
  }

  const missingId = snapshot.skus.filter((s) => !s.id)
  if (missingId.length > 0) {
    // Without an id we cannot say "keep this one", and TikTok would treat it
    // as a new SKU — duplicating it while deleting the original.
    throw new UnsupportedVariantShapeError(
      `TikTok returned ${missingId.length} variation(s) without an ID for this listing. Adding to it now would duplicate them, so the push has been stopped. Try again in a moment.`,
    )
  }

  const missingWarehouse = snapshot.skus.filter((s) => !s.warehouseId)
  if (missingWarehouse.length > 0) {
    // 12052533: "Removal, addition, and change of warehouses are not
    // permitted. Please specify the original warehouses for the SKUs."
    throw new UnsupportedVariantShapeError(
      'TikTok did not return a warehouse for every existing variation on this listing. Editing it would drop their stock, so the push has been stopped.',
    )
  }

  const attributeCounts = new Set(
    snapshot.skus.map((s) => (s.attributeId || s.attributeName ? 1 : 0)),
  )
  if (attributeCounts.size > 1) {
    throw new UnsupportedVariantShapeError(
      'The variations on this listing do not all use the same sales attribute, which TikTok requires. Fix it in Seller Center, or start a new listing.',
    )
  }
}

/**
 * Build the payload that adds variations to a product.
 *
 * Emits the complete SKU list — existing variations echoed back with their ids,
 * new ones with the id omitted. That is what "adding a variation" means on this
 * API.
 *
 * @throws ProductFullError when the additions would exceed Singapore's 100-SKU
 *   ceiling, so the caller can roll over rather than fail.
 * @throws UnsupportedVariantShapeError when the existing variations cannot be
 *   safely extended.
 */
export function buildAppendPayload(
  snapshot: ProductSnapshot,
  additions: readonly VariantAddition[],
): Record<string, unknown> {
  if (additions.length === 0) {
    throw new Error('No variations were supplied to add.')
  }
  assertExtendable(snapshot)

  if (snapshot.skus.length + additions.length > MAX_SKUS_PER_PRODUCT) {
    throw new ProductFullError(snapshot.productId, snapshot.skus.length)
  }

  const identity = attributeIdentity(snapshot.skus)
  // 12052533 forbids introducing a warehouse on an edit, so new variations go
  // into the same warehouse the existing ones already use.
  const warehouseId = snapshot.skus[0]!.warehouseId

  const existing = snapshot.skus.map((sku) => ({
    id: sku.id,
    ...(sku.sellerSku ? { seller_sku: sku.sellerSku } : {}),
    price: { amount: sku.priceAmount, currency: CURRENCY },
    inventory: [{ warehouse_id: sku.warehouseId, quantity: sku.quantity }],
    sales_attributes: [
      {
        ...(sku.attributeId ? { id: sku.attributeId } : { name: sku.attributeName ?? VARIANT_ATTRIBUTE_NAME }),
        ...(sku.valueId ? { value_id: sku.valueId } : { value_name: sku.valueName ?? '' }),
        ...(sku.skuImgUri ? { sku_img: { uri: sku.skuImgUri } } : {}),
      },
    ],
  }))

  const taken = new Set(
    snapshot.skus.map((s) => (s.valueName ?? '').trim().toLowerCase()).filter(Boolean),
  )

  const added = additions.map((addition) => {
    const valueName = variantValueName(addition.identifier, addition.variantName)
    const key = valueName.toLowerCase()
    if (taken.has(key)) {
      // "No duplicates allowed under the same attribute." The identifier makes
      // this all but impossible, so hitting it means the identifier repeated —
      // which is worth failing loudly over rather than papering across.
      throw new Error(
        `A variation called "${valueName}" is already on this listing. Identifier ${addition.identifier} looks to have been used twice.`,
      )
    }
    taken.add(key)

    return {
      // No `id`: "To create new SKUs, leave the SKU ID blank and complete the
      // other fields."
      seller_sku: addition.identifier,
      price: { amount: addition.price, currency: CURRENCY },
      inventory: [{ warehouse_id: warehouseId, quantity: addition.stock }],
      sales_attributes: [
        {
          ...identity,
          value_name: valueName,
          sku_img: { uri: addition.imageUri },
        },
      ],
    }
  })

  const skus = [...existing, ...added]

  // Last line of defence. Everything above is meant to guarantee this, so a
  // failure here is a bug in this module rather than bad input — but the cost
  // of being wrong is a deleted livestream, so it is checked anyway.
  const keptIds = new Set(skus.map((s) => ('id' in s ? s.id : undefined)).filter(Boolean))
  for (const sku of snapshot.skus) {
    if (!keptIds.has(sku.id)) {
      throw new Error(
        `Refusing to edit: variation ${sku.sellerSku ?? sku.id} would have been deleted. This is a bug — nothing was sent to TikTok.`,
      )
    }
  }

  return { skus, category_version: CATEGORY_VERSION }
}

/** Validate one addition before it can reach TikTok. */
export function validateAddition(addition: VariantAddition): string[] {
  const problems: string[] = []
  if (!addition.identifier?.trim()) problems.push('SKU identifier is required.')
  if (/\s/.test(addition.identifier ?? '')) problems.push('SKU identifier cannot contain spaces.')
  if (!addition.imageUri?.trim()) problems.push('A photo is required for every variation.')
  if (!/^\d+(\.\d{1,2})?$/.test(addition.price ?? '') || Number(addition.price) <= 0) {
    problems.push('Price must be a number greater than zero, with at most two decimal places.')
  }
  if (!Number.isInteger(addition.stock) || addition.stock < STOCK_MIN || addition.stock > STOCK_MAX) {
    problems.push(`Stock must be a whole number between ${STOCK_MIN} and ${STOCK_MAX}.`)
  }

  const valueName = variantValueName(addition.identifier ?? '', addition.variantName ?? '')
  if (valueName.length > VALUE_NAME_MAX) {
    problems.push(`Variant name must be at most ${VALUE_NAME_MAX} characters.`)
  }
  // Attribute values are held to the same character rules as titles — 12052243
  // rejects Chinese in sales-attribute names, 12052245 invalid characters — but
  // not to a title's 25-character floor, which is why the character rules live
  // in their own validator.
  problems.push(
    ...validateTextCharacters(valueName, 'variant_name', 'Variant name').map((v) => v.message),
  )

  return problems
}

/**
 * Send the edit.
 *
 * Never retried on a non-network failure: a rejected edit fails identically on
 * a second attempt, and each attempt counts against the shop's daily relisting
 * allowance.
 */
export async function appendVariants(
  creds: Credentials,
  productId: string,
  payload: Record<string, unknown>,
): Promise<{ skus: { id: string; seller_sku: string | null }[] }> {
  const result = await call<{
    product_id?: string
    skus?: { id?: string; seller_sku?: string | null }[]
  }>({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    accessToken: creds.accessToken,
    ...(creds.shopCipher ? { shopCipher: creds.shopCipher } : {}),
    path: `/product/202509/products/${productId}/partial_edit`,
    method: 'POST',
    json: payload,
    maxAttempts: 1,
  })

  return {
    skus: (result.skus ?? []).map((s) => ({ id: s.id ?? '', seller_sku: s.seller_sku ?? null })),
  }
}
