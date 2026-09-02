import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  call,
  serialise,
  backoffMs,
  TikTokApiError,
  LISTING_LIMIT_CODE,
} from './tiktok-api'

const creds = {
  appKey: 'key',
  appSecret: 'secret',
  accessToken: 'tok',
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers })
}

afterEach(() => vi.unstubAllGlobals())

describe('call', () => {
  it('returns data on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 0, message: 'Success', data: { shops: [] } })),
    )
    await expect(call({ ...creds, path: '/authorization/202309/shops', method: 'GET' })).resolves.toEqual({
      shops: [],
    })
  })

  it('treats a non-zero code as a failure even on HTTP 200', async () => {
    // This is the trap: response.ok is true, but the listing was rejected.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 12052181, message: 'The package weight of the product can not be zero.', data: {} }),
      ),
    )
    await expect(
      call({ ...creds, path: '/product/202309/products', method: 'POST', json: {} }),
    ).rejects.toThrow(/12052181/)
  })

  it('surfaces TikTok’s own message, so the user sees the real reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 12052535, message: "You haven't set the return warehouse", data: {} }),
      ),
    )
    await expect(
      call({ ...creds, path: '/product/202309/products', method: 'POST', json: {} }),
    ).rejects.toThrow(/return warehouse/)
  })

  it('does not retry a rejected listing, which would waste daily allowance', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ code: 12052104, message: 'property is required', data: {} }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      call({ ...creds, path: '/product/202309/products', method: 'POST', json: {} }),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a throttled call and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 36009002, message: 'too many requests', data: {} }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, message: 'Success', data: { ok: true } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      call({ ...creds, path: '/product/202309/products', method: 'POST', json: {}, maxAttempts: 3 }),
    ).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a network drop, which is what factory Wi-Fi produces', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ code: 0, message: 'Success', data: { ok: 1 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      call({ ...creds, path: '/p', method: 'GET', maxAttempts: 2 }),
    ).resolves.toEqual({ ok: 1 })
  })

  it('gives up after maxAttempts on persistent throttling', async () => {
    // A fresh Response per call: a body can only be read once, so reusing one
    // object would fail with "Body has already been read" rather than testing
    // the retry path.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ code: 36009002, message: 'throttled', data: {} }, 429, {
          'retry-after': '1',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      call({ ...creds, path: '/p', method: 'GET', maxAttempts: 2 }),
    ).rejects.toThrow(/36009002/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('re-signs on every attempt, since the signature covers the timestamp', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 36009002, message: 'throttled', data: {} }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, message: 'ok', data: {} }))
    vi.stubGlobal('fetch', fetchMock)

    await call({ ...creds, path: '/p', method: 'GET', maxAttempts: 2 })

    const firstUrl = fetchMock.mock.calls[0]![0] as string
    const secondUrl = fetchMock.mock.calls[1]![0] as string
    expect(new URL(firstUrl).searchParams.get('sign')).toBeTruthy()
    expect(new URL(secondUrl).searchParams.get('sign')).toBeTruthy()
  })

  it('reports a non-JSON body instead of a JSON parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>gateway timeout</html>', { status: 504 })),
    )
    await expect(call({ ...creds, path: '/p', method: 'GET', maxAttempts: 1 })).rejects.toThrow(
      /Non-JSON response/,
    )
  })

  it('never leaks the app secret into the request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0, message: 'ok', data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    await call({ ...creds, path: '/p', method: 'GET' })
    expect(fetchMock.mock.calls[0]![0] as string).not.toContain('secret')
  })
})

describe('TikTokApiError', () => {
  it('flags the daily listing cap distinctly, so the UI can explain it', () => {
    const err = new TikTokApiError(LISTING_LIMIT_CODE, 'limit reached', 200)
    expect(err.isDailyLimit).toBe(true)
    expect(err.isRetryable).toBe(false)
  })

  it('treats 5xx as retryable and a validation failure as not', () => {
    expect(new TikTokApiError(-1, 'boom', 503).isRetryable).toBe(true)
    expect(new TikTokApiError(12052181, 'weight zero', 200).isRetryable).toBe(false)
  })
})

describe('backoffMs', () => {
  it('honours Retry-After when present', () => {
    expect(backoffMs(1, '5')).toBe(5000)
  })

  it('caps Retry-After at a minute', () => {
    expect(backoffMs(1, '9999')).toBe(60_000)
  })

  it('grows exponentially and stays bounded', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(1000)
    expect(backoffMs(1)).toBeLessThan(1600)
    expect(backoffMs(3)).toBeGreaterThanOrEqual(4000)
    expect(backoffMs(20)).toBeLessThanOrEqual(30_500)
  })

  it('ignores a non-numeric Retry-After', () => {
    expect(backoffMs(1, 'later')).toBeGreaterThanOrEqual(1000)
  })
})

describe('serialise', () => {
  it('runs tasks one at a time, never concurrently', async () => {
    let active = 0
    let maxActive = 0
    const task = () => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
      return 'done'
    }
    await serialise([task(), task(), task()], 0)
    expect(maxActive).toBe(1)
  })

  it('keeps going after one task fails, so a bad SKU does not abandon the queue', async () => {
    const results = await serialise(
      [
        async () => 'first',
        async () => {
          throw new Error('rejected by TikTok')
        },
        async () => 'third',
      ],
      0,
    )
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(results[2]).toMatchObject({ value: 'third' })
  })

  it('preserves task order in the results', async () => {
    const results = await serialise(
      [async () => 1, async () => 2, async () => 3],
      0,
    )
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([1, 2, 3])
  })
})
