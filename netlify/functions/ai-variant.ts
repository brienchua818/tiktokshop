import { withIdToken, json, methodNotAllowed } from '../lib/http'
import { generateVariantName, type InlineMediaType } from '../lib/ai-title'
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
export default withIdToken(async (request, _ctx, raw) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const body = raw as {
    image_base64?: string
    image_mime?: InlineMediaType
    image_url?: string
    product_name?: string
    hint?: string
  }
  // Inline bytes are the normal path: the photo lives on the device and in
  // Apps Script, and there is no public URL for it unless Cloudinary is
  // configured — which it does not have to be.
  const image = body.image_base64
    ? ({ kind: 'base64', mediaType: body.image_mime ?? 'image/jpeg', data: body.image_base64 } as const)
    : body.image_url
      ? ({ kind: 'url', url: body.image_url } as const)
      : null
  if (!image) return json({ error: 'A photo is required — send image_base64.' }, 400)

  const result = await generateVariantName({
    image,
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
