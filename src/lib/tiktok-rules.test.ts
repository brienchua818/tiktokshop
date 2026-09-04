import { describe, it, expect } from 'vitest'
import {
  validateTitle,
  isTitleValid,
  validateSellerSku,
  validatePrice,
  validateStock,
  validateWeight,
  validateVariantName,
  variantValueName,
  continuationTitle,
  cleanPrefix,
  validatePrefix,
  TITLE_MIN,
  TITLE_MAX,
} from './tiktok-rules'

/**
 * These tests exist because every rule here is a real TikTok rejection. If one
 * regresses, the failure shows up as a listing failing mid-livestream, which is
 * the worst possible moment to discover it.
 */

describe('validateTitle', () => {
  const good = 'Ceramic Serving Bowl 20x20x8cm White'

  it('accepts a realistic homeware title', () => {
    expect(validateTitle(good)).toEqual([])
    expect(isTitleValid(good)).toBe(true)
  })

  it('rejects a title under the 25-character Singapore floor', () => {
    // The exact case that bit the original app: reads fine, API refuses it.
    const short = 'Ceramic Mug Blue'
    expect(short.length).toBeLessThan(TITLE_MIN)
    const v = validateTitle(short)
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('at least 25 characters')
  })

  it('accepts a title of exactly 25 characters', () => {
    const exact = 'Ceramic Serving Bowl 20cm'
    expect(exact).toHaveLength(25)
    expect(isTitleValid(exact)).toBe(true)
  })

  it('rejects an empty or whitespace-only title', () => {
    expect(validateTitle('')[0]!.message).toBe('Title is required.')
    expect(validateTitle('     ')[0]!.message).toBe('Title is required.')
  })

  it('rejects a title over 255 characters', () => {
    const v = validateTitle('Wooden Serving Board '.repeat(20))
    expect(v.some((x) => x.message.includes('at most 255'))).toBe(true)
  })

  it('rejects Chinese characters, which TikTok refuses in product names', () => {
    const v = validateTitle('Ceramic Serving Bowl 陶瓷碗 White Glaze')
    expect(v.some((x) => x.message.includes('must be English'))).toBe(true)
  })

  it('rejects emoji', () => {
    const v = validateTitle('Ceramic Serving Bowl White Glaze 🍚 Nice')
    expect(v.some((x) => x.message.includes('must be English'))).toBe(true)
  })

  it('rejects HTML entities', () => {
    const v = validateTitle('Ceramic Serving Bowl&nbsp;White Glaze Large')
    expect(v.some((x) => x.message.includes('HTML entity'))).toBe(true)
  })

  it('rejects control characters', () => {
    const v = validateTitle('Ceramic Serving Bowl White Glaze Large')
    expect(v.some((x) => x.message.includes('control characters'))).toBe(true)
  })

  it('rejects a symbol-only title', () => {
    const v = validateTitle('/////////////////////////////')
    expect(v.some((x) => x.message.includes('only symbols'))).toBe(true)
  })

  it('rejects more than nine of the same character in a row', () => {
    const v = validateTitle('Ceramic Bowl aaaaaaaaaaaa White Glaze')
    expect(v.some((x) => x.message.includes('nine times in a row'))).toBe(true)
  })

  it('allows exactly nine repeats, which is still legal', () => {
    const v = validateTitle('Ceramic Bowl aaaaaaaaa White Glaze Large')
    expect(v.some((x) => x.message.includes('nine times in a row'))).toBe(false)
  })

  it('allows ordinary accented Latin and curly punctuation', () => {
    expect(isTitleValid('Café Style Ceramic Mug — Cream Glaze')).toBe(true)
  })
})

describe('validateSellerSku', () => {
  it('accepts the A1 identifier scheme', () => {
    expect(validateSellerSku('A1')).toEqual([])
    expect(validateSellerSku('A247')).toEqual([])
  })

  it('rejects spaces, which TikTok forbids', () => {
    expect(validateSellerSku('A 1')[0]!.message).toContain('cannot contain spaces')
  })

  it('rejects an empty identifier', () => {
    expect(validateSellerSku('')[0]!.message).toContain('required')
  })

  it('rejects an identifier over 50 characters', () => {
    expect(validateSellerSku('A'.repeat(51))[0]!.message).toContain('at most 50')
  })
})

describe('validatePrice', () => {
  it('accepts ordinary SGD prices', () => {
    expect(validatePrice('18.90')).toEqual([])
    expect(validatePrice('9')).toEqual([])
  })

  it('rejects zero, negatives and three decimal places', () => {
    expect(validatePrice('0')).not.toEqual([])
    expect(validatePrice('-5')).not.toEqual([])
    expect(validatePrice('18.905')).not.toEqual([])
  })

  it('rejects a price that is not a number', () => {
    expect(validatePrice('cheap')).not.toEqual([])
  })
})

