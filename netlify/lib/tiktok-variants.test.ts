import { describe, it, expect } from 'vitest'
import {
  buildAppendPayload,
  variantValueName,
  validateAddition,
  ProductFullError,
  UnsupportedVariantShapeError,
  VALUE_NAME_MAX,
  VARIANT_ATTRIBUTE_NAME,
  type ProductSnapshot,
  type ExistingSku,
  type VariantAddition,
} from './tiktok-variants'
import { MAX_SKUS_PER_PRODUCT } from '../../src/lib/tiktok-rules'

/**
 * These tests guard one specific catastrophe.
 *
 * TikTok's edit API deletes any SKU whose id is absent from the payload. A
 * livestream is a product with up to a hundred variations on it, so a payload
 * built even slightly wrong takes the whole broadcast's work off the shop —
 * and returns HTTP 200 while doing it. There is no error to notice and no undo.
 *
 * So the assertions below are mostly not "does the new variation appear". They
 * are "does every old one survive".
 */

function sku(overrides: Partial<ExistingSku> & { id: string }): ExistingSku {
  return {
    sellerSku: `SKU${overrides.id}`,
    attributeId: '100089',
    attributeName: 'Design',
    valueId: `val-${overrides.id}`,
    valueName: `A${overrides.id} Existing Variation`,
    skuImgUri: `img-${overrides.id}`,
    priceAmount: '12.90',
    quantity: 20,
    warehouseId: 'WH1',
    ...overrides,
  }
}

function snapshot(skus: ExistingSku[]): ProductSnapshot {
  return { productId: 'PROD1', title: 'Factory Run — Ceramic Tableware', skus }
}

function addition(overrides: Partial<VariantAddition> = {}): VariantAddition {
  return {
    identifier: 'A9',
    variantName: 'Reactive Glaze Dinner Plate',
    price: '15.50',
    stock: 30,
    imageUri: 'img-new',
    ...overrides,
  }
}

interface PayloadSku {
  id?: string
  seller_sku?: string
  price: { amount: string; currency: string }
  inventory: { warehouse_id: string; quantity: number }[]
  sales_attributes: {
    id?: string
    name?: string
    value_id?: string
    value_name?: string
    sku_img?: { uri: string }
  }[]
}

function skusOf(payload: Record<string, unknown>): PayloadSku[] {
  return payload.skus as PayloadSku[]
}

describe('buildAppendPayload — existing variations must survive', () => {
  it('echoes every existing SKU back with its id', () => {
    const existing = [sku({ id: '1' }), sku({ id: '2' }), sku({ id: '3' })]
    const payload = skusOf(buildAppendPayload(snapshot(existing), [addition()]))

    // This is the assertion the whole module exists for.
    const returnedIds = payload.map((s) => s.id).filter(Boolean)
    expect(returnedIds).toEqual(['1', '2', '3'])
  })

  it('sends existing plus new, never new alone', () => {
    const existing = [sku({ id: '1' }), sku({ id: '2' })]
    const payload = skusOf(buildAppendPayload(snapshot(existing), [addition()]))

    expect(payload).toHaveLength(3)
    // The new one is the only entry without an id: "To create new SKUs, leave
    // the SKU ID blank."
    expect(payload.filter((s) => !s.id)).toHaveLength(1)
  })

  it('preserves each existing SKU price, quantity and warehouse exactly', () => {
    const existing = [
      sku({ id: '1', priceAmount: '9.90', quantity: 5, warehouseId: 'WH1' }),
      sku({ id: '2', priceAmount: '120.00', quantity: 999, warehouseId: 'WH1' }),
    ]
    const payload = skusOf(buildAppendPayload(snapshot(existing), [addition()]))

    expect(payload[0]!.price).toEqual({ amount: '9.90', currency: 'SGD' })
    expect(payload[0]!.inventory).toEqual([{ warehouse_id: 'WH1', quantity: 5 }])
    expect(payload[1]!.price).toEqual({ amount: '120.00', currency: 'SGD' })
    expect(payload[1]!.inventory).toEqual([{ warehouse_id: 'WH1', quantity: 999 }])
  })

  it('preserves each existing variation photo', () => {
    // An image is mandatory for every value of the primary attribute. Dropping
    // one existing photo fails the whole edit, taking the new variation with it.
    const existing = [sku({ id: '1', skuImgUri: 'photo-1' }), sku({ id: '2', skuImgUri: 'photo-2' })]
    const payload = skusOf(buildAppendPayload(snapshot(existing), [addition()]))

    expect(payload[0]!.sales_attributes[0]!.sku_img).toEqual({ uri: 'photo-1' })
    expect(payload[1]!.sales_attributes[0]!.sku_img).toEqual({ uri: 'photo-2' })
  })

  it('keeps existing variations addressed by value_id, not by re-sending their names', () => {
    // Re-sending value_name for a value that already has an id would create a
    // second value rather than referencing the existing one.
    const existing = [sku({ id: '1', valueId: 'V1' })]
    const payload = skusOf(buildAppendPayload(snapshot(existing), [addition()]))

    expect(payload[0]!.sales_attributes[0]!.value_id).toBe('V1')
    expect(payload[0]!.sales_attributes[0]!.value_name).toBeUndefined()
  })

  it('survives a full product: 99 existing variations all come back', () => {
    const existing = Array.from({ length: 99 }, (_, i) =>
      sku({ id: String(i + 1), valueName: `A${i + 1} Variation` }),
    )
    const payload = skusOf(buildAppendPayload(snapshot(existing), [addition({ identifier: 'A100' })]))

    expect(payload).toHaveLength(100)
    expect(payload.filter((s) => s.id)).toHaveLength(99)
  })
})

