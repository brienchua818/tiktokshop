// @vitest-environment happy-dom
/**
 * The sign-in, for as long as the app stays open.
 *
 * The backend session lasts fourteen hours from the last check-in, and the app
 * only checked in when it opened. Left open past that, it still showed the
 * listing screen while every push was refused — "N waiting", nothing moving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const tok = (email: string, msLeft: number) => b64({ e: email, n: email, x: Date.now() + msLeft }) + '.sig-' + email
const meOf = (email: string, session_token: string) => ({
  email, name: email, picture: null, role: 'lister', approved: true, admin: false,
  links: { sheet: 'x' }, session_token,
})

const whoami: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
vi.mock('./lib/script-api', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    call: vi.fn((action: string) => {
      if (action === 'whoami') return new Promise((resolve, reject) => whoami.push({ resolve, reject }))
      if (action === 'shops') return Promise.resolve([{ shop_id: 'HZ', brand: 'HOUZE', authorised: true }])
      return new Promise(() => {})
    }),
  }
})
vi.mock('./auth/google', () => ({ forgetAccount: () => Promise.resolve() }))
vi.mock('./lib/pwa', () => ({ useAppUpdate: () => ({ available: false, apply: () => {} }) }))
vi.mock('./offline/queue', () => ({ allDrafts: async () => [], pendingCount: () => 0, needsAttention: () => [], reviveOrphanedUploads: async () => 0 }))
vi.mock('./offline/runner', () => ({ onQueueChange: () => () => {}, startQueueRunner: () => () => {} }))
vi.mock('./auth/SignIn', () => ({ default: () => <div id="signin">SIGNIN</div> }))
vi.mock('./live-listing/LiveListing', () => ({ default: () => <div>LIVE</div> }))
vi.mock('./orders/Orders', () => ({ default: () => <div>ORDERS</div> }))
vi.mock('./more/More', () => ({ default: () => <div>MORE</div> }))
vi.mock('./more/Users', () => ({ default: () => <div>USERS</div> }))
vi.mock('./more/About', () => ({ default: () => <div>ABOUT</div> }))

import App from './App'
import { getSessionToken, ScriptError, setIdToken, setSessionToken } from './lib/script-api'
import { rememberMe, rememberShops } from './lib/boot-cache'

async function openFromMemory(session: string) {
  setSessionToken(session)
  rememberMe(session, meOf('a@x.com', session) as any)
  rememberShops(session, [{ shop_id: 'HZ', brand: 'HOUZE' } as any])
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => { root.render(<MemoryRouter initialEntries={['/more']}><App /></MemoryRouter>) })
  return { el, root }
}

describe('the sign-in while the app stays open', () => {
  beforeEach(() => {
    localStorage.clear()
    whoami.length = 0
    setIdToken(null)
    setSessionToken(null)
  })

  it('checks in again before the session runs out, and keeps the fresh one', async () => {
    const { el, root } = await openFromMemory(tok('a@x.com', 60 * 60_000))   // an hour left
    expect(el.textContent).toContain('MORE')
    // The check-in at opening, and one because the session is nearly out.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(whoami.length).toBe(2)
    const fresh = tok('a@x.com', 14 * 3600_000)
    await act(async () => { whoami[1]!.resolve(meOf('a@x.com', fresh)) })
    expect(getSessionToken()).toBe(fresh)
    expect(el.textContent).toContain('MORE')
    root.unmount()
  })

  it('does not check in again while the session has hours left', async () => {
    const { root } = await openFromMemory(tok('a@x.com', 10 * 3600_000))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(whoami.length).toBe(1)                     // only the one at opening
    root.unmount()
  })

  it('a check-in that fails leaves the person signed in', async () => {
    const { el, root } = await openFromMemory(tok('a@x.com', 60 * 60_000))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { whoami[1]!.reject(new ScriptError(0, 'No connection: Load failed')) })
    expect(el.textContent).toContain('MORE')
    expect(getSessionToken()).not.toBeNull()
    root.unmount()
  })

  it('once the sign-in is gone it shows the sign-in screen, instead of a screen that cannot send', async () => {
    const { el, root } = await openFromMemory(tok('a@x.com', 10 * 3600_000))
    expect(el.textContent).toContain('MORE')
    // The backend called it dead on a push (push.ts drops it), or it lapsed.
    setSessionToken(null)
    await act(async () => { await new Promise((r) => setTimeout(r, 5_200)) })
    expect(el.textContent).toContain('SIGNIN')
    root.unmount()
  }, 15_000)
})
