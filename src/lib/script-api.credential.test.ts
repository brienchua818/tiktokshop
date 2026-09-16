import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * A dropped POST body must stay recoverable.
 *
 * Brien, Painting Matters, 16 Sep: a pushSku stuck on "reached the backend
 * without its sign-in, and is too large to retry another way". The backend
 * answers NO_TOKEN only when neither credential field reached it, so the body
 * did not arrive.
 *
 * The first attempt at a fix lifted the credential into the query string on
 * every POST. That was a REGRESSION and these tests exist mostly to stop it
 * coming back. The credential and the arguments travel in the same body, so a
 * transport that drops one drops both; putting the credential in the URL only
 * makes a body-less request authenticate and then run with every argument
 * undefined. The reply stops being NO_TOKEN, so the retry that actually
 * recovered the call never fires.
 *
 * The real recovery is to send the body again.
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

function reply(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200 })
}

const NO_TOKEN = { _status: 401, error: 'Sign in with Google to continue.', code: 'NO_TOKEN' }

let fetchMock: ReturnType<typeof vi.fn>

/**
 * A backend that behaves the way Apps Script actually does.
 *
 * `handle_` resolves identity from `body.session_token || params.session_token`
 * and `route_` reads `params.x || body.x` for every argument. So this answers
 * from whatever the request genuinely carried — which is the part the first
 * version of this file got wrong: its stub returned success while ignoring
 * that the photo, price and identifier had never arrived.
 */
function backend(opts: { dropBody: boolean }) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const query = Object.fromEntries(url.searchParams.entries())
    const sentBody =
      init?.method === 'POST' && !opts.dropBody ? JSON.parse(String(init.body)) : {}
    const seen = { ...sentBody, ...query }

    if (!seen.session_token && !seen.id_token) return reply(NO_TOKEN)
    // Authenticated — now the action runs on whatever arguments arrived.
    if (!seen.listing_id) {
      return reply({ _status: 422, error: 'Unknown listing: undefined', code: 'TS-PRD-09' })
    }
    return reply({ _status: 200, ok: true, listing_id: seen.listing_id })
  })
}

beforeEach(() => {
  fetchMock = backend({ dropBody: false })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function urlOf(call: number): URL {
  return new URL(String(fetchMock.mock.calls[call]![0]))
}

describe('the credential never rides in the URL of a POST', () => {
  it('a POST carries action only, and the sign-in stays in the body', async () => {
    const api = await loadApi()
    await api.call('removeVariation', { body: { listing_id: 'L1' }, timeoutMs: 1000 })

    const url = urlOf(0)
    expect(url.searchParams.get('action')).toBe('removeVariation')
    expect(url.searchParams.get('id_token')).toBeNull()
    expect(url.searchParams.get('session_token')).toBeNull()
  })

  /**
   * The regression, stated as a test.
   *
   * With the credential in the URL this call answered "Unknown listing:
   * undefined [TS-PRD-09]" and never retried, because the reply was no longer
   * NO_TOKEN. That is the exact 15 Sep mid-broadcast error the `params || body`
   * rule was written to eliminate.
   */
  it('a dropped body still recovers, because the reply is still NO_TOKEN', async () => {
    const api = await loadApi()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      // The body is dropped; only the query survives. This is the failure.
      const seen = Object.fromEntries(url.searchParams.entries())
      if (!seen.session_token && !seen.id_token) return reply(NO_TOKEN)
      if (!seen.listing_id) {
        return reply({ _status: 422, error: 'Unknown listing: undefined', code: 'TS-PRD-09' })
      }
      return reply({ _status: 200, ok: true, listing_id: seen.listing_id })
    })

    const out = await api.call<{ listing_id: string }>(
      'removeVariation', { body: { listing_id: 'L1' }, timeoutMs: 1000 },
    )

    // Recovered on the GET, which carries the whole payload in the query.
    expect(out.listing_id).toBe('L1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'GET' })
    expect(urlOf(1).searchParams.get('listing_id')).toBe('L1')
  })
})

describe('pushSku, which cannot be retried as a GET', () => {
  it('retries as a POST rather than giving up', async () => {
    const api = await loadApi()
    let first = true
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      // The body is dropped once, then arrives. A transient transport failure.
      const dropped = first
      first = false
      const url = new URL(String(input))
      const sentBody = dropped ? {} : JSON.parse(String(init!.body))
      const seen = { ...sentBody, ...Object.fromEntries(url.searchParams.entries()) }
      if (!seen.session_token && !seen.id_token) return reply(NO_TOKEN)
      return reply({ _status: 200, ok: true, product_id: '123' })
    })

    const out = await api.call<{ product_id: string }>(
      'pushSku', { body: { image_base64: 'z'.repeat(50_000) }, timeoutMs: 1000 },
    )

    expect(out.product_id).toBe('123')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // A POST, because the photo cannot fit in a query string.
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' })
    expect(urlOf(1).toString().length).toBeLessThan(2000)
  })

  it('says the session is good when both attempts lose the body', async () => {
    const api = await loadApi()
    fetchMock.mockImplementation(async () => reply(NO_TOKEN))

    const err = await api
      .call('pushSku', { body: { image_base64: 'z'.repeat(50_000) }, timeoutMs: 1000 })
      .catch((e: unknown) => e as InstanceType<Awaited<ReturnType<typeof loadApi>>['ScriptError']>)

    expect((err as { code: string }).code).toBe('CREDENTIAL_LOST_IN_TRANSIT')
    expect((err as { message: string }).message).toMatch(/on both attempts/)
    expect((err as { message: string }).message).toMatch(/session is still good/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
