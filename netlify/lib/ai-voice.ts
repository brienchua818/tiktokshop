import { GoogleGenAI, Type } from '@google/genai'
import { validateTextCharacters } from '../../src/lib/tiktok-rules'

/**
 * Voice -> product fields, using Gemini.
 *
 * Gemini takes audio natively and returns structured JSON in one call, so
 * there is no separate speech-to-text step to wire up. It also copes with
 * English and Mandarin mixed inside one sentence, which is what a factory
 * floor actually sounds like.
 *
 * The important subtlety: this is a TRANSLATION, not a transcription. Someone
 * may describe a product entirely in Mandarin, but TikTok rejects Chinese
 * characters in product names, so every text field must come back in English.
 *
 * Instructing that is not the same as getting it. A model asked to translate
 * will occasionally hand back the source language anyway, and the consequence
 * here is specific: the Chinese name lands in the form, the push is refused,
 * and the operator retypes by hand mid-broadcast a field the AI had just
 * filled — which is the exact friction this feature exists to remove.
 *
 * So English is checked, not assumed: one corrective retry naming the problem,
 * and if that still comes back non-English the text is DROPPED rather than
 * passed through. The numbers survive either way, because a price and a
 * quantity are digits and cannot be in the wrong language. Half the work
 * saved beats a field that has to be cleared before it can be used.
 */

const PROMPT = `You are helping list homeware products on TikTok Shop Singapore during a live broadcast at a factory.

The audio is a person describing one product. They may speak English, Mandarin, or switch between them mid-sentence. They may use Singlish.

Extract what they actually said into the fields. Rules:

- ALL text you output must be in ENGLISH. If they spoke Mandarin, translate it. Never output Chinese characters.
- Only fill a field if they actually said it. Leave it empty otherwise. Do not guess a price or quantity.
- Price: return digits only, e.g. "18.90". Singapore dollars. "Eighteen ninety" means 18.90. "Twelve dollar" means 12.00.
- Stock: a whole number of units. "Fifty pieces" means 50. "Five dozen" means 60.
- Weight: kilograms as digits. "Eight hundred grams" means "0.8". "Two kilos" means "2".
- Dimensions: centimetres as digits, no units. "Twenty by twenty by eight" means length 20, width 20, height 8.
- product_name: a short English product name, not a full sentence.

If the audio is silent, unintelligible, or not about a product, set unintelligible to true and leave everything else empty.`

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    product_name: { type: Type.STRING, description: 'Short English product name, or empty.' },
    variant_name: { type: Type.STRING, description: 'Colour or variant in English, or empty.' },
    price: { type: Type.STRING, description: 'Digits only, e.g. "18.90". Empty if not stated.' },
    stock: { type: Type.STRING, description: 'Whole number as digits. Empty if not stated.' },
    weight_kg: { type: Type.STRING, description: 'Kilograms as digits. Empty if not stated.' },
    length_cm: { type: Type.STRING, description: 'Centimetres as digits. Empty if not stated.' },
    width_cm: { type: Type.STRING, description: 'Centimetres as digits. Empty if not stated.' },
    height_cm: { type: Type.STRING, description: 'Centimetres as digits. Empty if not stated.' },
    transcript_english: {
      type: Type.STRING,
      description: 'What was said, in English. Shown to the operator so they can check it.',
    },
    unintelligible: { type: Type.BOOLEAN, description: 'True if nothing usable was heard.' },
  },
  required: ['product_name', 'price', 'stock', 'transcript_english', 'unintelligible'],
} as const

export interface VoiceResult {
  product_name: string
  variant_name?: string
  price: string
  stock: string
  weight_kg?: string
  length_cm?: string
  width_cm?: string
  height_cm?: string
  /** Echoed back to the operator, so a mishearing is visible rather than silent. */
  transcript_english: string
  unintelligible: boolean
}

/**
 * The text fields that reach TikTok, and must therefore be English.
 *
 * `transcript_english` is deliberately not one of them: it is shown to the
 * operator so they can see what was heard, and never sent anywhere. If it
 * comes back in Chinese that is a useful signal, not a fault to correct.
 */
const ENGLISH_FIELDS = ['product_name', 'variant_name'] as const

/**
 * Which text fields came back in something other than English.
 *
 * Uses the same character rules TikTok itself enforces — the ones that reject
 * Chinese (12052262) and non-English characters (12052266) — rather than a
 * separate guess about what counts as English.
 */
