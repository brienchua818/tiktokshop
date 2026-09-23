import type { Me } from './api'
import type { Shop } from '../types'

/**
 * What the app last knew, so it can open on it instead of waiting.
 *
 * Opening the app used to be three strictly sequential Apps Script calls —
 * `whoami`, then `shops`, then the listing screen — each paying the platform's
 * own floor of 1.5s at best and 8–31s when Google has a slow moment, and each
 * wrapped in three 25-second attempts. Brien timed a sign-in at one minute.
 *
 * On a phone that was signed in earlier today, the answers to the first two
 * are almost always the same as last time. So the app opens straight onto
 * them, and asks the backend in the background; if anything changed, the
 * screen follows a second or two later.
 *
 * WHY THIS IS SAFE. Permission is decided by the backend, never by the phone.
 * Every push, stock change and removal re-checks the session and the role on
 * the server, so a remembered role changes only what the screen SHOWS for a
 * moment — it cannot grant anything. Somebody blocked overnight would see the
 * app for a second before the background check signed them out, and the
 * backend would have refused every action they tried in that second anyway.
 *
 * WHOSE CACHE. It is only ever read back under the exact session token it was
 * saved with. A new sign-in, a different person on the same phone, or a
 * signed-out phone all present a different token, so none of them can open on
 * somebody else's remembered state.
 */

const KEY = 'tikshop.boot'

/** Old enough that it is better to wait for the backend than to show it. */
export const BOOT_CACHE_MAX_AGE_MS = 18 * 60 * 60 * 1000

interface Saved {
  session: string
  me?: Me
  shops?: Shop[]
  savedAt: number
}

function readRaw(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Saved
    return parsed && typeof parsed.session === 'string' ? parsed : null
  } catch {
    // Private window, blocked storage, or a half-written value: behave as if
    // nothing was remembered, which is exactly the old, slower behaviour.
    return null
  }
}

function writeRaw(saved: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved))
  } catch {
    /* Storage full or blocked: the app still works, just without the head start. */
  }
}

/**
 * The remembered state for this session, or null.
 *
 * Null whenever there is any doubt: no session, a different session, a
 * remembered account that was not approved, or a memory older than a working
 * day. Null means "wait for the backend", which is always correct, only slower.
 */
export function readBoot(
  session: string | null,
  now: number = Date.now(),
): { me: Me | null; shops: Shop[] | null } | null {
  if (!session) return null
  const saved = readRaw()
  if (!saved || saved.session !== session) return null
  if (now - saved.savedAt > BOOT_CACHE_MAX_AGE_MS) return null
  const me = saved.me && saved.me.approved ? saved.me : null
  const shops = Array.isArray(saved.shops) && saved.shops.length ? saved.shops : null
  if (!me) return null
  return { me, shops }
}

/**
 * Remember who this is, under the session they are now holding.
 *
 * Every `whoami` issues a fresh session token, so this re-keys the memory to
 * it. Shops remembered under the previous token are carried across, because
 * the same person on the same phone has the same shops until `shops` says
 * otherwise.
 */
export function rememberMe(session: string | null, me: Me, now: number = Date.now()): void {
  if (!session) return
  if (!me.approved) {
    forgetBoot()
    return
  }
  const prior = readRaw()
  // The credential is stored on its own already; a copy inside this cache
  // would only be one more place for it to leak from.
  const { session_token: _drop, ...safeMe } = me
  void _drop
  writeRaw({
    session,
    me: safeMe as Me,
    shops: prior && prior.me && prior.me.email === me.email ? prior.shops : undefined,
    savedAt: now,
  })
}

/** Remember the shop list, for the session it was fetched under. */
export function rememberShops(session: string | null, shops: Shop[], now: number = Date.now()): void {
  if (!session) return
  const prior = readRaw()
  if (!prior || prior.session !== session) return
  writeRaw({ ...prior, shops, savedAt: now })
}

/** Forget everything. Called on sign-out and whenever a credential is dead. */
export function forgetBoot(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to forget */
  }
}
