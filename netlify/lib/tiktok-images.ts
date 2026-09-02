import { sign, timestampSeconds, API_HOST } from './tiktok-sign'

/**
 * Upload a product image to TikTok.
 *
 * This endpoint is multipart, which changes two things about signing: the body
 * is excluded from the signature, and it takes no `shop_cipher`. Both are easy
 * to get wrong by copying the JSON call pattern.
 */
export async function uploadProductImage(
  creds: { appKey: string; appSecret: string; accessToken: string },
  image: Buffer,
  useCase: 'MAIN_IMAGE' | 'ATTRIBUTE_IMAGE' = 'MAIN_IMAGE',
): Promise<{ uri: string; url: string; width: number; height: number }> {
  const path = '/product/202309/images/upload'
  const query = { app_key: creds.appKey, timestamp: timestampSeconds() }

  const signature = sign({
    path,
    query,
    // Multipart: the body is deliberately not part of the signature.
    isMultipart: true,
    appSecret: creds.appSecret,
  })

  const url = new URL(`${API_HOST}${path}`)
  url.searchParams.set('app_key', String(query.app_key))
  url.searchParams.set('timestamp', String(query.timestamp))
  url.searchParams.set('sign', signature)

  const form = new FormData()
  form.append('data', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'product.jpg')
  form.append('use_case', useCase)

  const response = await fetch(url, {
    method: 'POST',
    // Content-Type is deliberately unset: fetch adds it with the multipart
    // boundary, and setting it by hand produces a malformed request.
    headers: { 'x-tts-access-token': creds.accessToken },
    body: form,
  })

  const text = await response.text()
  let payload: { code: number; message: string; data?: { uri: string; url: string; width: number; height: number } }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    throw new Error(`TikTok image upload returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }

  if (payload.code !== 0 || !payload.data?.uri) {
    throw new Error(`TikTok rejected the image (${payload.code}): ${payload.message}`)
  }
  return payload.data
}
