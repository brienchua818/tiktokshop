import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The corrective retry, with Gemini mocked.
 *
 * This is the enforcement that makes "speak Mandarin, list in English" real
 * rather than aspirational. The prompt asks for a translation; a model will
 * sometimes hand back the source language anyway, and the cost of not noticing
 * is the operator retyping — mid-broadcast — a field the AI had just filled.
 *
 * In its own file because it mocks the SDK, and the sibling suite deliberately
 * does not.
 */

const generateContent = vi.fn()

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent }
  },
  Type: {
    OBJECT: 'OBJECT', STRING: 'STRING', BOOLEAN: 'BOOLEAN',
  },
}))

const { extractFromVoice } = await import('./ai-voice')

/** What the model returns, as a Gemini-shaped response. */
function reply(over: Record<string, unknown>) {
  return {
    text: JSON.stringify({
      product_name: 'Ceramic Serving Bowl',
      variant_name: 'White Glaze',
      price: '18.90',
      stock: '50',
      transcript_english: 'ceramic serving bowl, eighteen ninety, fifty pieces',
      unintelligible: false,
      ...over,
    }),
  }
}

/** The prompt text actually sent on a given call. */
function promptOf(call: number): string {
  const parts = generateContent.mock.calls[call]![0].contents[0].parts
  return parts.find((p: { text?: string }) => typeof p.text === 'string').text
}

beforeEach(() => {
  generateContent.mockReset()
  process.env.GEMINI_API_KEY = 'test-key'
})

describe('extractFromVoice — enforcing English', () => {
  it('does not retry when the first answer is already English', async () => {
    generateContent.mockResolvedValueOnce(reply({}))
    const out = await extractFromVoice('AAAA', 'audio/webm')
    expect(generateContent).toHaveBeenCalledTimes(1)
    expect(out.product_name).toBe('Ceramic Serving Bowl')
  })

  it('retries once when the product name comes back in Chinese', async () => {
    generateContent
      .mockResolvedValueOnce(reply({ product_name: '陶瓷碗' }))
      .mockResolvedValueOnce(reply({ product_name: 'Ceramic Bowl' }))

    const out = await extractFromVoice('AAAA', 'audio/webm')
    expect(generateContent).toHaveBeenCalledTimes(2)
    expect(out.product_name).toBe('Ceramic Bowl')
  })

  it('names the offending field in the correction, rather than re-rolling blind', async () => {
    generateContent
      .mockResolvedValueOnce(reply({ product_name: '陶瓷碗' }))
      .mockResolvedValueOnce(reply({ product_name: 'Ceramic Bowl' }))

    await extractFromVoice('AAAA', 'audio/webm')
    const correction = promptOf(1)
    expect(correction).toContain('product_name')
    expect(correction).toMatch(/TRANSLATE/)
    // The original instructions must survive alongside the correction, or the
    // retry loses the price and quantity rules.
    expect(correction).toContain('Singapore dollars')
  })

  it('retries on a Chinese variant name too', async () => {
    generateContent
      .mockResolvedValueOnce(reply({ variant_name: '白色' }))
      .mockResolvedValueOnce(reply({ variant_name: 'White' }))

    const out = await extractFromVoice('AAAA', 'audio/webm')
    expect(generateContent).toHaveBeenCalledTimes(2)
    expect(out.variant_name).toBe('White')
  })

  it('retries exactly once, never in a loop', async () => {
    // A model that will not comply must not burn a livestream's time or budget.
    generateContent
      .mockResolvedValueOnce(reply({ product_name: '陶瓷碗' }))
      .mockResolvedValueOnce(reply({ product_name: '陶瓷碗' }))

    const out = await extractFromVoice('AAAA', 'audio/webm')
    expect(generateContent).toHaveBeenCalledTimes(2)
    // Still Chinese — normaliseVoiceResult is what withholds it from the form.
    expect(out.product_name).toBe('陶瓷碗')
  })

  it('sends the audio on the retry, not just the correction', async () => {
    generateContent
      .mockResolvedValueOnce(reply({ product_name: '陶瓷碗' }))
      .mockResolvedValueOnce(reply({ product_name: 'Ceramic Bowl' }))

    await extractFromVoice('AUDIODATA', 'audio/mp4')
    const parts = generateContent.mock.calls[1]![0].contents[0].parts
    const audio = parts.find((p: { inlineData?: unknown }) => p.inlineData)
    expect(audio.inlineData).toEqual({ mimeType: 'audio/mp4', data: 'AUDIODATA' })
  })

  it('passes the browser mime type through, since iOS gives mp4 and Chrome webm', async () => {
    generateContent.mockResolvedValueOnce(reply({}))
    await extractFromVoice('AAAA', 'audio/mp4')
    const parts = generateContent.mock.calls[0]![0].contents[0].parts
    expect(parts.find((p: { inlineData?: { mimeType: string } }) => p.inlineData).inlineData.mimeType)
      .toBe('audio/mp4')
  })

  it('extracts at temperature zero — this is reading, not writing', async () => {
    generateContent.mockResolvedValueOnce(reply({}))
    await extractFromVoice('AAAA', 'audio/webm')
    expect(generateContent.mock.calls[0]![0].config.temperature).toBe(0)
  })

  it('reports unparseable JSON rather than returning a half-empty object', async () => {
    generateContent.mockResolvedValueOnce({ text: 'not json at all' })
    await expect(extractFromVoice('AAAA', 'audio/webm')).rejects.toThrow(/unparseable/)
  })

  it('reports an empty response rather than treating it as silence', async () => {
    // Silence has its own signal — `unintelligible` — and conflating the two
    // would tell the operator to speak up when the API had actually failed.
    generateContent.mockResolvedValueOnce({ text: '' })
    await expect(extractFromVoice('AAAA', 'audio/webm')).rejects.toThrow(/no content/)
  })

  it('does not retry a silent recording', async () => {
    generateContent.mockResolvedValueOnce(
      reply({ product_name: '', variant_name: '', price: '', stock: '', unintelligible: true }),
    )
    const out = await extractFromVoice('AAAA', 'audio/webm')
    expect(generateContent).toHaveBeenCalledTimes(1)
    expect(out.unintelligible).toBe(true)
  })
})
