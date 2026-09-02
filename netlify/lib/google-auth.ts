/**
 * Google Workspace sign-in.
 *
 * Access is granted and revoked by adding or removing the Workspace user.
 * There is no password anywhere in this app — the previous one compared a
 * hardcoded password in the browser, which anyone could read out of the public
 * bundle.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

export interface GoogleProfile {
  email: string
  name: string
  picture: string | null
  /** Google's own domain claim. Present only for Workspace accounts. */
  hd?: string
  email_verified?: boolean
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

export function clientId(): string {
  return required('GOOGLE_CLIENT_ID')
}

/** The redirect URI, which must match Google Cloud's registered value exactly. */
export function redirectUri(request: Request): string {
  const configured = process.env.GOOGLE_REDIRECT_URI
  if (configured) return configured
  // Derived from the request as a fallback, so deploy previews work without
  // extra configuration.
  return `${new URL(request.url).origin}/api/auth-google-callback`
}

export function buildConsentUrl(request: Request, state: string): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', clientId())
  url.searchParams.set('redirect_uri', redirectUri(request))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  // Narrows the account chooser to the company domain. A convenience only —
  // it can be tampered with, so the domain is still verified server-side.
  url.searchParams.set('hd', 'sheldonglobal.com')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

/** Exchange the authorisation code and read the profile behind it. */
export async function exchangeCodeForProfile(
  request: Request,
  code: string,
): Promise<GoogleProfile> {
  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: required('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri(request),
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed (${tokenResponse.status}): ${await tokenResponse.text()}`)
  }

  const { access_token } = (await tokenResponse.json()) as { access_token?: string }
  if (!access_token) throw new Error('Google returned no access token.')

  // Read the profile from the userinfo endpoint rather than decoding the
  // id_token ourselves: no JWT signature verification to get subtly wrong,
  // and the call is already authenticated by the token we just received.
  const profileResponse = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${access_token}` },
  })
  if (!profileResponse.ok) {
    throw new Error(`Google userinfo failed (${profileResponse.status})`)
  }

  return (await profileResponse.json()) as GoogleProfile
}
