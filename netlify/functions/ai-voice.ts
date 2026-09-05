import { withIdToken, json, methodNotAllowed } from '../lib/http'
import { extractFromVoice, normaliseVoiceResult } from '../lib/ai-voice'

/**
 * Recording to product fields.
 *
 * Accepts English, Mandarin or the two mixed, and returns English — TikTok
 * rejects Chinese characters in product names, so this step translates rather
 * than transcribes.
 */
export default withIdToken(async (request, _ctx, raw) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  // JSON with base64 rather than multipart, so the recording and the ID token
  // travel together — a multipart body cannot carry the token without either a
  // custom header or a second field the CORS rules would complicate.
  const body = raw as { audio_base64?: string; audio_mime?: string }
  if (!body.audio_base64) return json({ error: 'No audio was uploaded.' }, 400)

  // MediaRecorder gives webm on Chrome and mp4 on iOS Safari; Gemini takes
  // both, so the browser's own type is passed straight through.
  const result = await extractFromVoice(body.audio_base64, body.audio_mime || 'audio/webm')

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
