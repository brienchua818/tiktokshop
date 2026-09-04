/**
 * Rasterise plate.html to PNG at 2x and to PDF.
 *
 * Run tools/plate.py first. Chromium is the renderer because the plate is
 * SVG plus real webfonts, and this is the environment where those agree.
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..')
const W = 1600, H = 2263

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.goto(`file://${path.join(HERE, 'plate.html')}`, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(500)

await page.screenshot({ path: path.join(OUT, 'Reach Cartography — Plate I.png') })
await page.pdf({
  path: path.join(OUT, 'Reach Cartography — Plate I.pdf'),
  width: `${W}px`, height: `${H}px`, printBackground: true,
})
await browser.close()
console.log('rendered PNG (2x) and PDF')
