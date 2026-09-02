import { call } from './tiktok-api'
import {
  CATEGORY_VERSION,
  CURRENCY,
  WEIGHT_UNIT,
  DIMENSION_UNIT,
} from '../../src/lib/tiktok-rules'

/**
 * Creating a product on TikTok.
 *
 * The order of operations here is not arbitrary — it is the sequence that
 * avoids the two commonest listing failures:
 *
 *   1. resolve a LEAF category (products cannot be created in a branch),
 *   2. fetch that category's mandatory attributes and fill them,
 *   3. dry-run with listing_check so problems are named before they cost a
 *      slot against the daily upload cap,
 *   4. create.
 */

export interface Credentials {
  appKey: string
  appSecret: string
  accessToken: string
  shopCipher: string | undefined
}

function shopScoped(creds: Credentials) {
  return {
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    accessToken: creds.accessToken,
    ...(creds.shopCipher ? { shopCipher: creds.shopCipher } : {}),
  }
}

/** Ask TikTok which leaf category a title and photo belong in. */
export async function recommendCategory(
  creds: Credentials,
  input: { title: string; imageUri: string },
): Promise<string> {
  const result = await call<{ leaf_category_id: string }>({
    ...shopScoped(creds),
    path: '/product/202309/categories/recommend',
    method: 'POST',
    json: {
      product_title: input.title,
      images: [{ uri: input.imageUri }],
      category_version: CATEGORY_VERSION,
    },
  })
  if (!result.leaf_category_id) {
    throw new Error('TikTok could not suggest a category for this product.')
  }
  return result.leaf_category_id
}

interface AttributeValue {
  id: string
  name: string
}

interface Attribute {
  id: string
  name: string
  type: 'SALES_PROPERTY' | 'PRODUCT_PROPERTY'
  values: AttributeValue[]
  /**
   * TikTok's own schema misspells this. Reading `is_required` returns
   * undefined and every required attribute is silently skipped, which then
   * fails at create time with an unhelpful error.
   */
  is_requried?: boolean
  is_customizable?: boolean
}

/**
 * The mandatory product attributes for a category, filled with the first
 * allowed value.
 *
 * Choosing the first value is a deliberate simplification: these are fields
 * like "Material" or "Number of Pieces" that TikTok insists on but which
 * nobody wants to answer 200 times mid-livestream. A wrong-but-valid value
 * that lists beats a correct one that never gets entered — and the attributes
 * remain editable in Seller Center afterwards.
 */
export async function requiredAttributes(
  creds: Credentials,
  categoryId: string,
): Promise<{ id: string; values: { id: string }[] }[]> {
  const result = await call<{ attributes: Attribute[] }>({
    ...shopScoped(creds),
    path: `/product/202309/categories/${categoryId}/attributes`,
    method: 'GET',
    query: { category_version: CATEGORY_VERSION },
  })

  return (result.attributes ?? [])
    .filter((a) => a.type === 'PRODUCT_PROPERTY' && a.is_requried === true)
    .map((a) => {
      const first = a.values?.[0]
      return first ? { id: a.id, values: [{ id: first.id }] } : null
    })
    .filter((a): a is { id: string; values: { id: string }[] } => a !== null)
}

/** A sales warehouse id, required on every SKU's inventory. */
export async function salesWarehouseId(creds: Credentials): Promise<string> {
  const result = await call<{
    warehouses: { id: string; type: string; effect_status: string; is_default?: boolean }[]
  }>({
    ...shopScoped(creds),
    path: '/logistics/202309/warehouses',
    method: 'GET',
  })

  const usable = (result.warehouses ?? []).filter(
    (w) => w.type === 'SALES_WAREHOUSE' && w.effect_status === 'ENABLED',
  )
  const chosen = usable.find((w) => w.is_default) ?? usable[0]
  if (!chosen) {
    throw new Error(
      'No enabled sales warehouse was found for this shop. Set one up in Seller Center first.',
    )
  }
  return chosen.id
}

export interface ProductInput {
  title: string
  variantName: string | null
  price: string
  stock: number
  weightKg: string
  dimensions: { length: string; width: string; height: string } | null
  imageUri: string
  sellerSku: string
  idempotencyKey: string
}

function buildPayload(
  input: ProductInput,
  categoryId: string,
  warehouseId: string,
  attributes: { id: string; values: { id: string }[] }[],
): Record<string, unknown> {
  return {
    title: input.title,
    // Mandatory, HTML, and it must be English. Built from the title rather
    // than asked for, because nobody writes a description mid-livestream.
    description: `<p>${escapeHtml(input.title)}</p>`,
    category_id: categoryId,
    category_version: CATEGORY_VERSION,
    main_images: [{ uri: input.imageUri }],
    package_weight: { value: input.weightKg, unit: WEIGHT_UNIT },
    ...(input.dimensions
      ? {
          package_dimensions: {
            length: input.dimensions.length,
            width: input.dimensions.width,
            height: input.dimensions.height,
            unit: DIMENSION_UNIT,
          },
        }
      : {}),
    ...(attributes.length > 0 ? { product_attributes: attributes } : {}),
    skus: [
      {
        seller_sku: input.sellerSku,
        price: { amount: input.price, currency: CURRENCY },
        inventory: [{ warehouse_id: warehouseId, quantity: input.stock }],
      },
    ],
    // TikTok holds the draft itself, so our queue and their state cannot drift.
    save_mode: 'LISTING',
    // Makes a timed-out create safe to retry without duplicating the product.
    idempotency_key: input.idempotencyKey,
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Dry-run the listing.
 *
 * Worth the extra call: a rejection at create time still counts against the
 * shop's daily upload allowance, and during a livestream that allowance is the
 * scarce resource.
 */
export async function checkListing(
  creds: Credentials,
  input: ProductInput,
  categoryId: string,
  warehouseId: string,
  attributes: { id: string; values: { id: string }[] }[],
): Promise<string[]> {
  try {
    const result = await call<{ issues?: { message: string }[] }>({
      ...shopScoped(creds),
      path: '/product/202309/products/listing_check',
      method: 'POST',
      json: buildPayload(input, categoryId, warehouseId, attributes),
    })
    return (result.issues ?? []).map((i) => i.message)
  } catch (error) {
    // A failed pre-flight is not itself a reason to block the push — the real
    // create will report the truth. Log it and carry on.
    console.error('[tikshop] listing_check failed', error)
    return []
  }
}

export async function createProduct(
  creds: Credentials,
  input: ProductInput,
  categoryId: string,
  warehouseId: string,
  attributes: { id: string; values: { id: string }[] }[],
): Promise<string> {
  const result = await call<{ product_id: string }>({
    ...shopScoped(creds),
    path: '/product/202309/products',
    method: 'POST',
    json: buildPayload(input, categoryId, warehouseId, attributes),
    // Never retried: a rejected listing fails identically and each attempt
    // costs part of the daily allowance.
    maxAttempts: 1,
  })
  if (!result.product_id) {
    throw new Error('TikTok accepted the product but returned no product ID.')
  }
  return result.product_id
}
