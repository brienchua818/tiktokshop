import { withAuth, json, methodNotAllowed } from '../lib/http'
import { credentialsFor } from '../lib/credentials'
import { hasDatabase } from '../lib/store'
import { recordPush, findPushByIdempotencyKey } from '../lib/db'
import {
  recommendCategory,
  requiredAttributes,
  salesWarehouseId,
  checkListing,
  createProduct,
} from '../lib/tiktok-product'
import {
  readProduct,
  buildAppendPayload,
  appendVariants,
  validateAddition,
  variantValueName,
  ProductFullError,
  UnsupportedVariantShapeError,
  type VariantAddition,
} from '../lib/tiktok-variants'
import { withListingLock, ListingBusyError } from '../lib/lock'
import { TikTokApiError } from '../lib/tiktok-api'
import {
  validateTitle,
  validateSellerSku,
  validatePrice,
  validateStock,
  validateWeight,
  MAX_SKUS_PER_PRODUCT,
} from '../../src/lib/tiktok-rules'

/**
 * Add one SKU to a livestream.
 *
 * A factory stream is ONE TikTok product, and each SKU called out on air — A1,
 * A2, A3 — is a *variation* of it. So the normal path here is not "create a
 * product", it is "add a variation to the product this stream lists against".
 * Creating a product happens twice in a stream at most: once at the start, and
 * again if the stream outgrows Singapore's 100-variation ceiling.
 *
 * Three things make this endpoint more careful than it looks:
 *
 *   1. TikTok's edit API deletes any variation whose id is absent from the
 *      payload, so the SKU list is always rebuilt from a snapshot read moments
 *      earlier — never from anything cached.
 *   2. That read-modify-write is serialised per listing, because two concurrent
 *      pushes would each delete the other's variation and both report success.
 *   3. Every check also runs here rather than only in the browser, since a
 *      request can reach this endpoint without going through the UI at all.
 */

interface Body {
  shop_id?: string
  /** The TikTok product id this stream lists against. Absent means start one. */
  listing_id?: string
  identifier?: string
  title?: string
  variant_name?: string | null
  price?: string
  stock?: number
  weight_kg?: string
  dimensions?: { length: string; width: string; height: string } | null
  /** From images/upload with use_case=MAIN_IMAGE. */
  tiktok_image_uri?: string
  /** The same photo with use_case=ATTRIBUTE_IMAGE. Required for a variation. */
  tiktok_attribute_image_uri?: string
  idempotency_key?: string
  /**
   * Set when the operator has accepted starting a continuation listing after
   * the current one filled up. Never inferred — creating a product is a
   * visible act in the seller's shop, so it takes a deliberate yes.
   */
  start_new_listing?: boolean
}

type Credentials = Awaited<ReturnType<typeof credentialsFor>>

export default withAuth(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const body = (await request.json()) as Body

  for (const field of [
    'shop_id',
    'identifier',
    'title',
    'price',
    'tiktok_image_uri',
    'idempotency_key',
  ] as const) {
    if (!body[field]) return json({ error: `${field} is required.` }, 400)
  }

  const problems = [
    ...validateTitle(body.title!),
    ...validateSellerSku(body.identifier!),
    ...validatePrice(body.price!),
    ...validateStock(Number(body.stock)),
    ...validateWeight(body.weight_kg ?? ''),
  ]
  if (problems.length > 0) {
    return json({ error: problems[0]!.message, problems: problems.map((p) => p.message) }, 400)
  }

  const addition: VariantAddition = {
    identifier: body.identifier!,
    variantName: body.variant_name ?? '',
    price: body.price!,
    stock: Number(body.stock),
    // A variation's photo must be an ATTRIBUTE_IMAGE upload. Falling back to
    // the main-image uri keeps an older client working rather than failing it.
    imageUri: body.tiktok_attribute_image_uri ?? body.tiktok_image_uri!,
  }

  const additionProblems = validateAddition(addition)
  if (additionProblems.length > 0) {
    return json({ error: additionProblems[0]!, problems: additionProblems }, 400)
  }

  const creds = await credentialsFor(body.shop_id!)
  const wantsNewListing = !body.listing_id || body.start_new_listing === true

  try {
    return wantsNewListing
      ? await startNewListing(body, addition, creds)
      : await addVariation(body, addition, creds)
  } catch (error) {
    if (error instanceof ListingBusyError) {
      // Deliberately retryable. The offline queue already knows how to back off
      // and try again, and nothing has been lost.
      return json({ error: error.message, code: 'LISTING_BUSY', retryable: true }, 409)
    }
    if (error instanceof ProductFullError) {
      // Not a failure — the stream has outgrown one product. Hand the UI what
      // it needs to offer a continuation listing.
      return json(
        {
          error: error.message,
          code: 'LISTING_FULL',
          product_id: error.productId,
          sku_count: error.skuCount,
          max_skus: MAX_SKUS_PER_PRODUCT,
          next: 'start_new_listing',
        },
        409,
      )
    }
    if (error instanceof UnsupportedVariantShapeError) {
      return json({ error: error.message, code: 'UNSUPPORTED_LISTING' }, 422)
    }
    if (error instanceof TikTokApiError) {
      // TikTok's own wording, passed straight through. A generic "push failed"
      // is what makes the app this replaces impossible to recover from — the
      // operator needs to read "you haven't set the return warehouse" and go
      // fix it.
      return json(
        { error: error.detail, code: error.code, daily_limit: error.isDailyLimit },
        error.isDailyLimit ? 429 : 422,
      )
    }
    throw error
  }
})

