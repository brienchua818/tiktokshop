import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

/**
 * Encryption for TikTok app secrets and tokens at rest.
 *
 * The app this replaces shipped a static API token inside its public
 * JavaScript bundle, which is why anyone who found the URL could push products
 * to the live shops. Here, secrets never leave the server, and they are also
 * encrypted in the database so a leaked database dump is not immediately a
 * leaked set of shop credentials.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypted into
 * something wrong.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96 bits, the size GCM is specified for
const KEY_BYTES = 32

/**
 * Derive the 32-byte key from the configured secret. Accepts either 64 hex
 * characters (a real generated key) or an arbitrary passphrase, which is
 * hashed to length so a short value fails closed rather than throwing at a
 * random call site.
 */
function resolveKey(secret: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    return Buffer.from(secret, 'hex')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

let cachedKey: Buffer | undefined

/**
 * The encryption key, read once from the environment.
 *
 * Throws when unset. That is deliberate: a missing key must break the
 * function loudly at boot, not quietly fall back to storing tokens in clear.
 */
export function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey
  const secret = process.env.TOKEN_ENCRYPTION_KEY
  if (!secret || secret.length < 16) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is missing or too short. Generate one with: openssl rand -hex 32',
    )
  }
  cachedKey = resolveKey(secret)
  return cachedKey
}

/** Reset the cached key. Tests only — the environment does not change at runtime. */
export function resetKeyCache(): void {
  cachedKey = undefined
}

/**
 * Encrypt a secret for storage. Output is `iv.ciphertext.tag`, base64url per
 * part, so it is a single safe text column value.
 */
export function encryptSecret(plaintext: string, key: Buffer = encryptionKey()): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

/**
 * Decrypt a stored secret. Throws if the value was tampered with, truncated,
 * or encrypted under a different key — all of which must fail loudly rather
 * than return a plausible-looking wrong token.
 */
export function decryptSecret(stored: string, key: Buffer = encryptionKey()): string {
  const parts = stored.split('.')
  if (parts.length !== 3) {
    throw new Error('Stored secret is malformed: expected iv.ciphertext.tag')
  }
  const [ivPart, ciphertextPart, tagPart] = parts as [string, string, string]
  const iv = Buffer.from(ivPart, 'base64url')
  const ciphertext = Buffer.from(ciphertextPart, 'base64url')
  const tag = Buffer.from(tagPart, 'base64url')

  if (iv.length !== IV_BYTES) {
    throw new Error(`Stored secret has a ${iv.length}-byte IV, expected ${IV_BYTES}`)
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * TikTok returns token expiries as absolute epoch SECONDS. Reading one as a
 * duration is a silent, week-long bug: the shop simply stops working when the
 * access token lapses. Converting at the boundary means the stored column
 * cannot be misinterpreted later.
 */
export function epochSecondsToDate(epochSeconds: number): Date {
  return new Date(epochSeconds * 1000)
}

/**
 * True when a token should be refreshed. Refreshes early by default, because
 * discovering an expired token mid-livestream is the expensive case.
 */
export function needsRefresh(expiresAt: Date | null, now: Date = new Date(), marginHours = 24): boolean {
  if (!expiresAt) return true
  return expiresAt.getTime() - now.getTime() < marginHours * 60 * 60 * 1000
}
