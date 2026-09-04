import { withAuth, json, methodNotAllowed } from '../lib/http'
import { generateVariantName } from '../lib/ai-title'
import { validateVariantName } from '../../src/lib/tiktok-rules'

/**
 * Photo to variant name.
 *
 * This is the hot path during a broadcast, and it is deliberately a different
 * endpoint from `ai-title`. A stream is one TikTok product and every SKU is a
 * variation of it, so what each photo needs is the short phrase that
 * distinguishes THIS piece — the product title belongs to the listing and is
 * set once.
 *
 * The validation result is returned alongside the name rather than hidden: if
 * the model could not produce a usable one even after its retry, the UI needs
 * to say so and let the operator type it, not fail silently mid-stream.
 */
export default withAuth(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const body = (await request.json()) as {
    image_url?: string
    product_name?: string
    hint?: string
  }
  if (!body.image_url) return json({ error: 'image_url is required.' }, 400)

  const result = await generateVariantName({
    imageUrl: body.image_url,
    // The listing's own name, so the answer distinguishes rather than repeats.
    ...(body.product_name ? { productName: body.product_name } : {}),
    ...(body.hint ? { hint: body.hint } : {}),
  })

  const problems = validateVariantName(result.variant_name)

  return json({
    variant_name: result.variant_name,
    material: result.material || null,
    // Empty when the name is good to go.
    problems: problems.map((p) => p.message),
  })
})
