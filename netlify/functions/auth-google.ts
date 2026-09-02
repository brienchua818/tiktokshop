import { buildConsentUrl } from '../lib/google-auth'
import { signState } from '../lib/oauth-state'

/**
 * Start Google sign-in.
 *
 * Reached as a plain link from the sign-in screen, so it redirects rather than
 * returning JSON.
 */
export default async (request: Request): Promise<Response> => {
  try {
    // No shop is involved, but the signed state still guards the round trip
    // against a forged callback.
    const state = signState('signin')
    return new Response(null, {
      status: 302,
      headers: { location: buildConsentUrl(request, state), 'cache-control': 'no-store' },
    })
  } catch (error) {
    console.error('[tikshop] Could not start Google sign-in', error)
    return new Response(null, { status: 302, headers: { location: '/?error=config' } })
  }
}
