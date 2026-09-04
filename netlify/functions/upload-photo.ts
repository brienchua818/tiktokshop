import { withAuth, json, methodNotAllowed } from '../lib/http'
import { credentialsFor } from '../lib/credentials'
import { uploadProductImage } from '../lib/tiktok-images'
import { archiveToCloudinary } from '../lib/cloudinary'

/**
 * Photo in, TikTok image reference out.
 *
 * TikTok will not accept an external image URL — "You will not be able to use
 * any image URLs that are not hosted by TikTok Shop" — so every photo has to
 * pass through their upload endpoint to get a `uri`. Cloudinary is our own
 * archive and the source of the small derivative the vision model reads, not
 * the delivery path.
 */
export default withAuth(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed('POST')

  const form = await request.formData()
  const shopId = form.get('shop_id')
  const photo = form.get('photo')

  if (typeof shopId !== 'string') return json({ error: 'shop_id is required.' }, 400)
  if (!(photo instanceof File)) return json({ error: 'No photo was uploaded.' }, 400)
  if (photo.size === 0) return json({ error: 'The photo was empty.' }, 400)

  const bytes = Buffer.from(await photo.arrayBuffer())
  const creds = await credentialsFor(shopId)

  // TikTok first: without its uri nothing can be listed, so a Cloudinary
  // problem must not block the operator.
  const uploaded = await uploadProductImage(creds, bytes)

  let cloudinaryUrl: string | null = null
  let aiImageUrl = uploaded.url
  try {
    const archived = await archiveToCloudinary(bytes, `${shopId}/${Date.now()}`)
    cloudinaryUrl = archived.secureUrl
    // A resized derivative for the vision call: fewer tokens, and far quicker
    // over a factory connection.
    aiImageUrl = archived.thumbnailUrl
  } catch (error) {
    console.error('[tikshop] Cloudinary archive failed, continuing', error)
  }

  return json({
    tiktok_image_uri: uploaded.uri,
    cloudinary_url: cloudinaryUrl,
    ai_image_url: aiImageUrl,
  })
})
