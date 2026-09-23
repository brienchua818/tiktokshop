// @vitest-environment happy-dom
/**
 * Sign out must win against a reply that was already on its way.
 *
 * The app opens on what it remembered and asks `whoami` behind it, so Sign out
 * can now be tapped while that call is still running — up to a minute on a bad
 * day. Its reply carries a fresh session for the person who asked. Applied
 * late, it signed them straight back in, or handed the next person's phone
 * back to them with their role. Reproduced by the speed review, 23 Sep; these
 * are its reproductions, kept.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const tok = (email: string) => b64({ e: email, n: email, x: Date.now() + 10 * 3600_000 }) + '.sig-' + email
const meOf = (email: string, admin: boolean) => ({
  email, name: email, picture: null, role: admin ? 'admin' : 'lister', approved: true, admin,
  links: { sheet: 'x' }, session_token: tok(email),
})

const pendingWhoami: Array<{ sentWith: string | null; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
vi.mock('./lib/script-api', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    call: vi.fn((action: string) => {
      if (action === 'whoami') {
        return new Promise((resolve, reject) => pendingWhoami.push({ sentWith: real.getSessionToken(), resolve, reject }))
      }
      if (action === 'shops') return Promise.resolve([{ shop_id: 'HZ', brand: 'HOUZE', authorised: true }])
      return new Promise(() => {})
    }),
  }
})
vi.mock('./auth/google', () => ({ forgetAccount: () => Promise.resolve() }))
vi.mock('./lib/pwa', () => ({ useAppUpdate: () => ({ available: false, apply: () => {} }) }))
vi.mock('./offline/queue', () => ({ allDrafts: async () => [], pendingCount: () => 0, reviveOrphanedUploads: async () => 0 }))
let signInCb: ((u: any) => void) | null = null
vi.mock('./auth/SignIn', () => ({ default: (p: any) => { signInCb = p.onSignedIn; return <div id="signin">SIGNIN</div> } }))
vi.mock('./live-listing/LiveListing', () => ({ default: () => <div>LIVE</div> }))
vi.mock('./orders/Orders', () => ({ default: () => <div>ORDERS</div> }))
let moreProps: any = null
vi.mock('./more/More', () => ({ default: (p: any) => { moreProps = p; return <div>MORE</div> } }))
vi.mock('./more/Users', () => ({ default: () => <div>USERS</div> }))
vi.mock('./more/About', () => ({ default: () => <div>ABOUT</div> }))

import App from './App'
import { getSessionToken, ScriptError, setSessionToken } from './lib/script-api'
import { rememberMe, rememberShops } from './lib/boot-cache'

describe('sign out against a late whoami', () => {
  beforeEach(() => { localStorage.clear(); pendingWhoami.length = 0 })

  it('a late background whoami for A, after A signs out and B signs in, leaves the phone with B', async () => {
    // Phone was A's (admin) earlier today.
    const aTok = tok('a@x.com')
    setSessionToken(aTok)
    rememberMe(aTok, meOf('a@x.com', true) as any)
    rememberShops(aTok, [{ shop_id: 'HZ', brand: 'HOUZE' } as any])

    const el = document.createElement('div'); document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => { root.render(<MemoryRouter initialEntries={['/more']}><App /></MemoryRouter>) })
    expect(el.textContent).toContain('MORE')          // opened from memory as A
    expect(pendingWhoami.length).toBe(1)              // background whoami still in flight

    // A taps Sign out.
    await act(async () => { moreProps.onSignOut() })
    expect(el.textContent).toContain('SIGNIN')
    expect(getSessionToken()).toBeNull()

    // B signs in on the same phone (SignIn's own whoami already set B's session).
    const bMe = meOf('b@x.com', false)
    setSessionToken(bMe.session_token)
    await act(async () => { signInCb!(bMe) })
    expect(getSessionToken()).toBe(bMe.session_token)

    // A's background whoami finally answers.
    await act(async () => { pendingWhoami[0]!.resolve(meOf('a@x.com', true)) })

    expect(getSessionToken()).toBe(bMe.session_token)   // B's session kept
    expect(moreProps?.user?.email).toBe('b@x.com')
    expect(moreProps?.user?.admin).toBe(false)          // and never A's role
    const boot = JSON.parse(localStorage.getItem('tikshop.boot') ?? 'null')
    expect(boot?.session === aTok).toBe(false)          // nothing of A's remembered
  })

  it("a late REFUSAL of A's whoami, after B signs in, does not sign B out", async () => {
    // The failure half of the same race: A's session was dead, the refusal
    // arrives after the hand-over, and it must not clear B's credentials.
    const aTok = tok('a@x.com')
    setSessionToken(aTok)
    rememberMe(aTok, meOf('a@x.com', true) as any)
    const el = document.createElement('div'); document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => { root.render(<MemoryRouter initialEntries={['/more']}><App /></MemoryRouter>) })
    const pending = pendingWhoami[pendingWhoami.length - 1]!
    await act(async () => { moreProps.onSignOut() })
    const bMe = meOf('b@x.com', false)
    setSessionToken(bMe.session_token)
    await act(async () => { signInCb!(bMe) })
    await act(async () => { pending.reject(new ScriptError(401, 'dead', 'SESSION_INVALID')) })
    expect(getSessionToken()).toBe(bMe.session_token)
    expect(el.textContent).toContain('MORE')
  })

  it('A signs out and walks away; the late whoami does not sign A back in', async () => {
    const aTok = tok('a@x.com')
    setSessionToken(aTok)
    rememberMe(aTok, meOf('a@x.com', true) as any)
    const el = document.createElement('div'); document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => { root.render(<MemoryRouter initialEntries={['/more']}><App /></MemoryRouter>) })
    await act(async () => { moreProps.onSignOut() })
    expect(el.textContent).toContain('SIGNIN')
    await act(async () => { pendingWhoami[pendingWhoami.length - 1]!.resolve(meOf('a@x.com', true)) })
    expect(el.textContent).toContain('SIGNIN')
    expect(getSessionToken()).toBeNull()
    expect(localStorage.getItem('tikshop.boot')).toBeNull()
  })
})
