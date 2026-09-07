import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type Me } from '../lib/api'
import { setIdToken } from '../lib/script-api'
import {
  isConfigured,
  onToken,
  promptSilently,
  renderSignInButton,
  SignInUnavailable,
} from './google'

/**
 * Sign-in.
 *
 * Any Google account may sign in. Signing in is **not** permission to act — a
 * first-time account lands on the allowlist as `pending` and can do nothing
 * until it is approved. Those are two separate things and this screen says so,
 * because "signed in but nothing works" is otherwise indistinguishable from
 * broken.
 *
 * There is deliberately no password field. The app this replaces compared a
 * hardcoded password in the browser and set a localStorage flag, so anyone
 * could read the password out of the public bundle or skip the check entirely.
 */
/**
 * Backend refusals that are configuration, not credentials.
 *
 * The distinction matters on this screen: for everything else "try again" is
 * sound advice, and for these it is a loop.
 */
const CONFIG_FAULTS = new Set(['BACKEND_NOT_CONFIGURED', 'CLIENT_ID_MISMATCH'])

export default function SignIn({ onSignedIn }: { onSignedIn: (user: Me) => void }) {
  const [error, setError] = useState('')
  /**
   * True when the backend refused for a reason no amount of clicking will fix.
   * Signing in again is the natural thing to try, and against a misconfigured
   * backend it fails identically every time — so the screen says so instead of
   * inviting another round.
   */
  const [fatal, setFatal] = useState(false)
  const [pendingApproval, setPendingApproval] = useState('')
  const [busy, setBusy] = useState(false)
  const buttonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isConfigured()) {
      setError(
        'Sign-in is not configured on this deployment. Not something you can fix from here — tell Brien.',
      )
      return
    }

    // One listener for both routes in: the button, and the silent prompt that
    // signs a returning account straight back in.
    const stop = onToken((token) => {
      setIdToken(token)
      setBusy(true)
      setError('')
      api
        .me()
        .then((me) => {
          if (me.approved) {
            onSignedIn(me)
            return
          }
          // Signed in, but the allowlist has not cleared them. The token is
          // kept — it is perfectly valid — and the screen says exactly what has
          // to happen next.
          setPendingApproval(me.email)
        })
        .catch((e: unknown) => {
          /**
           * Keep the credential unless it is the credential that is wrong.
           *
           * This discarded it on every failure, so a timeout or an unreachable
           * backend during sign-in threw away a token Google had just issued
           * and the person had to start again for no reason. Same mistake as
           * the app's startup check, in a second place.
           */
          if (!(e instanceof ApiError) || e.isCredentialDead) setIdToken(null)
          if (e instanceof ApiError) {
            setError(e.message)
            setFatal(CONFIG_FAULTS.has(String(e.code)))
            return
          }
          setError('Signed in with Google, but the app could not confirm it. Try again.')
        })
        .finally(() => setBusy(false))
    })

    let cancelled = false
    void (async () => {
      try {
        if (buttonRef.current) await renderSignInButton(buttonRef.current)
        if (!cancelled) await promptSilently()
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof SignInUnavailable ? e.message : 'Could not load Google sign-in.')
        }
      }
    })()

    return () => {
      cancelled = true
      stop()
    }
  }, [onSignedIn])

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm bg-surface border border-line rounded-2xl p-8 space-y-6">
        <div className="text-center space-y-1">
          <p className="text-accent font-bold text-2xl tracking-tight">TikShop</p>
          <p className="text-xs text-faint">
            Live listing for HOUZE, Table Matters and Painting Matters
          </p>
        </div>

        {error && (
          <div className="text-xs text-bad bg-bad-tint border border-bad-line rounded-lg px-3 py-2.5 space-y-1">
            <p>{error}</p>
            {fatal && (
              <p className="text-bad/70">
                Signing in again will not help — this is a setup problem on the server. Send
                Brien this message.
              </p>
            )}
          </div>
        )}

        {/* Not an error, and styled so it does not read as one: the account is
            fine, it simply has not been let in yet. */}
        {pendingApproval && (
          <div className="text-xs bg-warn-tint border border-warn-line rounded-lg px-3 py-2.5 space-y-1">
            <p className="text-warn">
              Signed in as <span className="font-medium">{pendingApproval}</span>, waiting for
              approval.
            </p>
            <p className="text-warn/70">
              Ask Brien to set this account to <span className="font-mono">lister</span> in the
              Users tab. Nothing else is needed.
            </p>
          </div>
        )}

        {/* Google's own button. The credential only reaches us through their
            flow, so drawing our own would misrepresent what is happening. */}
        <div ref={buttonRef} className="flex justify-center min-h-11" aria-busy={busy} />

        {busy && <p className="text-xs text-faint text-center">Checking your access…</p>}

        <p className="text-xs text-ghost text-center">
          Any Google account can sign in. Being approved to list is separate, and is how access is
          granted and revoked.
        </p>
      </div>
    </div>
  )
}
