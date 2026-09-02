import { withAuth, json, methodNotAllowed } from '../lib/http'
import { generateTitle } from '../lib/ai-title'
import { validateTitle } from '../../src/lib/tiktok-rules'

/**
 * Photo to English product title, at least 25 characters.
 *
 * The validation result is returned alongside the title rather than being
 * hidden: if the model could not reach 25 characters even after its retry, the
 * UI needs to say so and let the operator finish it, not fail silently.
 */
export default withAuth(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const body = (await request.json()) as { image_url?: string; hint?: string }
  if (!body.image_url) return json({ error: 'image_url is required.' }, 400)

  const result = await generateTitle({
    imageUrl: body.image_url,
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
