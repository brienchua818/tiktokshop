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

/**
 * Letters allowed in a SKU prefix — the "A" in "A1", or "HZE" in "HZE1".
 *
 * Not a TikTok rule. `seller_sku` allows 50 characters, so this is our own
 * ceiling and it exists for a human reason: the prefix is spoken aloud on air
 * and read off a product by someone holding it, so it has to stay short enough
 * to say and to scan. Three letters is enough to encode a factory or a
 * category; more and the identifier stops being glanceable.
 *
 * The old app allowed exactly one letter. Three is the deliberate widening.
 */
export const PREFIX_MAX = 3

/** A prefix, once cleaned: one to three capital letters. */
const PREFIX_SHAPE = new RegExp(`^[A-Z]{1,${PREFIX_MAX}}$`)

/**
 * Clean a typed prefix into the only shape the scheme accepts.
 *
 * Applied on every keystroke rather than validated on submit, because a prefix
 * that silently refuses the fourth letter is self-explanatory, whereas an
 * error message appearing mid-livestream is not. Digits and punctuation are
 * dropped for the same reason: the sequence number is derived, so a digit in
 * the prefix could only ever be a mistake.
 */
export function cleanPrefix(raw: string): string {
  return raw
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, PREFIX_MAX)
}

/** Validate a prefix. Empty is a violation: every identifier needs one. */
export function validatePrefix(raw: string): Violation[] {
  const prefix = raw.trim().toUpperCase()
  if (prefix.length === 0) {
    return [{ field: 'prefix', message: 'A prefix is required — one to three letters.' }]
  }
  if (!PREFIX_SHAPE.test(prefix)) {
    return [
      {
        field: 'prefix',
        message: `Prefix must be one to three letters, no digits or spaces — "${raw}" is not.`,
      },
    ]
  }
  return []
}

/** Singapore caps a product at 100 SKUs; 300 is US/UK/EU/JP/BR/MX only. */
export const MAX_SKUS_PER_PRODUCT = 100

/** TikTok accepts at most three sales-attribute types per product. */
export const MAX_SALES_ATTRIBUTE_TYPES = 3

/**
 * The sales-attribute type that carries variant photos.
 *
 * TikTok allows images on exactly one attribute type per product — "You can
 * attach images to only 1 type of sales attribute, which will serve as the
 * primary attribute for display. An image must be provided for each value of
 * the primary attribute." One attribute, one value per variation, one photo per
 * value is therefore the simplest shape that works, and it is what the buyer
 * sees as a gallery of photos to tap.
 *
 * It lives here beside the other TikTok facts because both the create path and
 * the append path need it, and importing between those two would be circular.
 */
export const VARIANT_ATTRIBUTE_NAME = 'Design'

/** `sales_attributes.name`: max 20 characters. */
export const ATTRIBUTE_NAME_MAX = 20

/** `sales_attributes.value_name`: max 50 characters, unique within the attribute. */
export const VALUE_NAME_MAX = 50

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
 * The character rules TikTok applies to any buyer-visible product text —
 * titles, but equally sales-attribute names and values, which error 12052243
 * and 12052245 police the same way.
 *
 * Length is deliberately NOT checked here. Every field has its own limits (a
 * title floors at 25 characters, a variant value name caps at 50), so mixing
 * them in would mean a variant name failing a rule that was never about it.
 *
 * @param label how the field should be named in the message, e.g. "Title"
 */
export function validateTextCharacters(
  raw: string,
  field: string,
  label: string,
): Violation[] {
  const violations: Violation[] = []
  const text = raw.trim()

  if (CONTROL_CHARS.test(text)) {
    violations.push({ field, message: `${label} contains control characters.` })
  }
  if (HTML_ENTITY.test(text)) {
    violations.push({
      field,
      message: `${label} contains an HTML entity such as &nbsp; — write the character itself.`,
    })
  }
  if (NON_LATIN.test(text)) {
    violations.push({
      field,
      message: `${label} must be English. TikTok rejects Chinese characters and emoji here.`,
    })
  }
  if (!HAS_ALPHANUMERIC.test(text)) {
    violations.push({ field, message: `${label} cannot be only symbols.` })
  }
  if (TEN_IN_A_ROW.test(text)) {
    violations.push({
      field,
      message: `${label} repeats one character more than nine times in a row.`,
    })
  }
  return violations
}

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
  violations.push(...validateTextCharacters(title, 'title', 'Title'))
  return violations
}

/** True when the title passes every rule. */
export function isTitleValid(title: string): boolean {
  return validateTitle(title).length === 0
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
 * The title for a continuation listing.
 *
 * Singapore caps a product at 100 variations, so a long factory run spills
 * into a second listing. That listing needs a product title, and the one thing
 * it must not need is for someone to invent one mid-broadcast — so it is
 * derived from the listing it continues.
 *
 * An existing "(2)" is incremented rather than stacked, because a 300-SKU run
 * produces a third listing and "Ceramic Run (2) (2)" is nobody's idea of a
 * product name.
 */
export function continuationTitle(parentTitle: string): string {
  const title = parentTitle.trim()
  const match = /^(.*?)\s*\((\d+)\)$/.exec(title)
  const base = match ? match[1]!.trim() : title
  const next = match ? Number.parseInt(match[2]!, 10) + 1 : 2
  const suffix = ` (${next})`

  // Trim the base rather than overflow: TikTok rejects anything past 255, and
  // losing the tail of a long title is better than losing the whole listing.
  const room = TITLE_MAX - suffix.length
  return `${base.length > room ? base.slice(0, room).trimEnd() : base}${suffix}`
}

/**
 * Validate a variant name — the buyer-visible name of one variation.
 *
 * Deliberately NOT `validateTitle`. A product title and a variant name are
 * different fields with different rules, and conflating them was a real bug:
 *
 *   - a title floors at 25 characters; a variant name has no minimum, so
 *     "Blue Mug" is perfectly valid and was being rejected;
 *   - a title caps at 255; a variant name caps at 50.
 *
 * The character rules are shared, because TikTok polices them identically in
 * both places — 12052243 rejects Chinese in a sales-attribute name just as
 * 12052262 rejects it in a product name.
 */
export function validateVariantName(raw: string): Violation[] {
  const name = raw.trim()
  if (name.length === 0) {
    return [{ field: 'variant_name', message: 'Variant name is required.' }]
  }
  if (name.length > VALUE_NAME_MAX) {
    return [
      {
        field: 'variant_name',
        message: `Variant name must be at most ${VALUE_NAME_MAX} characters — this is ${name.length}.`,
      },
    ]
  }
  return validateTextCharacters(name, 'variant_name', 'Variant name')
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
