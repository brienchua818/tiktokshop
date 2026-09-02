import { useEffect, useState } from 'react'

/**
 * Whether the browser thinks it has a connection.
 *
 * `navigator.onLine` is optimistic — it reports true on a Wi-Fi network with no
 * working uplink, which is exactly the factory situation. So it is treated as
 * a hint for the indicator only; whether work actually reaches TikTok is
 * decided by the queue, which retries on real failures rather than on this
 * flag.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}
