import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/**
 * Signed OAuth state.
 *
 * The state parameter has to survive a round trip through TikTok and come back
 * telling us which shop started the flow. Signing it keeps that stateless — no
 * pending-authorisation row to write, expire and clean up — while still making
 * it unforgeable.
 *
 * With three shops this is not decoration. An unauthenticated callback could
 * otherwise file HOUZE's tokens against Painting Matters, and the mix-up would
 * only surface when a product appeared in the wrong shop.
 */

/** Five minutes: long enough to sign in, short enough to be useless if leaked. */
const STATE_TTL_SECONDS = 300

function secret(): string {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET is missing or too short.')
  }
  return value
}

export function signState(shopId: string, now: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ shop_id: shopId, nonce: randomBytes(8).toString('hex'), exp: Math.floor(now / 1000) + STATE_TTL_SECONDS }),
    'utf8',
  ).toString('base64url')
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/** Returns the shop id the flow was started for, or null if the state is not ours. */
export function verifyState(state: string | null, now: number = Date.now()): string | null {
  if (!state) return null
  const parts = state.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts as [string, string]

  const expected = createHmac('sha256', secret()).update(payload).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      shop_id?: string
      exp?: number
    }
    if (typeof decoded.exp !== 'number' || decoded.exp * 1000 < now) return null
    return decoded.shop_id ?? null
  } catch {
    return null
  }
}