describe('buildAppendPayload — the new variation', () => {
  it('carries no id, so TikTok creates it', () => {
    const payload = skusOf(buildAppendPayload(snapshot([sku({ id: '1' })]), [addition()]))
    const added = payload.at(-1)!
    expect(added.id).toBeUndefined()
  })

  it('uses the identifier as seller_sku', () => {
    const payload = skusOf(
      buildAppendPayload(snapshot([sku({ id: '1' })]), [addition({ identifier: 'B12' })]),
    )
    expect(payload.at(-1)!.seller_sku).toBe('B12')
  })

  it('inherits the attribute id from the existing variations rather than sending a name', () => {
    // "Provide either a built-in ID or a custom name; if both are provided, the
    // ID takes priority." Sending our own name against an established id would
    // be silently ignored.
    const payload = skusOf(
      buildAppendPayload(snapshot([sku({ id: '1', attributeId: '100089' })]), [addition()]),
    )
    const attribute = payload.at(-1)!.sales_attributes[0]!
    expect(attribute.id).toBe('100089')
    expect(attribute.name).toBeUndefined()
  })

  it('falls back to the attribute name when the product has no attribute id', () => {
    const payload = skusOf(
      buildAppendPayload(
        snapshot([sku({ id: '1', attributeId: null, attributeName: 'Design' })]),
        [addition()],
      ),
    )
    expect(payload.at(-1)!.sales_attributes[0]!.name).toBe('Design')
  })

  it('reuses the existing warehouse rather than introducing one', () => {
    // 12052533: "Removal, addition, and change of warehouses are not permitted."
    const payload = skusOf(
      buildAppendPayload(snapshot([sku({ id: '1', warehouseId: 'WH-REAL' })]), [addition()]),
    )
    expect(payload.at(-1)!.inventory).toEqual([{ warehouse_id: 'WH-REAL', quantity: 30 }])
  })

  it('attaches the photo as sku_img on the attribute value', () => {
    const payload = skusOf(
      buildAppendPayload(snapshot([sku({ id: '1' })]), [addition({ imageUri: 'uri-abc' })]),
    )
    expect(payload.at(-1)!.sales_attributes[0]!.sku_img).toEqual({ uri: 'uri-abc' })
  })

  it('adds several variations in one edit', () => {
    const payload = skusOf(
      buildAppendPayload(snapshot([sku({ id: '1' })]), [
        addition({ identifier: 'A2', variantName: 'Speckled Bowl' }),
        addition({ identifier: 'A3', variantName: 'Matte Side Plate' }),
      ]),
    )
    expect(payload).toHaveLength(3)
    expect(payload.filter((s) => !s.id).map((s) => s.seller_sku)).toEqual(['A2', 'A3'])
  })
})

