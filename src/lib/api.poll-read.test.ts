// @vitest-environment happy-dom
/**
 * The listing screen's timer reads with POLL_READ, through the real
 * api.listingState, retryRead and call, against a fake backend that answers
 * slowly. The plan has to reach retryRead: one request however slow, where a
 * read somebody asked for is still hedged at twenty seconds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A backend whose every reply takes `afterMs`. Counts what it was sent. */
function slowBackend(afterMs: number) {
  const sent: string[] = []
  ;(globalThis as { fetch: unknown }).fetch = vi.fn((url: string) => {
    sent.push(new URL(url).searchParams.get('action') ?? '')
    return new Promise((res) =>
      setTimeout(
        () =>
          res({
            status: 200,
            url: 'https://script.googleusercontent.com/x',
            text: async () => JSON.stringify({ listing_id: 'L1', variants: [], checked_at: '' }),
          }),
        afterMs,
      ),
    )
  })
  return sent
}

async function load() {
  vi.resetModules()
  vi.stubEnv('VITE_APPS_SCRIPT_URL', 'https://script.example/exec')
  const sa = await import('./script-api')
  const api = await import('./api')
  sa.setSessionToken(b64({ e: 'a@x.com', n: 'a', x: Date.now() + 3600_000 }) + '.sig')
  return api
}

async function settle<T>(p: Promise<T>) {
  let out: { ok: boolean } | null = null
  p.then(
    () => (out = { ok: true }),
    () => (out = { ok: false }),
  )
  for (let i = 0; i < 600 && !out; i++) await vi.advanceTimersByTimeAsync(100)
  return out as { ok: boolean } | null
}

describe('api.listingState takes a read plan', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('POLL_READ: one request, even when it takes thirty seconds', async () => {
    const { api, POLL_READ } = await load()
    const sent = slowBackend(30_000)
    const out = await settle(api.listingState('L1', POLL_READ))
    expect(out?.ok).toBe(true)
    expect(sent).toEqual(['listingState'])
  })

  it('no plan: still the heavy read, hedged at twenty seconds', async () => {
    const { api } = await load()
    const sent = slowBackend(30_000)
    const out = await settle(api.listingState('L1'))
    expect(out?.ok).toBe(true)
    expect(sent).toEqual(['listingState', 'listingState'])
  })
})
