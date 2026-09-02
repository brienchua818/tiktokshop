import { v2 as cloudinary } from 'cloudinary'

/**
 * Cloudinary archive.
 *
 * Not the delivery path to TikTok — they refuse external image URLs — but our
 * own record of every product photo, and the source of the small derivative
 * the vision model reads instead of the full-size image.
 */

let configured = false

function configure(): void {
  if (configured) return
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary credentials are not configured.')
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  })
  configured = true
}

export async function archiveToCloudinary(
  image: Buffer,
  publicId: string,
): Promise<{ secureUrl: string; thumbnailUrl: string }> {
  configure()

  const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { folder: 'tikshop', public_id: publicId, resource_type: 'image', overwrite: true },
        (error, uploaded) =>
          error || !uploaded
            ? reject(error ?? new Error('Cloudinary returned no result'))
            : resolve(uploaded as { secure_url: string; public_id: string }),
      )
      .end(image)
  })

  return {
    secureUrl: result.secure_url,
    // 800px is plenty for the model to identify a homeware product, and a
    // fraction of the tokens and latency of the full image.
    thumbnailUrl: cloudinary.url(result.public_id, {
      secure: true,
      transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
    }),
  }
}