/**
 * Add a variation to the listing this stream is already using.
 *
 * Everything happens inside the lock, because the snapshot is only valid for as
 * long as nobody else is editing.
 */
async function addVariation(
  body: Body,
  addition: VariantAddition,
  creds: Credentials,
): Promise<Response> {
  const listingId = body.listing_id!

  return withListingLock(body.shop_id!, listingId, async () => {
    const snapshot = await readProduct(creds, listingId)

    // Idempotency, from the snapshot rather than from a database.
    //
    // TikTok's `idempotency_key` only exists on Create Product, so an append
    // that times out on factory Wi-Fi has no server-side guard. It does not
    // need one: the product itself records whether this identifier is already
    // a variation, and that answer is authoritative.
    const already = snapshot.skus.find((sku) => sku.sellerSku === addition.identifier)
    if (already) {
      return json({
        mode: 'variation_added',
        deduplicated: true,
        listing_id: listingId,
        product_id: snapshot.productId,
        sku_id: already.id,
        variations_now: snapshot.skus.length,
        remaining: MAX_SKUS_PER_PRODUCT - snapshot.skus.length,
      })
    }

    // Throws ProductFullError at the ceiling, which the caller turns into an
    // offer to start a continuation listing.
    const payload = buildAppendPayload(snapshot, [addition])
    const result = await appendVariants(creds, listingId, payload)

    const created = result.skus.find((sku) => sku.seller_sku === addition.identifier)
    const variationsNow = snapshot.skus.length + 1

    if (hasDatabase()) {
      await recordPush({
        draftId: crypto.randomUUID(),
        listingId,
        shopId: body.shop_id!,
        identifier: addition.identifier,
        title: body.title!,
        variantName: body.variant_name ?? null,
        price: addition.price,
        stock: addition.stock,
        weightKg: body.weight_kg!,
        dimensions: body.dimensions ?? null,
        tiktokImageUri: addition.imageUri,
        idempotencyKey: body.idempotency_key!,
        tiktokProductId: snapshot.productId,
      })
    }

    return json({
      mode: 'variation_added',
      listing_id: listingId,
      product_id: snapshot.productId,
      sku_id: created?.id ?? null,
      variant_name: variantValueName(addition.identifier, addition.variantName),
      variations_now: variationsNow,
      remaining: MAX_SKUS_PER_PRODUCT - variationsNow,
      // Adding a variation resends the product for review. The existing
      // variations stay live and buyable throughout — "If the audit passes, v2
      // is published to the shop, otherwise the existing product stays live and
      // remains unchanged" — but the new one is not purchasable until it
      // clears. Saying so is the difference between a confusing wait and an
      // expected one.
      audit: 'pending',
    })
  })
}

/**
 * Create the listing this stream will add variations to.
 *
 * The product is variant-shaped from birth: it starts with one variation on a
 * sales attribute that later ones join. A product created without a sales
 * attribute can never gain one, so this is the step that makes the rest of the
 * stream possible.
 */
async function startNewListing(
  body: Body,
  addition: VariantAddition,
  creds: Credentials,
): Promise<Response> {
  // A create that times out is the one case TikTok guards for us, and it does
  // so properly — so this pre-check is a second layer, not the only one.
  if (hasDatabase()) {
    const existing = await findPushByIdempotencyKey(body.idempotency_key!)
    if (existing?.tiktok_product_id) {
      return json({
        mode: 'listing_created',
        deduplicated: true,
        listing_id: existing.tiktok_product_id,
        product_id: existing.tiktok_product_id,
      })
    }
  }

  const input = {
    title: body.title!,
    variantName: body.variant_name ?? null,
    variantValueName: variantValueName(addition.identifier, addition.variantName),
    price: addition.price,
    stock: addition.stock,
    weightKg: body.weight_kg!,
    dimensions: body.dimensions ?? null,
    imageUri: body.tiktok_image_uri!,
    attributeImageUri: addition.imageUri,
    sellerSku: addition.identifier,
    idempotencyKey: body.idempotency_key!,
  }

  // Products can only be created in a leaf category, and the mandatory
  // attributes differ per category — so both are resolved before creating.
  const categoryId = await recommendCategory(creds, {
    title: input.title,
    imageUri: input.imageUri,
  })
  const [attributes, warehouseId] = await Promise.all([
    requiredAttributes(creds, categoryId),
    salesWarehouseId(creds),
  ])

  const issues = await checkListing(creds, input, categoryId, warehouseId, attributes)
  if (issues.length > 0) {
    // Named before it costs a slot against the daily upload cap.
    return json({ error: issues.join(' '), issues }, 422)
  }

  const productId = await createProduct(creds, input, categoryId, warehouseId, attributes)

  if (hasDatabase()) {
    await recordPush({
      draftId: crypto.randomUUID(),
      listingId: productId,
      shopId: body.shop_id!,
      identifier: input.sellerSku,
      title: input.title,
      variantName: input.variantName,
      price: input.price,
      stock: input.stock,
      weightKg: input.weightKg,
      dimensions: input.dimensions,
      tiktokImageUri: input.imageUri,
      idempotencyKey: input.idempotencyKey,
      tiktokProductId: productId,
    })
  }

  return json({
    mode: 'listing_created',
    // The new product id IS the listing id for everything that follows, which
    // is why it is returned under both names: the client stores it as the
    // stream's listing, and every later SKU appends to it.
    listing_id: productId,
    product_id: productId,
    variant_name: input.variantValueName,
    variations_now: 1,
    remaining: MAX_SKUS_PER_PRODUCT - 1,
    audit: 'pending',
  })
}
