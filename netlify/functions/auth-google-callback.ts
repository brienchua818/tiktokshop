import { exchangeCodeForProfile } from '../lib/google-auth'
import { verifyState } from '../lib/oauth-state'
import { createSession, sessionCookie, isAllowedEmail } from '../lib/session'
import { logSignIn } from '../lib/db'

/**
 * Where Google sends the user back.
 *
 * Register this exact URL in Google Cloud as an authorised redirect URI:
 *   https://sheldon-tikshop.netlify.app/api/auth-google-callback
 */
export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url)

  if (url.searchParams.get('error')) return redirect('/?error=denied')

  const code = url.searchParams.get('code')
  if (!code) return redirect('/?error=denied')

  // Guards against a callback that did not originate from our sign-in link.
  if (!verifyState(url.searchParams.get('state'))) return redirect('/?error=expired')

  try {
    const profile = await exchangeCodeForProfile(request, code)

    // The domain check is the access control. Google's `hd` parameter narrowed
    // the chooser, but it is a hint sent to Google, not a guarantee from it —
    // so the address itself is what gets verified.
    if (!isAllowedEmail(profile.email) || profile.email_verified === false) {
      await logSignIn(profile.email ?? 'unknown', 'refused_domain').catch(() => {})
      return redirect('/?error=domain')
    }

    const token = createSession({
      email: profile.email,
      name: profile.name || profile.email,
      picture: profile.picture ?? null,
    })

    await logSignIn(profile.email, 'signed_in').catch(() => {
      // Logging is useful, not load-bearing. Never block a sign-in on it.
    })

    return new Response(null, {
      status: 302,
      headers: {
        location: '/?signed_in=1',
        'set-cookie': sessionCookie(token),
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[tikshop] Google callback failed', error)
    return redirect('/?error=failed')
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
}
