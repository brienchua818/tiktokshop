import { describe, it, expect } from 'vitest'
import {
  validateTitle,
  isTitleValid,
  validateSellerSku,
  validatePrice,
  validateStock,
  validateWeight,
  TITLE_MIN,
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
