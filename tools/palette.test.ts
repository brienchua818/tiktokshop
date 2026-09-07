// @vitest-environment node
/**
 * Guards the theme, not a component.
 *
 * Day mode works because every colour in the app resolves through a semantic
 * token (`text-fg`, `bg-raised`, `border-line`) whose value is swapped by the
 * palette. A raw Tailwind palette class — `text-cyan-400`, `bg-zinc-900` —
 * does not swap, so it renders the same in both themes and is invisible in
 * whichever one it was not written for. That is a whole class of bug, and one
 * that no rendering test catches: the app looks fine in dark and wrong in day.
 *
 * So this asserts the rule instead of the instance. Adding a hardcoded colour
 * anywhere under src/ fails here, with the file and the class named.
 *
 * `text-white` and `bg-black` are the two deliberate exceptions: ink on a
 * filled accent, voice or error button, and the camera viewfinder behind a
 * photo. Both are the same colour in both palettes by intent, so they are
 * allowed by name and nothing else is.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set(['text-white', 'bg-black'])

/** Tailwind's numbered palette scales — the ones that do not follow a theme. */
const SCALES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'

/** e.g. `text-cyan-400`, `hover:bg-zinc-800/60`, `border-pink-500` */
const RAW = new RegExp(
  `\\b(?:[a-z-]+:)*(?:text|bg|border|ring|from|via|to|fill|stroke|shadow|outline|decoration|divide|accent|caret|placeholder)-(?:${SCALES})-\\d{2,3}(?:/\\d{1,3})?\\b`,
  'g',
)

/** Bare `text-white`/`bg-black`-shaped classes, allowed only by name. */
const BARE = /\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|divide)-(?:white|black)(?:\/\d{1,3})?\b/g

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path)
  }
  return out
}

describe('palette', () => {
  it('uses no hardcoded Tailwind palette colour anywhere under src/', () => {
    const found: string[] = []
    for (const path of sources('src')) {
      // index.css is where the palettes are defined, so raw values belong there.
      if (path.endsWith('src/index.css')) continue
      const text = readFileSync(path, 'utf8')
      for (const m of text.matchAll(RAW)) found.push(`${path}: ${m[0]}`)
      for (const m of text.matchAll(BARE)) {
        const cls = m[0].replace(/^(?:[a-z-]+:)*/, '').replace(/\/\d{1,3}$/, '')
        if (!ALLOWED.has(cls)) found.push(`${path}: ${m[0]}`)
      }
    }
    expect(found).toEqual([])
  })

  it('catches a hardcoded colour when one is introduced', () => {
    // Proves the regex works rather than trusting an empty result.
    expect('className="text-cyan-400"'.match(RAW)).toEqual(['text-cyan-400'])
    expect('className="hover:bg-zinc-800/60"'.match(RAW)).toEqual(['hover:bg-zinc-800/60'])
    expect('className="text-fg2 bg-raised border-line"'.match(RAW)).toBeNull()
  })

  it('defines every --color-* token in both palettes', () => {
    const css = readFileSync('src/index.css', 'utf8')
    const tokens = [...css.matchAll(/--color-([a-z0-9-]+):\s*var\(--c-([a-z0-9-]+)\)/g)].map((m) => m[2])
    expect(tokens.length).toBeGreaterThan(20)

    const block = (selector: string) => {
      const at = css.indexOf(selector)
      expect(at, `${selector} block missing`).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('\n}', at))
    }
    const dark = block(':root {')
    const day = block(":root[data-theme='day'] {")

    const missing: string[] = []
    for (const t of tokens) {
      if (!new RegExp(`--c-${t}:`).test(dark)) missing.push(`dark: --c-${t}`)
      if (!new RegExp(`--c-${t}:`).test(day)) missing.push(`day: --c-${t}`)
    }
    expect(missing).toEqual([])
  })
})
