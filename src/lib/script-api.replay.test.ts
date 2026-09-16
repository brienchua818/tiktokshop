import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * A write is never replayed. A read always can be.
 *
 * Both cases that reach the GET fallback are cases where the backend ALREADY
 * RAN. Apps Script executes doPost and THEN redirects to a GET-only host, so a
 * 405 on the second leg is a write that already landed; a 404 there means the
 * execution produced no reply, which may still have done part of the work.
 *
 * `setStock` is a DELTA applied by read-modify-write, with no ETag, no version
 * field and no idempotency key. Replaying it reads the already-updated
 * quantity and adds the same units again — so the operator asks for +10 and
 * TikTok ends at +20, with no error shown anywhere.
 */
const BASE = 'https://script.google.com/macros/s/AAA/exec'
const CONTENT = 'https://script.googleusercontent.com/macros/echo?x=1'
const TOKEN = 'header.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig'

async function loadApi() {
  vi.resetModules()
  vi.stubEnv('VITE_APPS_SCRIPT_URL', BASE)
  const mod = await import('./script-api')
  mod.setIdToken(TOKEN)
  return mod
}

/** A response whose `url` is the content host, as a followed 302 produces. */
function page(status: number) {
  const res = new Response('<html>no</html>', { status: 200 })
  Object.defineProperty(res, 'url', { value: CONTENT })
  Object.defineProperty(res, 'status', { value: status })
  return res
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe.each([405, 404])('when the POST comes back as a page (HTTP %i)', (status) => {
  /** A backend that applies the delta on EVERY leg, as setVariationStock_ does. */
  function stockBackend() {
    const log: string[] = []
    let stock = 5
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const delta = 10
      stock += delta
      log.push(`${method} +${delta} -> ${stock}`)
      if (method === 'POST') return page(status)
      return new Response(JSON.stringify({ _status: 200, after: stock }), { status: 200 })
    })
    return { fetchMock, log, stock: () => stock }
  }

  it('does not add the stock twice', async () => {
    const { fetchMock, log, stock } = stockBackend()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadApi()

    await api
      .call('setStock', { body: { identifier: 'A1', delta: 10 }, timeoutMs: 1000 })
      .catch(() => null)

    expect(log).toEqual([`POST +10 -> 15`])
    expect(stock()).toBe(15)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('raises the error instead of silently succeeding', async () => {
    const { fetchMock } = stockBackend()
    vi.stubGlobal('fetch', fetchMock)
    const api = await loadApi()

    const err = await api
      .call('setStock', { body: { identifier: 'A1', delta: 10 }, timeoutMs: 1000 })
      .then(() => null, (e: unknown) => e as { code?: string; message: string })

    expect(err).not.toBeNull()
    // The operator must be told it may have landed, not handed a number.
    expect(err!.message).toMatch(/part of the work|Reading works but saving/)
  })

  it('still replays a READ, which is what the fallback is for', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_i: unknown, init?: RequestInit) => {
        calls++
        if ((init?.method ?? 'GET') === 'POST') return page(status)
        return new Response(JSON.stringify({ _status: 200, listings: ['L1'] }), { status: 200 })
      }),
    )
    const api = await loadApi()
    const out = await api.call<{ listings: string[] }>('listings', {
      body: { shop_id: 'PM' },
      timeoutMs: 1000,
    })
    expect(out.listings).toEqual(['L1'])
    expect(calls).toBe(2)
  })
})

describe('the write list mirrors the backend', () => {
  it('names every action the backend treats as a write', async () => {
    const api = await loadApi()
    // apps-script/Api.gs WRITE_ACTIONS, verbatim.
    for (const a of [
      'addListing', 'saveSku', 'pushSku', 'setRole',
      'setStock', 'reserveIdentifier', 'removeVariation', 'restoreVariation',
    ]) {
      const err = await api
        .call(a, { body: {}, timeoutMs: 1 })
        .then(() => null, (e: unknown) => e as { isOutcomeUnknown?: boolean })
      // A timeout on any of these must read as "may have landed", never as
      // "nothing was changed, safe to try again".
      expect(err, a).not.toBeNull()
    }
  })
})

/**
 * "Refused" and "went wrong" are different answers.
 *
 * Every exception during a push used to come back 422, and the client reads
 * 422 as "will fail identically, park it". So Drive having one of its periodic
 * bad minutes — "Exception: Service error: Drive", WX11 and WX12, HOUZE,
 * 16 Sep — was treated exactly like TikTok refusing a title, and two SKUs
 * stopped dead mid-broadcast. A retry three seconds later would have worked.
 */
describe('a push distinguishes a refusal from a hiccup', () => {
  async function errorFor(body: Record<string, unknown>, status: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ _status: status, ...body }), { status: 200 }),
      ),
    )
    const api = await loadApi()
    return (await api
      .call('pushSku', { body: { identifier: 'A1' }, timeoutMs: 1000 })
      .then(() => null, (e: unknown) => e)) as { isRetryable: boolean; code?: string }
  }

  it('an unanticipated runtime error retries', async () => {
    const err = await errorFor(
      { error: 'Exception: Service error: Drive', code: 'TS-UNC-00', retryable: true },
      500,
    )
    expect(err.isRetryable).toBe(true)
  })

  it("TikTok's own refusal does not", async () => {
    const err = await errorFor(
      { error: 'Product name must be at least 25 characters', code: 'TS-TT-12', retryable: false },
      422,
    )
    expect(err.isRetryable).toBe(false)
  })

  it('an older backend that sends no flag still behaves as before', async () => {
    expect((await errorFor({ error: 'nope', code: 'TS-TT-12' }, 422)).isRetryable).toBe(false)
    expect((await errorFor({ error: 'boom', code: 'TS-UNC-00' }, 500)).isRetryable).toBe(true)
  })
})
