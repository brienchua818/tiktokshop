/**
 * Google sign-in, via Google Identity Services.
 *
 * The backend authenticates every request with a Google ID token, which it
 * verifies against Google before trusting a single field of it. So the
 * frontend's only job here is to obtain one and keep it fresh — it never sees
 * a TikTok credential, and there is no session cookie to steal.
 *
 * An ID token lives about an hour. That is longer than most tasks and shorter
 * than a livestream, so renewal is not optional: `tokenNeedsRenewal` is
 * checked before work rather than after a 401, because re-prompting a second
 * before a push is far better than losing the push and re-prompting after.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
const GSI_SRC = 'https://accounts.google.com/gsi/client'

/** How long to wait for Google's script before calling it unavailable. */
const GIS_LOAD_TIMEOUT_MS = 15_000

/** The slice of the GIS API this app uses. */
interface GoogleIdentity {
  accounts: {
    id: {
      initialize(config: {
        client_id: string
        callback: (response: { credential?: string }) => void
        auto_select?: boolean
        cancel_on_tap_outside?: boolean
        use_fedcm_for_prompt?: boolean
      }): void
      prompt(listener?: (notification: unknown) => void): void
      renderButton(
        parent: HTMLElement,
        options: {
          type?: 'standard' | 'icon'
          theme?: 'outline' | 'filled_blue' | 'filled_black'
          size?: 'small' | 'medium' | 'large'
          text?: 'signin_with' | 'signup_with' | 'continue_with'
          shape?: 'rectangular' | 'pill'
          width?: number
          logo_alignment?: 'left' | 'center'
        },
      ): void
      disableAutoSelect(): void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentity
  }
}

export class SignInUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignInUnavailable'
  }
}

let scriptPromise: Promise<GoogleIdentity> | null = null

/**
 * Load the Google script once, however many components ask for it.
 *
 * Deliberately not bundled: Google requires it be served from their origin,
 * and it is the one exception to this app otherwise having no third-party
 * script at runtime.
 */
function loadGis(): Promise<GoogleIdentity> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<GoogleIdentity>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
    const script = existing ?? document.createElement('script')

    const done = () => {
      if (window.google?.accounts?.id) resolve(window.google)
      else reject(new SignInUnavailable('Google sign-in loaded but did not initialise.'))
    }
    const failed = () =>
      reject(
        new SignInUnavailable(
          'Could not reach Google to sign in. Check the connection, and whether a content blocker is blocking accounts.google.com.',
        ),
      )

    script.addEventListener('load', done)
    script.addEventListener('error', failed)

    /**
     * A deadline, for the same reason every backend call has one.
     *
     * A script tag whose request hangs rather than fails fires neither `load`
     * nor `error`, so this promise never settled and every caller waited
     * forever. That is the shape of failure this app has already decided is
     * unacceptable: an unknown outcome is reported, never waited on.
     *
     * The promise is also cleared so a later attempt starts fresh instead of
     * returning this same rejected one for the rest of the session.
     */
    setTimeout(() => {
      if (window.google?.accounts?.id) return
      scriptPromise = null
      reject(
        new SignInUnavailable(
          'Google sign-in did not load within 15 seconds. Check the connection, and whether a content blocker is blocking accounts.google.com.',
        ),
      )
    }, GIS_LOAD_TIMEOUT_MS)

    if (!existing) {
      script.src = GSI_SRC
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }
  })

  // A failed load must not be cached, or a flaky connection would leave
  // sign-in permanently broken for the life of the page.
  scriptPromise.catch(() => {
    scriptPromise = null
  })
  return scriptPromise
}

type TokenListener = (token: string) => void

let initialised = false
const listeners = new Set<TokenListener>()

/**
 * Prepare GIS and register the callback that receives credentials.
 *
 * `initialize` is called once for the life of the page — calling it again
 * replaces the callback, which would silently orphan whoever registered
 * first.
 */
async function ensureInitialised(): Promise<GoogleIdentity> {
  if (!CLIENT_ID) {
    throw new SignInUnavailable(
      'Sign-in is not configured (VITE_GOOGLE_CLIENT_ID is unset). This is a deployment problem, not something you can fix here.',
    )
  }

  const google = await loadGis()
  if (initialised) return google

  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: (response) => {
      if (!response.credential) return
      for (const listener of listeners) listener(response.credential)
    },
    // Returning users are signed straight back in, which is what makes an
    // hourly token renewal invisible rather than an interruption.
    auto_select: true,
    cancel_on_tap_outside: false,
  })
  initialised = true
  return google
}

/** Called whenever a fresh ID token arrives, including on silent renewal. */
export function onToken(listener: TokenListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Draw Google's own sign-in button.
 *
 * Google's button rather than our own: the credential only reaches us through
 * their flow, and a custom button would be a lie about what is happening.
 */
export async function renderSignInButton(parent: HTMLElement, width = 280): Promise<void> {
  const google = await ensureInitialised()
  parent.replaceChildren()
  google.accounts.id.renderButton(parent, {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'left',
    width,
  })
}

/**
 * Ask for a credential without a click.
 *
 * Used for the initial check and for renewal. It may quietly decline — the
 * user dismissed One Tap before, or the browser suppresses it — so this is
 * always a best effort with the button as the fallback, never the only route
 * in.
 */
export async function promptSilently(): Promise<void> {
  const google = await ensureInitialised()
  google.accounts.id.prompt()
}

/** Forget the account, so the next sign-in asks which one. */
export async function forgetAccount(): Promise<void> {
  try {
    const google = await loadGis()
    google.accounts.id.disableAutoSelect()
  } catch {
    // Signing out locally still matters even if Google cannot be reached.
  }
}

/** True when sign-in can work at all. False means the build is misconfigured. */
export function isConfigured(): boolean {
  return Boolean(CLIENT_ID)
}
