// @vitest-environment happy-dom
/**
 * A first sign-in is one round trip, not two.
 *
 * whoami now carries the shop list for anyone approved, so the app need not
 * wait for whoami and THEN ask for shops. An older backend does not send
 * them, and the app must then ask exactly as before — this frontend reaches
 * phones the moment it is pushed, before the backend is re-pasted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const tok = (email: string) => b64({ e: email, n: email, x: Date.now() + 10 * 3600_000 }) + '.sig'
const SHOPS = [{ shop_id: 'HZ', brand: 'HOUZE', authorised: true }]

const calls: string[] = []
let whoamiShops: unknown = undefined
vi.mock('./lib/script-api', async (orig) => {
  const real = await orig<typeof import('./lib/script-api')>()
  return {
    ...real,
    call: vi.fn((action: string) => {
      calls.push(action)
      if (action === 'whoami') {
        return Promise.resolve({
          email: 'a@x.com', name: 'A', picture: null, role: 'lister', approved: true, admin: false,
          session_token: tok('a@x.com'), ...(whoamiShops ? { shops: whoamiShops } : {}),
        })
      }
      if (action === 'shops') return Promise.resolve(SHOPS)
      return new Promise(() => {})
    }),
  }
})
vi.mock('./auth/google', () => ({ forgetAccount: () => Promise.resolve() }))
vi.mock('./lib/pwa', () => ({ useAppUpdate: () => ({ available: false, apply: () => {} }) }))
vi.mock('./offline/queue', () => ({ allDrafts: async () => [], pendingCount: () => 0, reviveOrphanedUploads: async () => 0 }))
let signInCb: ((me: unknown) => void) | null = null
vi.mock('./auth/SignIn', () => ({ default: (p: { onSignedIn: (me: unknown) => void }) => { signInCb = p.onSignedIn; return <div>SIGNIN</div> } }))
let liveProps: { shop?: { shop_id: string } } | null = null
vi.mock('./live-listing/LiveListing', () => ({ default: (p: { shop?: { shop_id: string } }) => { liveProps = p; return <div>LIVE</div> } }))
vi.mock('./orders/Orders', () => ({ default: () => <div>ORDERS</div> }))
vi.mock('./more/More', () => ({ default: () => <div>MORE</div> }))
vi.mock('./more/Users', () => ({ default: () => <div>USERS</div> }))
vi.mock('./more/About', () => ({ default: () => <div>ABOUT</div> }))

import App from './App'
import { setSessionToken } from './lib/script-api'

async function boot() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => { root.render(<MemoryRouter initialEntries={['/live-listing']}><App /></MemoryRouter>) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return el
}

describe('shops on a first sign-in', () => {
  beforeEach(() => {
    localStorage.clear()
    calls.length = 0
    liveProps = null
    setSessionToken(tok('a@x.com'))   // signed in, nothing remembered: the slow path
  })

  it('uses the shops whoami sent, and does not ask again', async () => {
    whoamiShops = SHOPS
    const el = await boot()
    expect(el.textContent).toContain('LIVE')
    expect(liveProps?.shop?.shop_id).toBe('HZ')
    expect(calls).toEqual(['whoami'])
  })

  it('asks for them separately when an older backend did not send them', async () => {
    whoamiShops = undefined
    const el = await boot()
    expect(el.textContent).toContain('LIVE')
    expect(calls).toEqual(['whoami', 'shops'])
  })

  it('a sign-in on the sign-in screen is remembered, so the next open is instant', async () => {
    // Only the startup check remembered anybody, so the first reopen after a
    // real sign-in still waited the whole round trip.
    setSessionToken(null)
    const el = await boot()
    expect(el.textContent).toContain('SIGNIN')
    const me = {
      email: 'a@x.com', name: 'A', picture: null, role: 'lister', approved: true, admin: false, shops: SHOPS,
    }
    setSessionToken(tok('a@x.com'))              // what SignIn's own whoami did
    await act(async () => { signInCb!(me) })
    const saved = JSON.parse(localStorage.getItem('tikshop.boot') ?? 'null')
    expect(saved?.me?.email).toBe('a@x.com')
    expect(saved?.shops?.[0]?.shop_id).toBe('HZ')
  })

  it('remembers them once, not inside the person as well', async () => {
    whoamiShops = SHOPS
    await boot()
    const saved = JSON.parse(localStorage.getItem('tikshop.boot') ?? 'null')
    expect(saved?.me?.shops).toBeUndefined()
    expect(saved?.shops?.[0]?.shop_id).toBe('HZ')
  })
})
