import { IMAGE_TARGET_PX, IMAGE_MIN_PX, IMAGE_MAX_PX } from '../lib/tiktok-rules'

/**
 * In-app photo capture.
 *
 * The photo is taken inside the app rather than picked from the gallery, which
 * means we control its size and format. That matters three times over:
 *
 *   - Netlify Functions cap request payloads at 6 MB and it cannot be raised.
 *     A raw phone photo can exceed that; a 1600px JPEG is a few hundred KB.
 *   - TikTok requires MAIN_IMAGE between 300x300 and 4000x4000.
 *   - Encoding to JPEG ourselves sidesteps iPhone HEIC entirely, so there is
 *     no format negotiation to get wrong on a factory floor.
 *
 * TikTok also auto-converts anything outside a 3:4 to 4:3 aspect ratio to 1:1,
 * so cropping square up front means what the operator sees is what gets
 * listed.
 */

export interface CropRect {
  sx: number
  sy: number
  size: number
  out: number
}

/**
 * Centre-square crop geometry for a source image.
 *
 * Pure so it can be tested without a canvas — the off-by-one that silently
 * shifts every product photo off centre is exactly the kind of thing that
 * needs a test rather than an eyeball.
 *
 * @param target desired output edge length in pixels
 */
export function squareCropRect(
  width: number,
  height: number,
  target: number = IMAGE_TARGET_PX,
): CropRect {
  if (width <= 0 || height <= 0) {
    throw new Error(`Cannot crop an image of ${width}x${height}`)
  }

  // The largest centred square that fits.
  const size = Math.min(width, height)
  const sx = Math.floor((width - size) / 2)
  const sy = Math.floor((height - size) / 2)

  // Never upscale: enlarging a small photo adds no detail and only inflates
  // the upload. Clamp into TikTok's accepted window.
  let out = Math.min(size, target)
  out = Math.min(out, IMAGE_MAX_PX)
  out = Math.max(out, Math.min(size, IMAGE_MIN_PX))

  return { sx, sy, size, out: Math.floor(out) }
}

/** True when the source is too small for TikTok to accept as a main image. */
export function isTooSmall(width: number, height: number): boolean {
  return Math.min(width, height) < IMAGE_MIN_PX
}

/**
 * Crop an image source to a centred square JPEG.
 *
 * Quality 0.82 is the same figure the previous app settled on, and it holds up:
 * product photos stay clean and files stay small enough to upload over a
 * factory connection.
 */
export async function toSquareJpeg(
  source: ImageBitmapSource,
  opts: { target?: number; quality?: number } = {},
): Promise<Blob> {
  const bitmap = await createImageBitmap(source)
  try {
    const { sx, sy, size, out } = squareCropRect(bitmap.width, bitmap.height, opts.target)

    const canvas = document.createElement('canvas')
    canvas.width = out
    canvas.height = out
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D canvas context.')

    // Better downscaling than the default, which matters because the AI reads
    // this image to write the title.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, out, out)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode the photo as JPEG.'))),
        'image/jpeg',
        opts.quality ?? 0.82,
      )
    })
  } finally {
    bitmap.close()
  }
}

/**
 * Open the rear camera.
 *
 * `environment` rather than `user`: the product is in front of the person, not
 * behind them. Falls back to any camera if the device has only one.
 */
export async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This device or browser does not support in-app camera capture.')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1920 },
      },
      audio: false,
    })
  } catch (cause) {
    throw new Error(describeMediaError(cause, 'camera'))
  }
}

/**
 * Wait until a video element actually has a frame to read.
 *
 * `play()` resolving does not mean there are pixels. On iOS the dimensions
 * arrive with `loadedmetadata`, which can be a few hundred milliseconds after
 * the element is attached — so anyone quick enough to tap the shutter straight
 * away used to get "The camera is not ready yet." and a black square.
 */
export function waitForFrame(video: HTMLVideoElement, timeoutMs = 5000): Promise<void> {
  if (video.videoWidth && video.videoHeight) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', check)
      video.removeEventListener('loadeddata', check)
      video.removeEventListener('canplay', check)
    }
    function check() {
      if (!video.videoWidth || !video.videoHeight) return
      done()
      resolve()
    }
    // Which of these fires first differs between browsers, so all three are
    // listened for and the check is idempotent.
    video.addEventListener('loadedmetadata', check)
    video.addEventListener('loadeddata', check)
    video.addEventListener('canplay', check)

    const timer = setTimeout(() => {
      done()
      reject(new Error('The camera did not start. Close any other app using it, then try again.'))
    }, timeoutMs)

    check()
  })
}

/** Grab a still from a live video element and encode it. */
export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  // Waits rather than refusing. Being half a second early is not a mistake
  // worth making someone repeat mid-broadcast.
  await waitForFrame(video)
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get a 2D canvas context.')
  ctx.drawImage(video, 0, 0)
  return toSquareJpeg(canvas)
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop())
}

/**
 * Turn a getUserMedia rejection into something a person can act on.
 *
 * A bare "NotAllowedError" in the middle of a livestream tells the operator
 * nothing about what to do next.
 */
export function describeMediaError(cause: unknown, device: 'camera' | 'microphone'): string {
  const name = (cause as { name?: string } | null)?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // Naming the exact menu matters more than usual here, because iOS grants
      // this per browsing session by default: the permission is not broken,
      // it has simply lapsed again, and "allow it in site settings" does not
      // say how to stop being asked tomorrow.
      return (
        `${device === 'camera' ? 'Camera' : 'Microphone'} access was blocked. ` +
        'On iPhone: tap "ᴀA" in the address bar → Website Settings → ' +
        `${device === 'camera' ? 'Camera' : 'Microphone'} → Allow. ` +
        'To stop being asked every time, add this app to your Home Screen ' +
        '(Share → Add to Home Screen) and open it from there.'
      )
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${device} was found on this device.`
    case 'NotReadableError':
      return `The ${device} is already in use by another app. Close the other app and try again.`
    default:
      return `Could not start the ${device}: ${(cause as Error)?.message || name || 'unknown error'}`
  }
}
