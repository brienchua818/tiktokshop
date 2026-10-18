import { useEffect, useRef } from 'react'
import { isPageVisible } from './usePageVisible'

export interface AutoRefresh {
  /** False stops everything: no listing open, a window that has closed. */
  enabled: boolean
  /** The gap after a good answer before asking again. May change between renders. */
  everyMs: number
  /** On focus, a return to the page or a reconnect, read at once if the last good answer is older than this. */
  staleAfterMs: number
  /** When the last good answer arrived, by `Date.now()`. Zero for never. */
  lastGoodAt: () => number
  /** True skips this tick — a read already running, a sheet open — and the next one tries again. */
  busy: () => boolean
  /** The read. It reports its own failures; this only waits for it to settle. */
  read: () => Promise<unknown>
}

/**
 * Read again by itself while somebody is looking, and at once on coming back.
 *
 * One timer, and it is a setTimeout started once the previous read has
 * settled, never a setInterval. An interval fires on the clock whether or not
 * the last read has answered, so a slow backend is sent a second request on
 * top of the first, then a third, and Apps Script runs every one of them
 * (LIMITS.md: 30 at once, shared by every phone, because the web app runs as
 * one user).
 *
 *   - Only while the page is visible and the browser thinks it is online. A
 *     hidden page has no timer at all; coming back starts it again.
 *   - A tick is skipped while `busy()`, and the next tick tries again.
 *   - A tick that comes within `everyMs` of a good answer from somewhere else —
 *     a tap on refresh, a push landing — waits out the rest of the gap rather
 *     than asking twice.
 *   - Focus, a return from the background and a reconnect read at once, but
 *     only once the last good answer is older than `staleAfterMs`. Glancing
 *     at another app for a second must not cost a read.
 */
export function useAutoRefresh(opts: AutoRefresh): void {
  // The newest callbacks, so the timer never runs a closure from an old render.
  const latest = useRef(opts)
  useEffect(() => {
    latest.current = opts
  })
  /** Lets a change of interval move a tick that is already waiting. */
  const retime = useRef<(() => void) | null>(null)

  const { enabled } = opts
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const onScreen = () =>
      isPageVisible() && (typeof navigator === 'undefined' || navigator.onLine !== false)
    const clear = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const schedule = (ms: number) => {
      clear()
      if (stopped || !onScreen()) return
      timer = setTimeout(tick, Math.max(0, ms))
    }
    /** How long until the next read is due, counted from the last good answer. */
    const due = () => latest.current.everyMs - (Date.now() - latest.current.lastGoodAt())

    const run = async () => {
      running = true
      try {
        await latest.current.read()
      } catch {
        // The read shows its own failure. A throw here must not stop the timer.
      } finally {
        running = false
      }
      schedule(latest.current.everyMs)
    }

    const tick = () => {
      timer = null
      if (stopped || !onScreen()) return
      const wait = due()
      if (wait > 0) return schedule(wait)
      if (running || latest.current.busy()) return schedule(latest.current.everyMs)
      void run()
    }

    const wake = () => {
      if (stopped) return
      if (!onScreen()) return clear()
      const l = latest.current
      if (!running && !l.busy() && Date.now() - l.lastGoodAt() > l.staleAfterMs) return void run()
      // Back on screen with nothing waiting: pick the timer up where it was due.
      if (!timer && !running) schedule(due())
    }

    retime.current = () => {
      // Only a tick already waiting is moved. One that is reading reschedules
      // itself when it settles, and before any good answer there is no gap to
      // count from.
      if (timer && !running && latest.current.lastGoodAt() > 0) schedule(due())
    }

    schedule(latest.current.everyMs)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      stopped = true
      clear()
      retime.current = null
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [enabled])

  // The listing screen asks every twenty seconds while something is settling
  // and every thirty once nothing is. A tick already set for thirty when the
  // listing turned unsettled would otherwise be ten seconds late.
  const { everyMs } = opts
  const lastEvery = useRef(everyMs)
  useEffect(() => {
    if (lastEvery.current === everyMs) return
    lastEvery.current = everyMs
    retime.current?.()
  }, [everyMs])
}
