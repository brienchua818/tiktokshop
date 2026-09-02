import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { SignedInUser } from '../types'

/**
 * Sign-in.
 *
 * Google Workspace, restricted to sheldonglobal.com. There is deliberately no
 * password field: the app this replaces compared a hardcoded password in the
 * browser and set a localStorage flag, so anyone could read the password out
 * of the public bundle or skip the check entirely. Access here is granted and
 * revoked by adding or removing the Workspace user.
 *
 * The redirect is handled server-side, so this component only starts the flow.
 */
export default function SignIn({ onSignedIn }: { onSignedIn: (user: SignedInUser) => void }) {
  const [error, setError] = useState('')

  // Coming back from Google, the function has already set the session cookie
  // and redirected here with ?signed_in=1. Ask who we are and get on with it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('error')) {
      setError(
        params.get('error') === 'domain'
          ? 'That account is not a sheldonglobal.com account.'
          : 'Sign-in did not complete. Try again.',
      )
      window.history.replaceState({}, '', window.location.pathname)
      return
    }
    if (params.get('signed_in')) {
      window.history.replaceState({}, '', window.location.pathname)
      api.me().then(onSignedIn).catch(() => setError('Sign-in did not complete. Try again.'))
    }
  }, [onSignedIn])

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm bg-surface border border-white/10 rounded-2xl p-8 space-y-6">
        <div className="text-center space-y-1">
          <p className="text-accent font-bold text-2xl tracking-tight">TikShop</p>
          <p className="text-xs text-gray-500">Live listing for HOUZE, Table Matters and Painting Matters</p>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <a
          href="/api/auth-google"
          className="flex items-center justify-center gap-2 w-full bg-white text-gray-900 text-sm font-medium py-2.5 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <GoogleMark />
          Sign in with Google
        </a>

        <p className="text-xs text-gray-600 text-center">
          Use your @sheldonglobal.com account.
        </p>
      </div>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.8 2.6 13.6l7.8 6c1.9-5.6 7.2-10.1 13.6-10.1z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24c0-1.6-.1-2.8-.4-4H24v8.5h12.8c-.3 2.1-1.6 5.2-4.6 7.3l7.6 5.9C44.3 37.5 46.5 31.4 46.5 24z"
      />
      <path
        fill="#FBBC05"
        d="M10.4 28.4c-.5-1.4-.8-2.9-.8-4.4s.3-3 .8-4.4l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.6 10.4l7.8-6z"
      />
      <path
        fill="#34A853"
        d="M24 47.5c6.2 0 11.4-2 15.2-5.6l-7.6-5.9c-2 1.4-4.7 2.4-7.6 2.4-6.4 0-11.7-4.5-13.6-10.1l-7.8 6C6.5 42.2 14.6 47.5 24 47.5z"
      />
    </svg>
  )
}
