import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { api, ApiError } from './lib/api'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { allDrafts, pendingCount } from './offline/queue'
import type { Shop, SignedInUser } from './types'
import SignIn from './auth/SignIn'
import LiveListing from './live-listing/LiveListing'

export default function App() {
  const [user, setUser] = useState<SignedInUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [shops, setShops] = useState<Shop[]>([])
  const [shopId, setShopId] = useState<string | null>(null)
  const [pending, setPending] = useState(0)
  const online = useOnlineStatus()

  // The session lives in an HTTP-only cookie the browser cannot read, so the
  // only way to know whether we are signed in is to ask the server.
  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
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
    try {
      await api.signOut()
    } catch (error) {
      // Signing out locally still matters even if the call fails.
      if (!(error instanceof ApiError)) throw error
    }
    setUser(null)
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">
        Loading…
      </div>
    )
  }

  if (!user) return <SignIn onSignedIn={setUser} />

  const shop = shops.find((s) => s.shop_id === shopId) ?? null

  return (
    <div className="min-h-screen flex flex-col bg-ink">
      <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-white/10">
        <div className="flex items-center gap-3 px-3 py-2 max-w-5xl mx-auto w-full">
          <span className="text-accent font-bold tracking-tight shrink-0">TikShop</span>

          {/* Shops are labelled by brand, because that is how the team thinks
              about them — not by TikTok's numeric shop id. */}
          <select
            aria-label="Brand"
            value={shopId ?? ''}
            onChange={(e) => chooseShop(e.target.value)}
            className="min-w-0 max-w-[45%] bg-raised border border-white/10 rounded-lg px-2 py-1 text-sm text-white outline-none focus:border-accent"
          >
            {shops.length === 0 && <option value="">No shops yet</option>}
            {shops.map((s) => (
              <option key={s.shop_id} value={s.shop_id}>
                {s.brand}
                {s.authorised ? '' : ' (not connected)'}
              </option>
            ))}
          </select>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {/* Two separate signals. "Offline" is the network; "waiting" is
                unpushed work, which can be non-zero even when online. */}
            {!online && (
              <span className="text-xs px-2 py-1 rounded-lg bg-amber-500/15 text-amber-300">
                Offline
              </span>
            )}
            {pending > 0 && (
              <span
                className="text-xs px-2 py-1 rounded-lg bg-blue-500/15 text-blue-300"
                title="SKUs saved on this device that have not reached TikTok yet"
              >
                {pending} waiting
              </span>
            )}
            <button
              onClick={signOut}
              className="text-xs text-gray-500 hover:text-white transition-colors whitespace-nowrap"
            >
              Sign out
            </button>
          </div>
        </div>

        <nav className="flex gap-1 px-3 pb-1 max-w-5xl mx-auto w-full">
          <Tab to="/live-listing">Live Listing</Tab>
          {/* Orders is Phase 4. The tab is deliberately absent rather than
              present and dead. */}
        </nav>
      </header>

      <main className="flex-1 p-3 max-w-5xl mx-auto w-full">
        {!shop && shops.length === 0 ? (
          <p className="text-sm text-gray-500 py-10 text-center">
            No shops are connected yet. Authorise a TikTok Shop to start listing.
          </p>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/live-listing" replace />} />
            <Route
              path="/live-listing"
              element={shop ? <LiveListing shop={shop} onQueueChange={refreshPending} /> : null}
            />
            <Route path="*" element={<Navigate to="/live-listing" replace />} />
          </Routes>
        )}
      </main>
    </div>
  )
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `text-sm px-3 py-1.5 rounded-lg transition-colors ${
          isActive ? 'bg-accent text-white' : 'text-gray-400 hover:text-white'
        }`
      }
    >
      {children}
    </NavLink>
  )
}
