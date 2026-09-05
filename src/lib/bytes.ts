/**
 * Blob to base64, for the calls that carry bytes inside JSON.
 *
 * Photos and recordings both travel as base64 now rather than as multipart
 * form data, because every request also carries a Google ID token — and a
 * multipart body cannot carry it without either a custom header, which
 * triggers a CORS preflight the Apps Script backend will not answer, or a
 * second form field, which is one more thing for the two clients to disagree
 * about.
 *
 * The cost is roughly a third more bytes on the wire. For a 400 KB square
 * JPEG that is about 130 KB, which is worth paying once to have one auth
 * convention everywhere.
 */

/**
 * Encode a blob as base64, without the `data:` prefix.
 *
 * Uses FileReader rather than reading into a string by hand: a photo is
 * megabytes, and `String.fromCharCode(...bytes)` on an array that size
 * overflows the call stack on some browsers — a failure that only appears
 * with large images, which is to say only in the field.
 */
export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Could not read the file.'))
        return
      }
      // "data:image/jpeg;base64,AAAA..." — everything after the comma.
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error('Could not read the file from this device.'))
    reader.readAsDataURL(blob)
  })
}

/**
 * How large a blob will be once base64-encoded.
 *
 * Used to refuse an oversized push before spending a minute uploading it on
 * factory Wi-Fi only to be rejected at the far end.
 */
export function base64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}
