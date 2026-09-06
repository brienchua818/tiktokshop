import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

/**
 * Keeping the installed app up to date, visibly.
 *
 * This app is a home-screen PWA whose shell is cached so it opens with no
 * signal. The cost of that is real: a browser only looks for a new service
 * worker on navigation or roughly once a day, so an app left open on a phone
 * can serve a build from hours ago while every fix since sits unused. That is
 * not hypothetical — it is how a whole afternoon of fixes went untested,
 * because the phone kept answering from its cache and nothing said so.
 *
 * So the worker is registered here rather than by an injected script, checked
 * on a timer and whenever the app comes back to the foreground, and the result
 * is surfaced. Nothing reloads on its own: a reload mid-SKU loses a half-typed
 * form, and during a broadcast that is worse than running yesterday's build for
 * another minute.
 */

/** Often enough to catch a mid-stream fix, rare enough to be free. */
const CHECK_EVERY_MS = 60_000

export interface AppUpdate {
  /** A new build is downloaded and waiting. */
  ready: boolean
  /** Apply it and reload. Call when the operator taps. */
  apply: () => void
}

export function useAppUpdate(): AppUpdate {
  const [ready, setReady] = useState(false)
  const [apply, setApply] = useState<() => void>(() => () => {})

  useEffect(() => {
    // Not available in dev, and not worth breaking the app over.
    if (!('serviceWorker' in navigator)) return

    let timer: number | undefined
    let registration: ServiceWorkerRegistration | undefined

    const updateSW = registerSW({
      onNeedRefresh() {
        setReady(true)
      },
      onRegisteredSW(_url, r) {
        registration = r
        if (!r) return
        // The browser's own schedule is too slow to be useful here.
        timer = window.setInterval(() => {
          if (navigator.onLine) void r.update()
        }, CHECK_EVERY_MS)
      },
    })

    // setState with a function argument would CALL it, so it is wrapped.
    setApply(() => () => void updateSW(true))

    // Coming back to a phone that has been in a pocket is the moment an
    // update is most likely to be waiting, and the timer will not have run.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void registration?.update()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      if (timer) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return { ready, apply }
}