describe('buildAppendPayload — refusals', () => {
  it('refuses when the product would exceed Singapore 100-SKU ceiling', () => {
    const existing = Array.from({ length: MAX_SKUS_PER_PRODUCT }, (_, i) =>
      sku({ id: String(i + 1), valueName: `A${i + 1} Variation` }),
    )
    expect(() => buildAppendPayload(snapshot(existing), [addition()])).toThrow(ProductFullError)
  })

  it('reports the count in the full error, so a rollover can be offered', () => {
    const existing = Array.from({ length: 100 }, (_, i) =>
      sku({ id: String(i + 1), valueName: `A${i + 1} Variation` }),
    )
    try {
      buildAppendPayload(snapshot(existing), [addition()])
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ProductFullError)
      expect((error as ProductFullError).skuCount).toBe(100)
      expect((error as ProductFullError).productId).toBe('PROD1')
    }
  })

  it('refuses a batch that only just overflows, rather than truncating it', () => {
    // Silently dropping the overflow would list 98 of 100 and report success.
    const existing = Array.from({ length: 98 }, (_, i) =>
      sku({ id: String(i + 1), valueName: `A${i + 1} Variation` }),
    )
    const three = [
      addition({ identifier: 'A99' }),
      addition({ identifier: 'A100' }),
      addition({ identifier: 'A101' }),
    ]
    expect(() => buildAppendPayload(snapshot(existing), three)).toThrow(ProductFullError)
  })

  it('refuses a product with no existing variations', () => {
    expect(() => buildAppendPayload(snapshot([]), [addition()])).toThrow(
      UnsupportedVariantShapeError,
    )
  })

  it('refuses when TikTok returned a variation without an id', () => {
    // Echoing it back without an id would duplicate it AND delete the original.
    const existing = [sku({ id: '1' }), sku({ id: '' })]
    expect(() => buildAppendPayload(snapshot(existing), [addition()])).toThrow(
      UnsupportedVariantShapeError,
    )
  })

  it('refuses when an existing variation has no warehouse', () => {
    const existing = [sku({ id: '1', warehouseId: '' })]
    expect(() => buildAppendPayload(snapshot(existing), [addition()])).toThrow(
      UnsupportedVariantShapeError,
    )
  })

  it('refuses when existing variations disagree on having a sales attribute', () => {
    // "Each SKU must include the same number and type of sales attributes."
    const existing = [
      sku({ id: '1', attributeId: '100089' }),
      sku({ id: '2', attributeId: null, attributeName: null }),
    ]
    expect(() => buildAppendPayload(snapshot(existing), [addition()])).toThrow(
      UnsupportedVariantShapeError,
    )
  })

  it('refuses a duplicate variant name', () => {
    // "No duplicates allowed under the same attribute."
    const existing = [sku({ id: '1', valueName: 'A9 Reactive Glaze Dinner Plate' })]
    expect(() =>
      buildAppendPayload(snapshot(existing), [
        addition({ identifier: 'A9', variantName: 'Reactive Glaze Dinner Plate' }),
      ]),
    ).toThrow(/already on this listing/)
  })

  it('catches a duplicate between two additions in the same batch', () => {
    expect(() =>
      buildAppendPayload(snapshot([sku({ id: '1' })]), [
        addition({ identifier: 'A2', variantName: 'Speckled Bowl' }),
        addition({ identifier: 'A2', variantName: 'Speckled Bowl' }),
      ]),
    ).toThrow(/already on this listing/)
  })

  it('compares variant names case-insensitively', () => {
    const existing = [sku({ id: '1', valueName: 'A9 REACTIVE GLAZE DINNER PLATE' })]
    expect(() =>
      buildAppendPayload(snapshot(existing), [
        addition({ identifier: 'A9', variantName: 'Reactive Glaze Dinner Plate' }),
      ]),
    ).toThrow(/already on this listing/)
  })

  it('refuses an empty addition list', () => {
    expect(() => buildAppendPayload(snapshot([sku({ id: '1' })]), [])).toThrow(/No variations/)
  })
})

describe('buildAppendPayload — payload shape', () => {
  it('sends category_version v2, which Singapore requires', () => {
    const payload = buildAppendPayload(snapshot([sku({ id: '1' })]), [addition()])
    expect(payload.category_version).toBe('v2')
  })

  it('sends no top-level fields it does not intend to change', () => {
    // "Updates are handled per top-level property... If you need to edit any
    // nested property within an object, you must provide values for all nested
    // properties of that object. Any omitted nested properties will be
    // overwritten with blanks." Sending a partial package_weight or title is
    // therefore how a listing loses its own data.
    const payload = buildAppendPayload(snapshot([sku({ id: '1' })]), [addition()])
    expect(Object.keys(payload).sort()).toEqual(['category_version', 'skus'])
  })

  it('prices every SKU in SGD', () => {
    const payload = skusOf(buildAppendPayload(snapshot([sku({ id: '1' })]), [addition()]))
    for (const s of payload) expect(s.price.currency).toBe('SGD')
  })
})

