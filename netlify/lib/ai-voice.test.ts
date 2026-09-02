import { describe, it, expect } from 'vitest'
import { normaliseVoiceResult, type VoiceResult } from './ai-voice'

/**
 * The API call itself is not unit tested — the value is in the number
 * parsing, which is where a spoken "eighteen ninety" quietly becomes 1890 and
 * a product goes live at the wrong price.
 */

function result(partial: Partial<VoiceResult>): VoiceResult {
  return {
    product_name: '',
    price: '',
    stock: '',
    transcript_english: '',
    unintelligible: false,
    ...partial,
  }
}

describe('normaliseVoiceResult', () => {
  it('extracts a full spoken description', () => {
    expect(
      normaliseVoiceResult(
        result({
          product_name: 'Ceramic Serving Bowl',
          variant_name: 'White Glaze',
          price: '18.90',
          stock: '50',
          weight_kg: '0.8',
          length_cm: '20',
          width_cm: '20',
          height_cm: '8',
        }),
      ),
    ).toEqual({
      name: 'Ceramic Serving Bowl',
      variant: 'White Glaze',
      price: '18.90',
      stock: 50,
      weightKg: '0.8',
      dimensions: { length: '20', width: '20', height: '8' },
    })
  })

  it('returns nothing when nothing was said', () => {
    expect(normaliseVoiceResult(result({ unintelligible: true }))).toEqual({})
  })

  it('omits a field the speaker did not mention rather than guessing', () => {
    const out = normaliseVoiceResult(result({ product_name: 'Rattan Tray' }))
    expect(out).toEqual({ name: 'Rattan Tray' })
    expect(out.price).toBeUndefined()
    expect(out.stock).toBeUndefined()
  })

  it('strips currency symbols and words from a price', () => {
    expect(normaliseVoiceResult(result({ price: 'SGD 18.90' })).price).toBe('18.90')
    expect(normaliseVoiceResult(result({ price: '$12' })).price).toBe('12')
  })

  it('strips thousands separators', () => {
    expect(normaliseVoiceResult(result({ price: '1,299.00' })).price).toBe('1299.00')
  })

  it('rejects a zero price rather than listing something free', () => {
    expect(normaliseVoiceResult(result({ price: '0' })).price).toBeUndefined()
    expect(normaliseVoiceResult(result({ price: '0.00' })).price).toBeUndefined()
  })

  it('parses stock from a phrase with units attached', () => {
    expect(normaliseVoiceResult(result({ stock: '50 pieces' })).stock).toBe(50)
  })

  it('rejects zero or negative stock', () => {
    expect(normaliseVoiceResult(result({ stock: '0' })).stock).toBeUndefined()
    expect(normaliseVoiceResult(result({ stock: 'none' })).stock).toBeUndefined()
  })

  it('offers dimensions only when all three are present', () => {
    // Two out of three would build a nonsense title like "20x8cm".
    expect(
      normaliseVoiceResult(result({ length_cm: '20', width_cm: '20' })).dimensions,
    ).toBeUndefined()
    expect(
      normaliseVoiceResult(result({ length_cm: '20', width_cm: '20', height_cm: '8' })).dimensions,
    ).toEqual({ length: '20', width: '20', height: '8' })
  })

  it('handles a weight given in decimal kilograms', () => {
    expect(normaliseVoiceResult(result({ weight_kg: '0.8 kg' })).weightKg).toBe('0.8')
  })

  it('rejects a zero weight, which TikTok refuses anyway', () => {
    expect(normaliseVoiceResult(result({ weight_kg: '0' })).weightKg).toBeUndefined()
  })

  it('trims whitespace from names', () => {
    expect(normaliseVoiceResult(result({ product_name: '  Linen Napkin Set  ' })).name).toBe(
      'Linen Napkin Set',
    )
  })

  it('treats a whitespace-only name as absent', () => {
    expect(normaliseVoiceResult(result({ product_name: '   ' })).name).toBeUndefined()
  })
})
