import { withAuth, json, methodNotAllowed } from '../lib/http'
import { shopCredentials, recordPush, findPushByIdempotencyKey } from '../lib/db'
import {
  recommendCategory,
  requiredAttributes,
  salesWarehouseId,
  checkListing,
  createProduct,
} from '../lib/tiktok-product'
import { TikTokApiError } from '../lib/tiktok-api'
import { validateTitle, validateSellerSku, validatePrice, validateStock, validateWeight } from '../../src/lib/tiktok-rules'

/**
 * Push one SKU to TikTok.
 *
 * Validation runs here as well as in the browser. The client checks are for
 * fast feedback; these are the ones that actually protect the shop, since a
 * request can reach this endpoint without going through the UI at all.
 */
export default withAuth(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const body = (await request.json()) as {
    shop_id?: string
    listing_id?: string
    identifier?: string
    title?: string
    variant_name?: string | null
    price?: string
    stock?: number
    weight_kg?: string
    dimensions?: { length: string; width: string; height: string } | null
    tiktok_image_uri?: string
    idempotency_key?: string
  }

  for (const field of ['shop_id', 'listing_id', 'identifier', 'title', 'price', 'tiktok_image_uri', 'idempotency_key'] as const) {
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

  // A retry after a timeout arrives with the same key. Returning the original
  // product is what makes the offline queue safe — otherwise a dropped
  // connection quietly creates the same product twice.
  const existing = await findPushByIdempotencyKey(body.idempotency_key!)
  if (existing?.tiktok_product_id) {
    return json({ product_id: existing.tiktok_product_id, deduplicated: true })
  }

  const creds = await shopCredentials(body.shop_id!)

  const input = {
    title: body.title!,
    variantName: body.variant_name ?? null,
    price: body.price!,
    stock: Number(body.stock),
    weightKg: body.weight_kg!,
    dimensions: body.dimensions ?? null,
    imageUri: body.tiktok_image_uri!,
    sellerSku: body.identifier!,
    idempotencyKey: body.idempotency_key!,
  }

  try {
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

    await recordPush({
      draftId: crypto.randomUUID(),
      listingId: body.listing_id!,
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

    return json({ product_id: productId })
  } catch (error) {
    // TikTok's own wording is passed straight through. A generic "push failed"
    // is what makes the current app impossible to recover from — the operator
    // needs to read "you haven't set the return warehouse" and go fix it.
    if (error instanceof TikTokApiError) {
      return json(
        { error: error.detail, code: error.code, daily_limit: error.isDailyLimit },
        error.isDailyLimit ? 429 : 422,
      )
    }
    throw error
  }
})
