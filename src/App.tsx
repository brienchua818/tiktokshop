import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { api } from './lib/api'
import { hasCredential, setIdToken, setSessionToken } from './lib/script-api'
import { forgetAccount } from './auth/google'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { allDrafts, pendingCount } from './offline/queue'
import type { Shop, SignedInUser } from './types'
import SignIn from './auth/SignIn'
import LiveListing from './live-listing/LiveListing'
import Orders from './orders/Orders'
import More from './more/More'
import Users from './more/Users'
import About from './more/About'
import Icon, { type IconName } from './ui/Icon'
import { apply, readChoice, resolve, store, systemPrefersDark, watchSystem, type ThemeChoice } from './lib/theme'
import { useAppUpdate } from './lib/pwa'

export default function App() {
  const [user, setUser] = useState<SignedInUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopId] = useState<string | null>(null)
  const [pending, setPending] = useState(0)
  const [theme, setTheme] = useState<ThemeChoice>(readChoice)
  const online = useOnlineStatus()

  /**
   * Paint the palette, and keep following the phone while the choice is auto.
   *
   * `systemTick` exists only to re-run this when the phone flips at sunset:
   * matchMedia has no React binding, so the listener bumps a counter and the
   * effect below does the work.
   */
  const [systemTick, setSystemTick] = useState(0)
  useEffect(() => watchSystem(() => setSystemTick((n) => n + 1)), [])
  useEffect(() => {
    apply(resolve(theme, systemPrefersDark()))
  }, [theme, systemTick])

  const chooseTheme = useCallback((choice: ThemeChoice) => {
    setTheme(choice)
    store(choice)
  }, [])

  // A token kept from an earlier visit may still be good. Ask the backend
  // rather than trusting it: only the backend knows whether the account is
  // still approved, and an unapproved one must land on the sign-in screen with
  // its explanation, not inside the app with everything failing.
  useEffect(() => {
    // A backend session from earlier today, or a Google token from this tab —
    // either is enough to ask. The session is the one that makes reopening the
    // app during a stream silent rather than a sign-in screen.
    if (!hasCredential()) {
      setCheckingSession(false)
      return
    }
    api
      .me()
      .then((me) => setUser(me.approved ? me : null))
      .catch(() => {
        // Expired or revoked. Drop both, rather than retrying with credentials
        // that will fail every call from here on.
        setIdToken(null)
        setSessionToken(null)
        setUser(null)
      })
      .finally(() => setCheckingSession(false))
  }, [])

  useEffect(() => {
    if (!user) return
    api
      .shops()
      .then((rows) => {
        setShops(rows)
        // Remember the last shop across sessions: the team works one brand at
        // a time and re-picking it every morning is friction for nothing.
        const remembered = localStorage.getItem('tikshop.shop')
        const valid = rows.find((s) => s.shop_id === remembered) ?? rows[0]
        setShopId(valid?.shop_id ?? null)
      })
      .catch(() => setShops([]))
  }, [user])

  const refreshPending = useCallback(() => {
    allDrafts()
      .then((drafts) => setPending(pendingCount(drafts)))
      .catch(() => {
        /* IndexedDB unavailable (private window): the indicator just stays at 0. */
      })
  }, [])

  useEffect(() => {
    refreshPending()
    // Poll rather than subscribe: IndexedDB has no change events, and once a
    // second is cheap next to what the page is already doing.
    const timer = setInterval(refreshPending, 1000)
    return () => clearInterval(timer)
  }, [refreshPending])

  function chooseShop(id: string) {
    setShopId(id)
    localStorage.setItem('tikshop.shop', id)
  }

  async function signOut() {
    // The backend's session is a signed statement, not a server-side record,
    // so dropping it here IS signing out; forgetting the account stops Google
    // silently signing us straight back in.
    setIdToken(null)
    setSessionToken(null)
    await forgetAccount()
    setUser(null)
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center text-faint text-sm">
        Loading…
      </div>
    )
  }

  if (!user) return <SignIn onSignedIn={setUser} />

  const shop = shops.find((s) => s.shop_id === shopId) ?? null

  return (
    <div className="min-h-dvh flex flex-col bg-ink">
      {/*
        One 44 px strip, where the old header took two rows and 96 px.
        Everything here is READ, not tapped — which is why it can live at the
        top of a phone while every action moved to the bottom.
      */}
      <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-line">
        <div className="flex items-center gap-2 px-3 h-11 max-w-5xl mx-auto w-full">
          {/* Shops are labelled by brand, because that is how the team thinks
              about them — not by TikTok's numeric shop id. */}
          <div className="relative shrink-0 min-w-0 max-w-[55%]">
            <select
              aria-label="Brand"
              value={shopId ?? ''}
              onChange={(e) => chooseShop(e.target.value)}
              className="peer w-full appearance-none bg-raised border border-line rounded-lg pl-3 pr-8 h-8 text-sm font-semibold text-fg outline-none focus:border-accent"
            >
              {shops.length === 0 && <option value="">No shops yet</option>}
              {shops.map((s) => (
                <option key={s.shop_id} value={s.shop_id}>
                  {s.brand}
                  {s.authorised ? '' : ' (not connected)'}
                </option>
              ))}
            </select>
            <Icon
              name="chevron-down"
              size={16}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
          </div>

          {/* Desktop and iPad have room for the tabs up here, and no reach
              problem to solve — so the bottom bar is hidden there instead. */}
          <nav className="hidden md:flex items-center gap-1 ml-2">
            <TopTab to="/live-listing">Listing</TopTab>
            <TopTab to="/orders">Orders</TopTab>
            <TopTab to="/more">More</TopTab>
          </nav>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {/* Two separate signals. "Offline" is the network; "waiting" is
                unpushed work, which can be non-zero even when online. */}
            {!online && (
              <span className="text-xs px-2 h-7 inline-flex items-center rounded-lg bg-warn-tint text-warn">
                Offline
              </span>
            )}
            {pending > 0 && (
              <span
                className="text-xs px-2 h-7 inline-flex items-center gap-1.5 rounded-lg bg-info-tint text-info"
                title="SKUs saved on this device that have not reached TikTok yet"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-info" />
                {pending} waiting
              </span>
            )}
          </div>
        </div>
      </header>

      <UpdateBar />

      {/* pb-16 on phones clears the tab bar; md:pb-4 drops it where the bar is
          hidden. Without it the last SKU in the queue sits under the tabs. */}
      <main className="flex-1 px-3 pt-2 pb-16 md:pb-4 max-w-5xl mx-auto w-full">
        {!shop && shops.length === 0 ? (
          <p className="text-sm text-faint py-10 text-center">
            No shops are connected yet. Authorise a TikTok Shop to start listing.
          </p>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/live-listing" replace />} />
            <Route
              path="/live-listing"
              element={shop ? <LiveListing shop={shop} onQueueChange={refreshPending} /> : null}
            />
            <Route path="/orders" element={shop ? <Orders shop={shop} /> : null} />
            <Route
              path="/more"
              element={
                <More
                  user={user}
                  theme={theme}
                  onTheme={chooseTheme}
                  onSignOut={() => void signOut()}
                />
              }
            />
            <Route path="/more/users" element={<Users me={user} />} />
            <Route path="/more/about" element={<About />} />
            <Route path="*" element={<Navigate to="/live-listing" replace />} />
          </Routes>
        )}
      </main>

      <TabBar pending={pending} />
    </div>
  )
}