describe('variantValueName', () => {
  it('leads with the identifier, which is what the host says on air', () => {
    expect(variantValueName('A7', 'Blue Reactive Glaze Mug')).toBe('A7 Blue Reactive Glaze Mug')
  })

  it('returns the identifier alone when there is no name', () => {
    expect(variantValueName('A7', '')).toBe('A7')
  })

  it('collapses runs of whitespace', () => {
    expect(variantValueName('A7', 'Blue   Glaze\n Mug')).toBe('A7 Blue Glaze Mug')
  })

  it('never exceeds the 50-character ceiling', () => {
    const long = 'Hand Thrown Reactive Glaze Stoneware Dinner Plate Large Format'
    const result = variantValueName('A7', long)
    expect(result.length).toBeLessThanOrEqual(VALUE_NAME_MAX)
  })

  it('truncates at a word boundary rather than mid-word', () => {
    const result = variantValueName('A7', 'Hand Thrown Reactive Glaze Stoneware Dinner Plate')
    expect(result).toBe('A7 Hand Thrown Reactive Glaze Stoneware Dinner')
    expect(result.endsWith(' ')).toBe(false)
  })

  it('keeps the identifier even when the name alone would overflow', () => {
    const result = variantValueName('A7', 'x'.repeat(200))
    expect(result.startsWith('A7 ')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(VALUE_NAME_MAX)
  })

  it('does not lose most of the name to a late word boundary', () => {
    // "A7 Supercalifragilistic..." has its only space early; clipping there
    // would leave "A7", so a mid-word cut is the better of two bad options.
    const result = variantValueName('A7', 'Supercalifragilisticexpialidociousceramicdinnerplateware')
    expect(result.length).toBe(VALUE_NAME_MAX)
  })
})

describe('validateAddition', () => {
  it('accepts a realistic variation', () => {
    expect(validateAddition(addition())).toEqual([])
  })

  it('requires a photo, because every attribute value must have one', () => {
    expect(validateAddition(addition({ imageUri: '' }))).toContain(
      'A photo is required for every variation.',
    )
  })

  it('rejects an identifier with a space, which seller_sku forbids', () => {
    expect(validateAddition(addition({ identifier: 'A 9' })).join(' ')).toMatch(/cannot contain spaces/)
  })

  it('rejects a zero or negative price', () => {
    expect(validateAddition(addition({ price: '0' })).join(' ')).toMatch(/greater than zero/)
    expect(validateAddition(addition({ price: '-5' })).join(' ')).toMatch(/greater than zero/)
  })

  it('rejects a price with three decimal places', () => {
    expect(validateAddition(addition({ price: '15.555' })).join(' ')).toMatch(/two decimal places/)
  })

  it('rejects stock outside TikTok range', () => {
    expect(validateAddition(addition({ stock: 0 })).join(' ')).toMatch(/between 1 and 99999/)
    expect(validateAddition(addition({ stock: 100_000 })).join(' ')).toMatch(/between 1 and 99999/)
  })

  it('rejects a fractional stock count', () => {
    expect(validateAddition(addition({ stock: 2.5 })).join(' ')).toMatch(/whole number/)
  })

  it('rejects Chinese in a variant name, which 12052243 refuses', () => {
    expect(validateAddition(addition({ variantName: '陶瓷杯子' })).join(' ')).toMatch(/must be English/)
  })

  it('rejects emoji in a variant name', () => {
    expect(validateAddition(addition({ variantName: 'Blue Mug 🎉' })).join(' ')).toMatch(
      /must be English/,
    )
  })

  it('accepts a short variant name — the 25-character floor is a title rule, not a variant rule', () => {
    // This is the bug the character rules were factored out to fix: reusing the
    // title validator here rejected every short variant name.
    expect(validateAddition(addition({ variantName: 'Blue Mug' }))).toEqual([])
  })

  it('accepts a variant name of exactly one word', () => {
    expect(validateAddition(addition({ variantName: 'Bowl' }))).toEqual([])
  })
})

describe('the attribute name we choose', () => {
  it('fits TikTok 20-character ceiling and is plain English', () => {
    expect(VARIANT_ATTRIBUTE_NAME.length).toBeLessThanOrEqual(20)
    expect(VARIANT_ATTRIBUTE_NAME).toMatch(/^[A-Za-z ]+$/)
  })
})