export function nonEnglishFields(result: VoiceResult): string[] {
  return ENGLISH_FIELDS.filter((field) => {
    const value = result[field]
    if (!value?.trim()) return false
    return validateTextCharacters(value, field, field).length > 0
  })
}

let cached: GoogleGenAI | undefined

function client(): GoogleGenAI {
  if (cached) return cached
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.')
  }
  cached = new GoogleGenAI({ apiKey })
  return cached
}

/**
 * Transcribe and extract fields from a recording.
 *
 * @param audioBase64 the recording, base64 encoded
 * @param mimeType e.g. "audio/webm" from MediaRecorder, or "audio/mp4" on iOS
 */
export async function extractFromVoice(
  audioBase64: string,
  mimeType: string,
): Promise<VoiceResult> {
  const first = await askGemini(audioBase64, mimeType)

  const wrongLanguage = nonEnglishFields(first)
  if (wrongLanguage.length === 0) return first

  // Naming the specific field that came back wrong is far more reliable than
  // re-rolling the same prompt and hoping — the same reason the photo-to-title
  // path retries with the violation spelled out.
  return askGemini(
    audioBase64,
    mimeType,
    `Your previous answer put non-English text in: ${wrongLanguage.join(', ')}. ` +
      'The speaker may have used Mandarin — TRANSLATE it into English. ' +
      'Return English words only in every text field. Never return Chinese characters.',
  )
}

async function askGemini(
  audioBase64: string,
  mimeType: string,
  correction?: string,
): Promise<VoiceResult> {
  const response = await client().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: audioBase64 } },
          { text: correction ? `${PROMPT}\n\n${correction}` : PROMPT },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA as never,
      // Near-zero temperature: this is extraction, not writing. A creative
      // reading of a spoken price is the last thing anyone wants.
      temperature: 0,
    },
  })

  const text = response.text
  if (!text) {
    throw new Error('Gemini returned no content for the recording.')
  }

  let parsed: VoiceResult
  try {
    parsed = JSON.parse(text) as VoiceResult
  } catch {
    throw new Error(`Gemini returned unparseable JSON: ${text.slice(0, 200)}`)
  }
  return parsed
}

/**
 * Normalise the model's strings into the app's field types.
 *
 * Kept separate and pure so it can be tested without calling the API — the
 * number parsing is where a spoken "eighteen ninety" quietly becomes 1890.
 */
export function normaliseVoiceResult(result: VoiceResult): {
  name?: string
  variant?: string
  price?: string
  stock?: number
  weightKg?: string
  dimensions?: { length: string; width: string; height: string }
  /**
   * Text fields withheld because they were not English after a retry.
   *
   * Surfaced rather than swallowed so the operator is told what to type,
   * instead of wondering why the name field stayed empty when they clearly
   * described the product.
   */
  dropped?: string[]
} {
  const out: ReturnType<typeof normaliseVoiceResult> = {}

  // Anything still not English is withheld. Passing it through would fill the
  // form with text that cannot be pushed, which is worse than an empty field:
  // it has to be noticed and cleared before it can be replaced.
  const dropped = nonEnglishFields(result)
  if (dropped.length > 0) out.dropped = dropped

  const name = result.product_name?.trim()
  if (name && !dropped.includes('product_name')) out.name = name

  const variant = result.variant_name?.trim()
  if (variant && !dropped.includes('variant_name')) out.variant = variant

  const price = cleanDecimal(result.price)
  if (price) out.price = price

  const stock = Number.parseInt((result.stock ?? '').replace(/[^\d]/g, ''), 10)
  if (Number.isSafeInteger(stock) && stock > 0) out.stock = stock

  const weight = cleanDecimal(result.weight_kg)
  if (weight) out.weightKg = weight

  const length = cleanDecimal(result.length_cm)
  const width = cleanDecimal(result.width_cm)
  const height = cleanDecimal(result.height_cm)
  // Only offer dimensions when all three are present; two out of three would
  // produce a nonsense title like "20x8cm".
  if (length && width && height) {
    out.dimensions = { length, width, height }
  }

  return out
}

/** Strip anything that is not a number, and reject a zero or empty result. */
function cleanDecimal(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = /\d+(?:\.\d+)?/.exec(raw.replace(/,/g, ''))
  if (!match) return undefined
  const value = match[0]
  return Number(value) > 0 ? value : undefined
}
