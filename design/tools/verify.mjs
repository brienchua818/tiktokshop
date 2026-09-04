/**
 * The plate must not spill, and no two pieces of type may touch.
 *
 * Measured in the browser rather than trusted from the generator's arithmetic,
 * because arithmetic about type is not the same as type. This caught six
 * stratum labels breaking the left margin, and the two title lines' boxes
 * overlapping by 7px — neither visible at a glance, both the kind of flaw that
 * only shows up once something is printed.
 *
 * Exits non-zero on any finding, so it can gate a render.
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const W = 1600, H = 2263, M = 96

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.goto(`file://${path.join(HERE, 'plate.html')}`, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(400)

const report = await page.evaluate(({ W, H, M }) => {
  const bad = []
  const texts = []
  for (const el of document.querySelectorAll('text, rect:not(:first-of-type), path, circle, line')) {
    const b = el.getBoundingClientRect()
    if (b.width === 0 && b.height === 0) continue
    const over = []
    if (b.left < M - 1) over.push(`left ${Math.round(b.left)}`)
    if (b.right > W - M + 1) over.push(`right ${Math.round(b.right)}`)
    if (b.top < 0) over.push(`top ${Math.round(b.top)}`)
    if (b.bottom > H) over.push(`bottom ${Math.round(b.bottom)}`)
    if (over.length) {
      bad.push({ tag: el.tagName, cls: el.getAttribute('class') || '',
                 text: (el.textContent || '').slice(0, 30), over: over.join(', ') })
    }
    if (el.tagName === 'text') texts.push({ t: el.textContent.slice(0, 28), ...b.toJSON() })
  }
  const clashes = []
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j]
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (ox > 2 && oy > 2) clashes.push(`"${a.t}" × "${b.t}"`)
    }
  }
  return { bad: bad.slice(0, 12), badCount: bad.length,
           clashes: clashes.slice(0, 10), clashCount: clashes.length, textCount: texts.length }
}, { W, H, M })

console.log(`elements outside the margin: ${report.badCount}`)
report.bad.forEach((b) => console.log(`  <${b.tag} class="${b.cls}"> "${b.text}" → ${b.over}`))
console.log(`overlapping text pairs: ${report.clashCount}  (of ${report.textCount} text elements)`)
report.clashes.forEach((c) => console.log(`  ${c}`))

await browser.close()
process.exit(report.badCount === 0 && report.clashCount === 0 ? 0 : 1)
