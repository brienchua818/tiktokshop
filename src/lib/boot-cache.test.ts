import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readBoot, rememberMe, rememberShops, forgetBoot, BOOT_CACHE_MAX_AGE_MS } from './boot-cache'
import type { Me } from './api'
import type { Shop } from '../types'

/**
 * Opening instantly is only acceptable if it can never open on the wrong
 * person's state. Every test here is about WHO the cache answers for.
 */
function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  }
}

const NOW = 1_800_000_000_000
const me = (over: Partial<Me> = {}): Me =>
  ({
    email: 'anthea@sheldonglobal.com', name: 'Anthea', picture: null,
    role: 'lister', approved: true, admin: false, ...over,
  }) as Me
const shops = [{ shop_id: 'HZ', brand: 'HOUZE' }] as unknown as Shop[]

beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('the app opens on what it remembered', () => {
  it('gives back who you are and your shops, for the same session', () => {
    rememberMe('sess-A', me(), NOW)
    rememberShops('sess-A', shops, NOW)
    const got = readBoot('sess-A', NOW + 1000)
    expect(got?.me?.email).toBe('anthea@sheldonglobal.com')
    expect(got?.shops).toEqual(shops)
  })

  it('never stores the session token inside the cache', () => {
    rememberMe('sess-A', me({ session_token: 'SECRET' }), NOW)
    expect(localStorage.getItem('tikshop.boot')).not.toContain('SECRET')
  })
})

describe('it never answers for the wrong person', () => {
  it('a different session gets nothing', () => {
    rememberMe('sess-A', me(), NOW)
    expect(readBoot('sess-B', NOW)).toBeNull()
  })

  it('no session gets nothing', () => {
    rememberMe('sess-A', me(), NOW)
    expect(readBoot(null, NOW)).toBeNull()
  })

  it('an unapproved account is never remembered as approved', () => {
    rememberMe('sess-A', me({ approved: false }), NOW)
    expect(readBoot('sess-A', NOW)).toBeNull()
  })

  it("another person's shops are not carried into a new sign-in", () => {
    rememberMe('sess-A', me({ email: 'anthea@sheldonglobal.com' }), NOW)
    rememberShops('sess-A', shops, NOW)
    rememberMe('sess-B', me({ email: 'wenxuan@sheldonglobal.com' }), NOW)
    expect(readBoot('sess-B', NOW)?.shops).toBeNull()
  })

  it("the same person's shops ARE carried to their fresh session", () => {
    // Every whoami issues a new token. The same person keeps their shops.
    rememberMe('sess-A', me(), NOW)
    rememberShops('sess-A', shops, NOW)
    rememberMe('sess-A2', me(), NOW)
    expect(readBoot('sess-A2', NOW)?.shops).toEqual(shops)
  })

  it('shops fetched under an old session are not written into a new one', () => {
    rememberMe('sess-B', me(), NOW)
    rememberShops('sess-A', shops, NOW)
    expect(readBoot('sess-B', NOW)?.shops).toBeNull()
  })

  it('a memory older than a working day is not used', () => {
    rememberMe('sess-A', me(), NOW)
    expect(readBoot('sess-A', NOW + BOOT_CACHE_MAX_AGE_MS + 1)).toBeNull()
  })

  it('forgetting clears it', () => {
    rememberMe('sess-A', me(), NOW)
    forgetBoot()
    expect(readBoot('sess-A', NOW)).toBeNull()
  })
})

describe('broken storage behaves like no memory, never like an error', () => {
  it('a garbled value is ignored', () => {
    localStorage.setItem('tikshop.boot', '{not json')
    expect(readBoot('sess-A', NOW)).toBeNull()
  })

  it('storage that throws does not break anything', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    })
    expect(() => rememberMe('sess-A', me(), NOW)).not.toThrow()
    expect(readBoot('sess-A', NOW)).toBeNull()
    expect(() => forgetBoot()).not.toThrow()
  })
})
