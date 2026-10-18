import { useEffect, useState } from 'react'

/**
 * Whether this page is on screen: not a background tab, not a phone in a
 * pocket, not an app switched away from.
 *
 * Anything that runs on a timer only for the person looking at it stops when
 * this is false. A phone that has been put down should not keep asking the
 * backend for figures nobody is reading.
 */
export function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(isPageVisible)

  useEffect(() => {
    const onChange = () => setVisible(isPageVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}
