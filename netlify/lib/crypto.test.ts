import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  encryptSecret,
  decryptSecret,
  encryptionKey,
  resetKeyCache,
  epochSecondsToDate,
  needsRefresh,
} from './crypto'

const KEY = randomBytes(32)

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a token', () => {
    const token = 'ROW_xkMbgAAAeVAQra0eZWebFQq5aIK'
    expect(decryptSecret(encryptSecret(token, KEY), KEY)).toBe(token)
  })

  it('round-trips unicode and long values', () => {
    const value = 'refresh_' + 'x'.repeat(2000) + '_✓'
    expect(decryptSecret(encryptSecret(value, KEY), KEY)).toBe(value)
  })

  it('produces different ciphertext each time, so equal secrets are not detectable', () => {
    const a = encryptSecret('same-token', KEY)
    const b = encryptSecret('same-token', KEY)
    expect(a).not.toBe(b)
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY))
  })

  it('never leaves the plaintext visible in the stored value', () => {
    const stored = encryptSecret('super-secret-app-key', KEY)
    expect(stored).not.toContain('super-secret-app-key')
  })

  it('rejects a tampered ciphertext rather than returning wrong plaintext', () => {
    const stored = encryptSecret('token', KEY)
    const [iv, ciphertext, tag] = stored.split('.') as [string, string, string]
    // Flip a byte in the ciphertext.
    const bytes = Buffer.from(ciphertext, 'base64url')
    bytes[0] = bytes[0]! ^ 0xff
    const tampered = [iv, bytes.toString('base64url'), tag].join('.')
    expect(() => decryptSecret(tampered, KEY)).toThrow()
  })

  it('rejects a tampered auth tag', () => {
    const stored = encryptSecret('token', KEY)
    const [iv, ciphertext] = stored.split('.') as [string, string]
    const tampered = [iv, ciphertext, randomBytes(16).toString('base64url')].join('.')
    expect(() => decryptSecret(tampered, KEY)).toThrow()
  })

  it('rejects decryption under a different key', () => {
    const stored = encryptSecret('token', KEY)
    expect(() => decryptSecret(stored, randomBytes(32))).toThrow()
  })

  it('rejects a malformed stored value', () => {
    expect(() => decryptSecret('not-a-valid-blob', KEY)).toThrow(/malformed/)
    expect(() => decryptSecret('only.two', KEY)).toThrow(/malformed/)
  })

  it('rejects a key of the wrong length', () => {
    expect(() => encryptSecret('token', randomBytes(16))).toThrow(/32 bytes/)
  })
})

describe('encryptionKey', () => {
  const original = process.env.TOKEN_ENCRYPTION_KEY

  beforeEach(() => resetKeyCache())
  afterEach(() => {
    if (original === undefined) delete process.env.TOKEN_ENCRYPTION_KEY
    else process.env.TOKEN_ENCRYPTION_KEY = original
    resetKeyCache()
  })

  it('throws when unset, rather than silently storing tokens in clear', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(() => encryptionKey()).toThrow(/TOKEN_ENCRYPTION_KEY is missing/)
  })

  it('throws on a too-short key', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'short'
    expect(() => encryptionKey()).toThrow(/missing or too short/)
  })

  it('accepts 64 hex characters as a raw 32-byte key', () => {
    const hex = randomBytes(32).toString('hex')
    process.env.TOKEN_ENCRYPTION_KEY = hex
    expect(encryptionKey().toString('hex')).toBe(hex)
  })

  it('hashes a passphrase to 32 bytes so length is never wrong', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'a-long-enough-passphrase-value'
    expect(encryptionKey()).toHaveLength(32)
  })
})

describe('epochSecondsToDate', () => {
  it('reads TikTok expiries as absolute seconds, not durations', () => {
    // 1 700 000 000 seconds is Nov 2023. Read as milliseconds it would be 1970.
    const d = epochSecondsToDate(1_700_000_000)
    expect(d.getUTCFullYear()).toBe(2023)
  })
})

describe('needsRefresh', () => {
  const now = new Date('2026-09-02T00:00:00Z')

  it('refreshes when there is no expiry recorded', () => {
    expect(needsRefresh(null, now)).toBe(true)
  })

  it('refreshes early rather than discovering expiry mid-livestream', () => {
    const inTwelveHours = new Date('2026-09-02T12:00:00Z')
    expect(needsRefresh(inTwelveHours, now)).toBe(true)
  })

  it('leaves a token alone while it has comfortable life left', () => {
    const inSixDays = new Date('2026-09-08T00:00:00Z')
    expect(needsRefresh(inSixDays, now)).toBe(false)
  })

  it('treats an already-expired token as needing refresh', () => {
    expect(needsRefresh(new Date('2026-09-01T00:00:00Z'), now)).toBe(true)
  })
})