describe('validateStock', () => {
  it('accepts the TikTok range', () => {
    expect(validateStock(1)).toEqual([])
    expect(validateStock(99_999)).toEqual([])
  })

  it('rejects zero and anything over 99,999', () => {
    expect(validateStock(0)).not.toEqual([])
    expect(validateStock(100_000)).not.toEqual([])
  })

  it('rejects fractional stock', () => {
    expect(validateStock(1.5)).not.toEqual([])
  })
})

describe('validateWeight', () => {
  it('accepts a weight in kilograms', () => {
    expect(validateWeight('0.5')).toEqual([])
    expect(validateWeight('1.25')).toEqual([])
  })

  it('rejects a missing weight, since TikTok makes it mandatory', () => {
    expect(validateWeight('')[0]!.message).toContain('required')
  })

  it('rejects zero, which TikTok rejects with 12052181', () => {
    expect(validateWeight('0')).not.toEqual([])
  })
})

/**
 * A variant name is not a product title.
 *
 * Conflating them was a real bug. A stream is one TikTok product and every SKU
 * is a variation of it, so a SKU contributes a variant name and nothing else —
 * the product title belongs to the listing. Reusing the title validator here
 * applied a 25-character floor that does not exist for variant names, and
 * rejected every short one.
 */
describe('validateVariantName', () => {
  it('accepts a short name — there is no minimum', () => {
    // The exact case the title validator was wrongly rejecting.
    expect(validateVariantName('Blue Mug')).toEqual([])
  })

  it('accepts a single word', () => {
    expect(validateVariantName('Bowl')).toEqual([])
  })

  it('accepts a name at exactly the 50-character ceiling', () => {
    const name = 'Hand Thrown Reactive Glaze Stoneware Dinner Plates'
    expect(name).toHaveLength(50)
    expect(validateVariantName(name)).toEqual([])
  })

  it('rejects one character over the ceiling, and says by how much', () => {
    const name = 'Hand Thrown Reactive Glaze Stoneware Dinner Plate A'
    // Asserted, not counted by eye — an earlier version of this test was
    // wrong about its own fixture.
    expect(name).toHaveLength(51)
    expect(validateVariantName(name)[0]!.message).toMatch(/at most 50 characters — this is 51/)
  })

  it('requires something', () => {
    expect(validateVariantName('')[0]!.message).toMatch(/required/)
    expect(validateVariantName('   ')[0]!.message).toMatch(/required/)
  })

  it('rejects Chinese, which 12052243 refuses in a sales-attribute name', () => {
    expect(validateVariantName('白釉碗')[0]!.message).toMatch(/must be English/)
  })

  it('rejects emoji', () => {
    expect(validateVariantName('Blue Mug 🎉')[0]!.message).toMatch(/must be English/)
  })

  it('rejects a symbols-only name', () => {
    expect(validateVariantName('///')[0]!.message).toMatch(/only symbols/)
  })

  it('does not apply the title 25-character floor at all', () => {
    // Belt and braces: assert the absence of the rule, not just that one short
    // name passes.
    for (const name of ['Red', 'Blue Mug', 'Matte Bowl', 'A', '20cm']) {
      expect(
        validateVariantName(name).some((v) => /at least/.test(v.message)),
        `"${name}" was held to a minimum length`,
      ).toBe(false)
    }
  })
})

describe('variantValueName', () => {
  it('leads with the identifier, which is what the host says on air', () => {
    expect(variantValueName('A7', 'Blue Reactive Glaze Mug')).toBe('A7 Blue Reactive Glaze Mug')
  })

  it('produces a name that passes its own validator', () => {
    expect(validateVariantName(variantValueName('A7', 'Blue Reactive Glaze Mug'))).toEqual([])
  })

  it('stays valid even when the typed name alone would overflow', () => {
    // The identifier is prepended, so a 48-character name that fits on its own
    // does not once "A123 " is in front of it. Truncation keeps it legal.
    const long = 'Hand Thrown Reactive Glaze Stoneware Dinner Plate'
    expect(validateVariantName(variantValueName('A123', long))).toEqual([])
  })
})

describe('continuationTitle', () => {
  it('suffixes a first continuation with (2)', () => {
    expect(continuationTitle('Katrin BJ Ceramic Factory Run')).toBe(
      'Katrin BJ Ceramic Factory Run (2)',
    )
  })

  it('increments rather than stacking', () => {
    // A 300-SKU run makes a third listing, and "Run (2) (2)" is nobody's idea
    // of a product name.
    expect(continuationTitle('Katrin BJ Ceramic Factory Run (2)')).toBe(
      'Katrin BJ Ceramic Factory Run (3)',
    )
    expect(continuationTitle('Katrin BJ Ceramic Factory Run (9)')).toBe(
      'Katrin BJ Ceramic Factory Run (10)',
    )
  })

  it('leaves a trailing bracket that is not a part number alone', () => {
    expect(continuationTitle('Ceramic Bowl Set (Limited Edition)')).toBe(
      'Ceramic Bowl Set (Limited Edition) (2)',
    )
  })

  it('never exceeds the 255-character title ceiling', () => {
    const result = continuationTitle('x'.repeat(300))
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(result.endsWith(' (2)')).toBe(true)
  })

  it('produces a title that passes the title validator', () => {
    // Including the floor: a parent title long enough to be legal stays legal.
    expect(validateTitle(continuationTitle('Katrin BJ Ceramic Factory Run'))).toEqual([])
  })

  it('tolerates surrounding whitespace on the parent title', () => {
    expect(continuationTitle('  Katrin BJ Ceramic Factory Run  ')).toBe(
      'Katrin BJ Ceramic Factory Run (2)',
    )
  })
})