/**
 * The bottom tab bar: navigation where a thumb already is.
 *
 * Phones only. On an iPad there is no reach problem to solve and the tabs sit
 * in the top strip instead, so this hides at `md`. `pb-[env(safe-area-…)]`
 * keeps it clear of the home indicator rather than under it.
 */
function TabBar({ pending }: { pending: number }) {
  const tabs: { to: string; label: string; icon: IconName; badge?: number }[] = [
    { to: '/live-listing', label: 'Listing', icon: 'list', badge: pending },
    { to: '/orders', label: 'Orders', icon: 'receipt' },
    { to: '/more', label: 'More', icon: 'dots' },
  ]
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-20 flex items-stretch bg-surface border-t border-line pb-[env(safe-area-inset-bottom)]"
      aria-label="Sections"
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            `relative flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px] ${
              isActive ? 'text-accent font-semibold' : 'text-faint'
            }`
          }
        >
          <Icon name={tab.icon} size={22} />
          {tab.label}
          {/* A count on the tab, so unpushed work is visible from any screen —
              the old app only showed it in the header of the page you were on. */}
          {tab.badge ? (
            <span className="absolute top-1.5 right-[calc(50%-1.5rem)] min-w-4 h-4 px-1 rounded-full bg-info text-[10px] font-semibold text-ink flex items-center justify-center">
              {tab.badge}
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  )
}

/** A tab in the top strip, for widths where the bottom bar is hidden. */
function TopTab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 h-8 inline-flex items-center rounded-lg text-sm font-semibold ${
          isActive ? 'bg-accent text-white' : 'text-muted hover:text-fg'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

/**
 * "A new version is ready" — shown, never forced.
 *
 * Reloading on its own would lose a half-typed SKU, and mid-broadcast that is
 * worse than running the previous build for another minute. So it waits to be
 * tapped, and stays put until it is: a bar that dismisses itself is a bar
 * nobody reads.
 */
function UpdateBar() {
  const { ready, apply } = useAppUpdate()
  if (!ready) return null

  return (
    <button
      onClick={apply}
      className="w-full min-h-11 bg-accent text-fg text-sm font-medium px-4 flex items-center justify-center gap-2 active:scale-[0.995] transition-transform"
    >
      <span>A new version is ready</span>
      <span className="opacity-80 font-normal">— tap to update</span>
    </button>
  )
}

