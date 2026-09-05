import { withIdToken, json, methodNotAllowed } from '../lib/http'
import { generateTitle, type InlineMediaType } from '../lib/ai-title'
import { validateTitle } from '../../src/lib/tiktok-rules'

/**
 * Photo to English product title, at least 25 characters.
 *
 * The validation result is returned alongside the title rather than being
 * hidden: if the model could not reach 25 characters even after its retry, the
 * UI needs to say so and let the operator finish it, not fail silently.
 */
export default withIdToken(async (request, _ctx, raw) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const body = raw as {
    image_base64?: string
    image_mime?: InlineMediaType
    image_url?: string
    hint?: string
  }
  const image = body.image_base64
    ? ({ kind: 'base64', mediaType: body.image_mime ?? 'image/jpeg', data: body.image_base64 } as const)
    : body.image_url
      ? ({ kind: 'url', url: body.image_url } as const)
      : null
  if (!image) return json({ error: 'A photo is required — send image_base64.' }, 400)

  const result = await generateTitle({
    image,
    ...(body.hint ? { hint: body.hint } : {}),
  })

  const problems = validateTitle(result.title)

  return json({
    title: result.title,
    variant_name: result.variant_name || null,
    material: result.material || null,
    dimensions:
      result.dimensions_visible && result.length_cm && result.width_cm && result.height_cm
        ? { length: result.length_cm, width: result.width_cm, height: result.height_cm }
        : null,
    // Empty when the title is good to go.
    problems: problems.map((p) => p.message),
  })
})
