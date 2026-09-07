import { useEffect } from 'react'

/**
 * Escape closes an overlay, and the page behind it stops scrolling.
 *
 * Found by the control audit rather than by reading: with a sheet open, every
 * other control on the screen sits behind its scrim, and there was no way out
 * except tapping the scrim itself. That is fine with a thumb and a dead end
 * with a keyboard — an iPad with a Magic Keyboard, or anyone using switch
 * control. Escape is the expected gesture and it cost nothing to honour.
 *
 * Locking the body is the other half: without it the page underneath scrolls
 * when someone flicks a sheet that has no more to show, and the sheet appears
 * to drift over moving content.
 */
export function useDismiss(onClose: () => void): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])
}
