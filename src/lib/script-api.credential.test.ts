import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The sign-in must not depend on the body arriving.
 *
 * Brien, Painting Matters, 16 Sep: a pushSku stuck on "reached the backend
 * without its sign-in, and is too large to retry another way". The backend
 * answers NO_TOKEN only when neither credential field reached it, and the
 * credential lived in the POST body — so the body did not arrive intact.
 *
 * Every other action recovers by retrying as a GET with everything in the
 * query. pushSku cannot: it carries a base64 photo, so it does not fit in a
 * URL and the retry never runs. It is also the only action whose body is big
 * enough to be at risk, which is why it is the only one that got stuck.
 */
const BASE = 'https://script.google.com/macros/s/AAA/exec'

const TOKEN = 'header.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig'

async function loadApi() {
  vi.resetModules()
  vi.stubEnv('VITE_APPS_SCRIPT_URL', BASE)
  const mod = await import('./script-api')
  mod.setIdToken(TOKEN)
  return mod
}

function ok(body: Record<string, unknown> = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200 })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function urlOf(call: number): URL {
  return new URL(String(fetchMock.mock.calls[call]![0]))
}

function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[call]![1] as RequestInit).body))
}

describe('the credential rides in the URL as well as the body', () => {
  it('puts the session token in the query of a POST', async () => {
    const api = await loadApi()
    
    await api.call('pushSku', { body: { image_base64: 'x'.repeat(50_000) }, timeoutMs: 1000 })

    const url = urlOf(0)
    expect(url.searchParams.get('action')).toBe('pushSku')
    expect(url.searchParams.get('id_token')).toBe(TOKEN)
  })

  it('still puts it in the body, so nothing that worked stops working', async () => {
    const api = await loadApi()
    
    await api.call('pushSku', { body: { identifier: 'A1' }, timeoutMs: 1000 })

    expect(bodyOf(0).id_token).toBe(TOKEN)
    expect(bodyOf(0).identifier).toBe('A1')
  })

  /**
   * The photo must never reach the URL.
   *
   * Only the credential is lifted out. Putting the payload there would exceed
   * what Apps Script accepts in a query string and fail every push instead of
   * fixing one.
   */
  it('lifts the credential only, never the payload', async () => {
    const api = await loadApi()
    
    const photo = 'y'.repeat(50_000)
    await api.call('pushSku', { body: { image_base64: photo, price: '99' }, timeoutMs: 1000 })

    const url = urlOf(0)
    expect(url.searchParams.get('image_base64')).toBeNull()
    expect(url.searchParams.get('price')).toBeNull()
    expect(url.toString().length).toBeLessThan(2000)
    expect(bodyOf(0).image_base64).toBe(photo)
  })

  it('sends no credential at all when the call is anonymous', async () => {
    const api = await loadApi()
    
    await api.call('ping', { anonymous: true, timeoutMs: 1000 })

    expect(urlOf(0).searchParams.get('session_token')).toBeNull()
    expect(urlOf(0).searchParams.get('id_token')).toBeNull()
  })

  /**
   * The failure exactly as it was photographed.
   *
   * A backend that reads the credential ONLY from the query — which is what a
   * dropped body looks like from the outside — now succeeds where it used to
   * come back NO_TOKEN with no retry available.
   */
  it('a push whose body is dropped now succeeds on the URL credential', async () => {
    const api = await loadApi()
    
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input))
      // The body never arrives. Only the query is readable.
      if (!url.searchParams.get('session_token') && !url.searchParams.get('id_token')) {
        return ok({ _status: 401, error: 'Sign in with Google to continue.', code: 'NO_TOKEN' })
      }
      return ok({ ok: true, product_id: '123' })
    })

    const out = await api.call<{ product_id: string }>(
      'pushSku', { body: { image_base64: 'z'.repeat(50_000) }, timeoutMs: 1000 },
    )
    expect(out.product_id).toBe('123')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