/**
 * The SKU prefix.
 *
 * Not a TikTok rule — `seller_sku` allows 50 characters. This is our own
 * ceiling, and it exists for a human reason: the prefix is spoken aloud on air
 * and read off a product by someone holding it, so it has to stay short enough
 * to say and to scan. The app it replaces allowed exactly one letter; three is
 * the deliberate widening.
 */
describe('cleanPrefix', () => {
  it('upper-cases, because the identifier is always capitals', () => {
    expect(cleanPrefix('hze')).toBe('HZE')
  })

  it('caps at three letters', () => {
    expect(cleanPrefix('CERAMIC')).toBe('CER')
  })

  it('accepts one, two or three letters unchanged', () => {
    expect(cleanPrefix('A')).toBe('A')
    expect(cleanPrefix('HZ')).toBe('HZ')
    expect(cleanPrefix('HZE')).toBe('HZE')
  })

  it('drops digits — the sequence number is derived, never typed', () => {
    expect(cleanPrefix('A1')).toBe('A')
    expect(cleanPrefix('2024')).toBe('')
  })

  it('drops spaces and punctuation, which seller_sku forbids anyway', () => {
    expect(cleanPrefix('H Z')).toBe('HZ')
    expect(cleanPrefix('H-Z_E')).toBe('HZE')
    expect(cleanPrefix('  hz  ')).toBe('HZ')
  })

  it('strips before it truncates, so punctuation cannot eat the allowance', () => {
    // "H-Z-E-X" naively sliced to three characters gives "H-Z"; stripping
    // first gives "HZE", which is what was meant.
    expect(cleanPrefix('H-Z-E-X')).toBe('HZE')
  })

  it('survives a paste of something entirely unsuitable', () => {
    expect(cleanPrefix('SUPPLIER-2024-001')).toBe('SUP')
    expect(cleanPrefix('')).toBe('')
    expect(cleanPrefix('白釉')).toBe('')
  })

  it('is idempotent — cleaning a clean prefix changes nothing', () => {
    expect(cleanPrefix(cleanPrefix('CERAMIC'))).toBe('CER')
  })
})

describe('validatePrefix', () => {
  it('accepts one to three capitals', () => {
    for (const p of ['A', 'HZ', 'HZE']) expect(validatePrefix(p)).toEqual([])
  })

  it('accepts lower case, since it is upper-cased on the way in', () => {
    expect(validatePrefix('hze')).toEqual([])
  })

  it('requires something', () => {
    expect(validatePrefix('')[0]!.message).toMatch(/required/)
    expect(validatePrefix('   ')[0]!.message).toMatch(/required/)
  })

  it('rejects four letters', () => {
    expect(validatePrefix('CERA')[0]!.message).toMatch(/one to three letters/)
  })

  it('rejects digits and punctuation', () => {
    expect(validatePrefix('A1')[0]!.message).toMatch(/one to three letters/)
    expect(validatePrefix('H-Z')[0]!.message).toMatch(/one to three letters/)
  })

  it('quotes the offending value back, so the message is actionable', () => {
    expect(validatePrefix('CERAMIC')[0]!.message).toContain('"CERAMIC"')
  })

  it('agrees with cleanPrefix: anything cleaned is valid', () => {
    // The two must not disagree, or the input would produce a value its own
    // validator rejects.
    for (const raw of ['hze', 'CERAMIC', 'H-Z-E-X', 'A1', '  hz  ']) {
      const cleaned = cleanPrefix(raw)
      if (cleaned) expect(validatePrefix(cleaned)).toEqual([])
    }
  })
})

describe('the prefix and the identifier together', () => {
  it('a three-letter prefix still produces a legal seller_sku', () => {
    // seller_sku: 1-50 characters, no spaces. "HZE100" is nowhere near.
    expect(validateSellerSku('HZE100')).toEqual([])
  })

  it('a three-letter prefix leaves room in the variant name', () => {
    // The identifier is prepended to the buyer-visible name, so a longer
    // prefix eats into the 50-character ceiling. Four characters of "HZE " is
    // affordable; it is worth asserting rather than assuming.
    const name = variantValueName('HZE100', 'Blue Reactive Glaze Mug')
    expect(name).toBe('HZE100 Blue Reactive Glaze Mug')
    expect(validateVariantName(name)).toEqual([])
  })
})
