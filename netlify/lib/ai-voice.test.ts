import { describe, it, expect } from 'vitest'
import { normaliseVoiceResult, nonEnglishFields, type VoiceResult } from './ai-voice'
import { validateTitle } from '../../src/lib/tiktok-rules'

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

/**
 * Chinese in, English out.
 *
 * The requirement is precise: the operator may speak Mandarin, and the product
 * title that reaches TikTok must be English — error 12052262 rejects Chinese
 * characters in product names outright, and 12052243 rejects them in
 * sales-attribute names.
 *
 * Instructing the model is not the same as getting it, so these assert the
 * enforcement rather than the prompt.
 */

function voice(over: Partial<VoiceResult> = {}): VoiceResult {
  return {
    product_name: 'Ceramic Serving Bowl',
    variant_name: 'White Glaze',
    price: '18.90',
    stock: '50',
    transcript_english: 'White glaze ceramic serving bowl, eighteen ninety, fifty pieces',
    unintelligible: false,
    ...over,
  }
}

describe('nonEnglishFields', () => {
  it('passes a fully English result', () => {
    expect(nonEnglishFields(voice())).toEqual([])
  })

  it('catches a Chinese product name', () => {
    expect(nonEnglishFields(voice({ product_name: '陶瓷碗' }))).toEqual(['product_name'])
  })

  it('catches a Chinese variant name', () => {
    // Buyer-visible, and 12052243 rejects it.
    expect(nonEnglishFields(voice({ variant_name: '白色' }))).toEqual(['variant_name'])
  })

  it('catches both at once', () => {
    expect(nonEnglishFields(voice({ product_name: '陶瓷碗', variant_name: '白色' }))).toEqual([
      'product_name',
      'variant_name',
    ])
  })

  it('catches emoji, which TikTok also refuses', () => {
    expect(nonEnglishFields(voice({ product_name: 'Ceramic Bowl 🎉' }))).toEqual(['product_name'])
  })

  it('ignores an empty field rather than reporting it as wrong', () => {
    expect(nonEnglishFields(voice({ variant_name: '' }))).toEqual([])
    expect(nonEnglishFields(voice({ variant_name: '   ' }))).toEqual([])
  })

  it('does not police the transcript', () => {
    // It is shown to the operator and never sent anywhere. Chinese there is a
    // signal the translation failed, not a field to correct.
    expect(nonEnglishFields(voice({ transcript_english: '陶瓷碗，十八块九' }))).toEqual([])
  })

  it('accepts accented Latin, which is not Chinese', () => {
    expect(nonEnglishFields(voice({ product_name: 'Café Ceramic Bowl' }))).toEqual([])
  })
})

describe('normaliseVoiceResult — Chinese must never reach the form', () => {
  it('withholds a Chinese product name', () => {
    // Passing it through is worse than an empty field: it has to be noticed
    // and cleared before it can be replaced, mid-broadcast.
    const out = normaliseVoiceResult(voice({ product_name: '陶瓷碗' }))
    expect(out.name).toBeUndefined()
    expect(out.dropped).toEqual(['product_name'])
  })

  it('keeps the price and quantity when the name is dropped', () => {
    // This is the whole point of dropping rather than failing — digits have no
    // language, so half the work is still saved.
    const out = normaliseVoiceResult(voice({ product_name: '陶瓷碗' }))
    expect(out.price).toBe('18.90')
    expect(out.stock).toBe(50)
  })

  it('keeps the name when only the variant is Chinese', () => {
    const out = normaliseVoiceResult(voice({ variant_name: '白色' }))
    expect(out.name).toBe('Ceramic Serving Bowl')
    expect(out.variant).toBeUndefined()
    expect(out.dropped).toEqual(['variant_name'])
  })

  it('reports nothing dropped when everything is English', () => {
    expect(normaliseVoiceResult(voice()).dropped).toBeUndefined()
  })

  it('accepts a Mandarin description translated into English — the whole feature', () => {
    // What Gemini should return for someone saying
    // "白釉陶瓷碗，十八块九，五十个".
    const out = normaliseVoiceResult(
      voice({
        product_name: 'White Glaze Ceramic Bowl',
        variant_name: 'White Glaze',
        price: '18.90',
        stock: '50',
        transcript_english: 'White glaze ceramic bowl, 18.90, fifty pieces',
      }),
    )
    expect(out).toEqual({
      name: 'White Glaze Ceramic Bowl',
      variant: 'White Glaze',
      price: '18.90',
      stock: 50,
    })
  })

  it('produces a name that passes the title validator once prefixed', () => {
    // The name is only half a title — the identifier leads it — so what
    // matters is that nothing it contains can fail TikTok's character rules.
    const out = normaliseVoiceResult(voice({ product_name: 'White Glaze Ceramic Serving Bowl' }))
    expect(validateTitle(`A1-${out.name}`)).toEqual([])
  })
})
