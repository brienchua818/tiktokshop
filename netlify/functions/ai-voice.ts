import { withAuth, json, methodNotAllowed } from '../lib/http'
import { extractFromVoice, normaliseVoiceResult } from '../lib/ai-voice'

/**
 * Recording to product fields.
 *
 * Accepts English, Mandarin or the two mixed, and returns English — TikTok
 * rejects Chinese characters in product names, so this step translates rather
 * than transcribes.
 */
export default withAuth(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const form = await request.formData()
  const audio = form.get('audio')
  if (!(audio instanceof File)) return json({ error: 'No audio was uploaded.' }, 400)
  if (audio.size === 0) return json({ error: 'The recording was empty.' }, 400)

  const base64 = Buffer.from(await audio.arrayBuffer()).toString('base64')
  // MediaRecorder gives webm on Chrome and mp4 on iOS Safari; Gemini takes
  // both, so the browser's own type is passed straight through.
  const result = await extractFromVoice(base64, audio.type || 'audio/webm')

  const fields = normaliseVoiceResult(result)

  return json({
    title: fields.name ?? null,
    variant_name: fields.variant ?? null,
    price: fields.price ?? null,
    stock: fields.stock ?? null,
    // Echoed back so a mishearing is visible to the operator rather than
    // silently written into a listing.
    transcript_english: result.transcript_english,
    unintelligible: result.unintelligible,
    // Set when a text field could not be rendered in English even after a
    // corrective retry. The numbers still came through, so this is a partial
    // success and must not read as a failure — the operator types the name and
    // keeps the price and quantity they just spoke.
    dropped: fields.dropped ?? null,
  })
})
