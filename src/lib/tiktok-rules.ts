/**
 * TikTok Shop's own listing constraints, for the Singapore market.
 *
 * These are transcribed from the Create Product API reference and its error
 * codes, not invented:
 *   https://partner.tiktokshop.com/docv2/page/create-product-202309
 *
 * They live here rather than scattered through the UI so there is one place to
 * correct when TikTok changes a rule, and so the same check runs client-side
 * (fast feedback) and server-side (the one that actually protects us).
 */

/**
 * Title length for Singapore is [25, 255]. Only DE, ES, FR, IE, IT, JP, UK and
 * US get the [1, 255] carve-out; "other regions" keep the 25-character floor.
 * A 16-character title like "Ceramic Mug Blue" is rejected by the API, so this
 * is a hard gate, not a style preference.
 */
export const TITLE_MIN = 25
export const TITLE_MAX = 255

/** seller_sku: 1–50 characters, "Text without spaces". Our A1/A2 scheme fits. */
export const SELLER_SKU_MAX = 50

/** Singapore caps a product at 100 SKUs; 300 is US/UK/EU/JP/BR/MX only. */
export const MAX_SKUS_PER_PRODUCT = 100

/** TikTok accepts at most three sales-attribute types per product. */
export const MAX_SALES_ATTRIBUTE_TYPES = 3

/** Inventory quantity range per SKU. */
export const STOCK_MIN = 1
export const STOCK_MAX = 99_999

/** Singapore is a SEA market, so the v2 (7-level) category tree is mandatory. */
export const CATEGORY_VERSION = 'v2'

/** Fixed for Singapore. TikTok rejects mismatched measurement systems. */
export const WEIGHT_UNIT = 'KILOGRAM'
export const DIMENSION_UNIT = 'CENTIMETER'
export const CURRENCY = 'SGD'

/**
 * Fixed package weight and dimensions.
 *
 * TikTok makes both mandatory on every product, but they do not vary enough
 * across a factory run to be worth typing 200 times — so they are declared
 * once here and never shown in the form.
 *
 * These are a SHIPPING declaration, not a measurement of the product. That is
 * why dimensions no longer appear in product titles: stating 10x10x10cm in a
 * title would advertise a size the product does not have.
 */
export const DEFAULT_WEIGHT_KG = '1'
export const DEFAULT_DIMENSIONS = { length: '10', width: '10', height: '10' } as const

/** MAIN_IMAGE must land between 300x300 and 4000x4000. We target the middle. */
export const IMAGE_TARGET_PX = 1600
export const IMAGE_MIN_PX = 300
export const IMAGE_MAX_PX = 4000

export interface Violation {
  field: string
  message: string
}

/**
 * Any character outside Latin-1 plus common punctuation. Catches Chinese —
 * which TikTok rejects outright in product names (error 12052262 "Chinese
 * characters are not supported in product name", 12052266 "contains
 * non-English characters") — and also emoji, which error 12052931 forbids.
 *
 * This is why the voice feature translates rather than transcribes: someone
 * may speak Mandarin, but the title that reaches TikTok must be English.
 */
const NON_LATIN = /[^\u0020-\u024F\u2018\u2019\u201C\u201D\u2013\u2014]/u

/** ASCII control characters, including DEL. Forbidden by 12052931. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

/** HTML entities such as &nbsp;. Forbidden by 12052931. */
const HTML_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/

/** More than nine consecutive repeats, e.g. "aaaaaaaaaa". Forbidden by 12052931. */
const TEN_IN_A_ROW = /(.)\1{9,}/

/** At least one letter or digit — blocks symbol-only titles like "////". */
const HAS_ALPHANUMERIC = /[a-zA-Z0-9]/

/**
 * Validate a product title against every rule TikTok enforces for Singapore.
 * Returns an empty array when the title is acceptable.
 */
export function validateTitle(raw: string): Violation[] {
  const violations: Violation[] = []
  const title = raw.trim()

  if (title.length === 0) {
    return [{ field: 'title', message: 'Title is required.' }]
  }
  if (title.length < TITLE_MIN) {
    violations.push({
      field: 'title',
      message: `Title must be at least ${TITLE_MIN} characters for Singapore — this is ${title.length}. TikTok rejects anything shorter.`,
    })
  }
  if (title.length > TITLE_MAX) {
    violations.push({
      field: 'title',
      message: `Title must be at most ${TITLE_MAX} characters — this is ${title.length}.`,
    })
  }
  if (CONTROL_CHARS.test(title)) {
    violations.push({ field: 'title', message: 'Title contains control characters.' })
  }
  if (HTML_ENTITY.test(title)) {
    violations.push({
      field: 'title',
      message: 'Title contains an HTML entity such as &nbsp; — write the character itself.',
    })
  }
  if (NON_LATIN.test(title)) {
    violations.push({
      field: 'title',
      message:
        'Title must be English. TikTok rejects Chinese characters and emoji in product names.',
    })
  }
  if (!HAS_ALPHANUMERIC.test(title)) {
    violations.push({ field: 'title', message: 'Title cannot be only symbols.' })
  }
  if (TEN_IN_A_ROW.test(title)) {
    violations.push({
      field: 'title',
      message: 'Title repeats one character more than nine times in a row.',
    })
  }
  return violations
}

/** True when the title passes every rule. */
export function isTitleValid(title: string): boolean {
  return validateTitle(title).length === 0
}

/**
 * TikTok requires seller_sku to carry no spaces. Our identifiers ("A1") never
 * do, but a hand-edited one might.
 */
export function validateSellerSku(raw: string): Violation[] {
  const sku = raw.trim()
  if (sku.length === 0) {
    return [{ field: 'seller_sku', message: 'SKU identifier is required.' }]
  }
  if (sku.length > SELLER_SKU_MAX) {
    return [
      { field: 'seller_sku', message: `SKU identifier must be at most ${SELLER_SKU_MAX} characters.` },
    ]
  }
  if (/\s/.test(sku)) {
    return [{ field: 'seller_sku', message: 'SKU identifier cannot contain spaces.' }]
  }
  return []
}

/** Price must be a positive decimal with at most two places. */
export function validatePrice(raw: string): Violation[] {
  const price = raw.trim()
  if (price.length === 0) {
    return [{ field: 'price', message: 'Price is required.' }]
  }
  if (!/^\d+(\.\d{1,2})?$/.test(price)) {
    return [{ field: 'price', message: 'Price must be a number with at most two decimal places.' }]
  }
  if (Number(price) <= 0) {
    return [{ field: 'price', message: 'Price must be more than zero.' }]
  }
  return []
}

export function validateStock(stock: number): Violation[] {
  if (!Number.isInteger(stock)) {
    return [{ field: 'stock', message: 'Stock must be a whole number.' }]
  }
  if (stock < STOCK_MIN || stock > STOCK_MAX) {
    return [
      { field: 'stock', message: `Stock must be between ${STOCK_MIN} and ${STOCK_MAX}.` },
    ]
  }
  return []
}

/**
 * Package weight is mandatory for every non-virtual product — error 12052181
 * "The package weight of the product can not be zero". The app it replaces has
 * no weight field at all, so it must be defaulting one silently.
 */
export function validateWeight(raw: string): Violation[] {
  const weight = raw.trim()
  if (weight.length === 0) {
    return [
      {
        field: 'weight_kg',
        message: 'Package weight is required — TikTok rejects products without one.',
      },
    ]
  }
  if (!/^\d+(\.\d{1,3})?$/.test(weight) || Number(weight) <= 0) {
    return [{ field: 'weight_kg', message: 'Package weight must be more than zero, in kilograms.' }]
  }
  return []
}
