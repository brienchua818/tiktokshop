/**
 * Day, dark, or whatever the phone says.
 *
 * Three settings rather than a toggle, because "follow the phone" is the one
 * most people want and a two-state switch cannot express it: a phone that
 * flips to dark at sunset should take the app with it, mid-stream, without
 * anyone touching a setting.
 *
 * The choice is per device (localStorage), not per account: the same person
 * uses a bright iPad in the factory and a phone in a dark studio, and those
 * want different answers.
 */
export type ThemeChoice = 'auto' | 'day' | 'dark'

const KEY = 'tikshop.theme'
const CHOICES: readonly ThemeChoice[] = ['auto', 'day', 'dark']

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value)
}

/** What was chosen, defaulting to following the phone. */
export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY)
    return isThemeChoice(stored) ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

/** Which palette a choice resolves to right now. */
export function resolve(choice: ThemeChoice, prefersDark: boolean): 'day' | 'dark' {
  if (choice === 'day') return 'day'
  if (choice === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'day'
}

/**
 * Paint the resolved palette onto the document.
 *
 * Dark is the default in CSS, so it is the ABSENCE of the attribute — one
 * less thing to go wrong if this never runs. The theme-color meta moves too,
 * or iOS keeps drawing the status bar and the home-screen splash in the old
 * palette while the page underneath has changed.
 */
export function apply(mode: 'day' | 'dark'): void {
  const root = document.documentElement
  if (mode === 'day') root.setAttribute('data-theme', 'day')
  else root.removeAttribute('data-theme')

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', mode === 'day' ? '#f4f4f2' : '#0f0f0f')
}

export function store(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // Private mode. The choice still holds for this visit.
  }
}

/** The phone's own preference, and null where it cannot be asked. */
export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

/**
 * Set up the theme and keep it in step with the phone.
 *
 * Returns a setter and an unsubscribe. Called once from the shell; the
 * listener is what makes `auto` mean "follow", rather than "match whatever it
 * was when the app opened".
 */
export function watchSystem(onChange: () => void): () => void {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  } catch {
    return () => {}
  }
}
