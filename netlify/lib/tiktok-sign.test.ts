import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  buildSignatureBase,
  sign,
  timestampSeconds,
  buildSignedRequest,
} from './tiktok-sign'

/**
 * A wrong signature surfaces from TikTok as an opaque auth failure with no clue
 * which of the six steps went wrong, so the intermediate string is asserted
 * directly. These tests are the difference between a ten-minute fix and an
 * afternoon of guessing.
 */

const SECRET = 'test_app_secret'

describe('buildSignatureBase', () => {
  it('prepends the path, sorts keys, and uses no separators', () => {
    const base = buildSignatureBase({
      path: '/authorization/202309/shops',
      query: { timestamp: 1_700_000_000, app_key: 'abc123' },
      appSecret: SECRET,
    })
    // Alphabetical: app_key before timestamp. Concatenated key+value, no "=" or "&".
    expect(base).toBe(
      `${SECRET}/authorization/202309/shopsapp_keyabc123timestamp1700000000${SECRET}`,
    )
  })

  it('excludes sign and access_token from the signed set', () => {
    const withExtras = buildSignatureBase({
      path: '/product/202309/products',
      query: {
        app_key: 'k',
        timestamp: 1,
        sign: 'should-be-ignored',
        access_token: 'should-also-be-ignored',
      },
      appSecret: SECRET,
    })
    const withoutExtras = buildSignatureBase({
      path: '/product/202309/products',
      query: { app_key: 'k', timestamp: 1 },
      appSecret: SECRET,
    })
    expect(withExtras).toBe(withoutExtras)
  })

  it('appends the raw JSON body for a normal request', () => {
    const body = '{"listing_id":"123"}'
    const base = buildSignatureBase({
      path: '/product/202309/products',
      query: { app_key: 'k', timestamp: 1 },
      body,
      appSecret: SECRET,
    })
    expect(base).toBe(`${SECRET}/product/202309/productsapp_keyktimestamp1${body}${SECRET}`)
  })

  it('omits the body for a multipart upload', () => {
    const base = buildSignatureBase({
      path: '/product/202309/images/upload',
      query: { app_key: 'k', timestamp: 1 },
      body: 'binary-ish-payload',
      isMultipart: true,
      appSecret: SECRET,
    })
    expect(base).toBe(`${SECRET}/product/202309/images/uploadapp_keyktimestamp1${SECRET}`)
  })

  it('drops undefined values rather than signing the string "undefined"', () => {
    const base = buildSignatureBase({
      path: '/p',
      query: { app_key: 'k', shop_cipher: undefined, timestamp: 1 },
      appSecret: SECRET,
    })
    expect(base).not.toContain('undefined')
    expect(base).toBe(`${SECRET}/papp_keyktimestamp1${SECRET}`)
  })

  it('includes shop_cipher when present, in sorted position', () => {
    const base = buildSignatureBase({
      path: '/p',
      query: { timestamp: 2, app_key: 'k', shop_cipher: 'ROW_abc' },
      appSecret: SECRET,
    })
    // app_key, shop_cipher, timestamp
    expect(base).toBe(`${SECRET}/papp_keykshop_cipherROW_abctimestamp2${SECRET}`)
  })

  it('sorts case-sensitively, so uppercase keys precede lowercase', () => {
    const base = buildSignatureBase({
      path: '/p',
      query: { b: '1', A: '2' },
      appSecret: SECRET,
    })
    expect(base).toBe(`${SECRET}/pA2b1${SECRET}`)
  })
})

describe('sign', () => {
  it('produces a lowercase hex HMAC-SHA256 keyed by the app secret', () => {
    const input = {
      path: '/authorization/202309/shops',
      query: { app_key: 'abc123', timestamp: 1_700_000_000 },
      appSecret: SECRET,
    }
    const expected = createHmac('sha256', SECRET)
      .update(buildSignatureBase(input), 'utf8')
      .digest('hex')

    const actual = sign(input)
    expect(actual).toBe(expected)
    expect(actual).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when any signed parameter changes', () => {
    const a = sign({ path: '/p', query: { app_key: 'k', timestamp: 1 }, appSecret: SECRET })
    const b = sign({ path: '/p', query: { app_key: 'k', timestamp: 2 }, appSecret: SECRET })
    expect(a).not.toBe(b)
  })

  it('changes when the path changes, proving the path is signed', () => {
    const a = sign({ path: '/one', query: { app_key: 'k' }, appSecret: SECRET })
    const b = sign({ path: '/two', query: { app_key: 'k' }, appSecret: SECRET })
    expect(a).not.toBe(b)
  })
})

describe('timestampSeconds', () => {
  it('returns seconds, not milliseconds', () => {
    expect(timestampSeconds(1_700_000_000_500)).toBe(1_700_000_000)
    // Ten digits for any plausible current date — TikTok rejects millisecond values.
    expect(String(timestampSeconds(Date.now()))).toHaveLength(10)
  })
})

describe('buildSignedRequest', () => {
  const common = {
    appKey: 'abc123',
    appSecret: SECRET,
    accessToken: 'tok_live',
    now: 1_700_000_000_000,
  }

  it('sends the access token as a header, never in the query string', () => {
    const req = buildSignedRequest({
      ...common,
      path: '/authorization/202309/shops',
      method: 'GET',
    })
    expect(req.headers['x-tts-access-token']).toBe('tok_live')
    expect(req.url).not.toContain('access_token')
    expect(req.url).not.toContain('tok_live')
  })

  it('never puts the app secret in the URL', () => {
    const req = buildSignedRequest({
      ...common,
      path: '/product/202309/products',
      method: 'POST',
      json: { title: 'x' },
    })
    expect(req.url).not.toContain(SECRET)
  })

  it('signs the exact body bytes it sends', () => {
    const req = buildSignedRequest({
      ...common,
      path: '/product/202309/products',
      method: 'POST',
      json: { title: 'Ceramic Serving Bowl 20x20x8cm', stock: 12 },
    })
    const url = new URL(req.url)
    const expected = sign({
      path: '/product/202309/products',
      query: { app_key: 'abc123', timestamp: 1_700_000_000 },
      body: req.body,
      appSecret: SECRET,
    })
    expect(url.searchParams.get('sign')).toBe(expected)
  })

  it('includes shop_cipher in both the URL and the signature', () => {
    const req = buildSignedRequest({
      ...common,
      path: '/product/202309/products',
      method: 'POST',
      shopCipher: 'ROW_houze',
      json: {},
    })
    const url = new URL(req.url)
    expect(url.searchParams.get('shop_cipher')).toBe('ROW_houze')
    expect(url.searchParams.get('sign')).toBe(
      sign({
        path: '/product/202309/products',
        query: { app_key: 'abc123', timestamp: 1_700_000_000, shop_cipher: 'ROW_houze' },
        body: req.body,
        appSecret: SECRET,
      }),
    )
  })

  it('omits the content-type header on multipart requests', () => {
    const req = buildSignedRequest({
      ...common,
      path: '/product/202309/images/upload',
      method: 'POST',
      isMultipart: true,
      json: { ignored: true },
    })
    expect(req.headers['content-type']).toBeUndefined()
  })
})
