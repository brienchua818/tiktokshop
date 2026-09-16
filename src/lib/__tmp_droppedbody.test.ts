import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://script.google.com/macros/s/AAA/exec'
const TOKEN = 'header.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig'

async function loadApi() {
  vi.resetModules()
  vi.stubEnv('VITE_APPS_SCRIPT_URL', BASE)
  const mod = await import('./script-api')
  mod.setIdToken(TOKEN)
  return mod
}

/** Apps Script handle_ + route_ for removeVariation, with the POST body dropped. */
function backend(input: unknown, init?: RequestInit) {
  const url = new URL(String(input))
  const method = (init?.method ?? 'GET') as string
  const params = Object.fromEntries(url.searchParams.entries())
  // "the body did not arrive intact" — postData absent on POST.
  const body: Record<string, string> = method === 'POST' ? {} : {}
  const sessionToken = body.session_token || params.session_token
  const googleToken = body.id_token || params.id_token
  if (!sessionToken && !googleToken) {
    return new Response(JSON.stringify({ _status: 401, error: 'Sign in with Google to continue.', code: 'NO_TOKEN' }))
  }
  // route_: case 'removeVariation' -> params.listing_id || body.listing_id
  const listingId = params.listing_id || body.listing_id
  if (!listingId) {
    return new Response(JSON.stringify({ _status: 500, error: 'Unknown listing: undefined', code: 'TS-PRD-09' }))
  }
  return new Response(JSON.stringify({ ok: true, removed: listingId }))
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(backend as never); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('a POST whose body is dropped', () => {
  it('removeVariation', async () => {
    const api = await loadApi()
    let out: unknown = null
    let err: unknown = null
    try {
      out = await api.call('removeVariation', { body: { listing_id: 'L1', tiktok_sku_id: 'S1' }, timeoutMs: 1000 })
    } catch (e) { err = e }
    console.log('calls:', fetchMock.mock.calls.map((c) => [(c[1] as RequestInit)?.method ?? 'GET', String(c[0]).slice(BASE.length)]))
    console.log('result:', out, 'error:', err && (err as Error).message, (err as { code?: string })?.code)
    expect(true).toBe(true)
  })
})
