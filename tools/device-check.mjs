/**
 * Responsive check for the real built app, at the three device classes it is
 * used on.
 *
 * Not a screenshot-eyeballing exercise. It asserts the two things that actually
 * break a factory-floor app and that neither typecheck nor unit tests can see:
 *
 *   1. horizontal overflow — the page must never scroll sideways;
 *   2. touch targets — every control must be reachable with a thumb.
 */
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

// Screenshots go somewhere gitignored — they are for looking at, not keeping.
const SHOTS = new URL('../dist/device-shots', import.meta.url).pathname
fs.mkdirSync(SHOTS, { recursive: true })

// Resolved from this file, so the script works from any working directory.
const DIST = new URL('../dist', import.meta.url).pathname
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.webmanifest':'application/manifest+json' }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  let file = path.join(DIST, url === '/' ? 'index.html' : url)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(4173, r))

// Enough of the API to reach the Live Listing screen with drafts on it.
const MOCK = {
  'me': { email: 'brienchua@sheldonglobal.com', name: 'Brien Chua', picture: null },
  'shops': [
    { shop_id: 'HZ', brand: 'HOUZE', tiktok_handle: '@houze.com.sg', entity: 'Sheldon Global Pte Ltd', shop_cipher: 'c', authorised: true, daily_listing_cap: 1000, listings_used_today: 12 },
    { shop_id: 'TM', brand: 'Table Matters', tiktok_handle: '@tablematterssg', entity: 'Audrey Global Pte Ltd', shop_cipher: 'c', authorised: true, daily_listing_cap: 1000, listings_used_today: 0 },
    { shop_id: 'PM', brand: 'Painting Matters', tiktok_handle: '@paintingmatters', entity: null, shop_cipher: 'c', authorised: false, daily_listing_cap: 100, listings_used_today: 0 },
  ],
  'listings': [
    { listing_id: '1729592969712207008', shop_id: 'HZ', product_name: 'Katrin BJ — ceramic run', supplier: 'Katrin BJ', default_weight_kg: '1', created_at: '2026-09-04T02:00:00Z' },
    { listing_id: '1729592969712207009', shop_id: 'HZ', product_name: 'Chaozhou glassware', supplier: null, default_weight_kg: '1', created_at: '2026-09-03T02:00:00Z' },
  ],
  'listed-skus': [{ seller_sku: 'A1', title: 'Ceramic Serving Bowl White Glaze' }, { seller_sku: 'A2', title: 'Ceramic Side Plate Reactive Glaze' }],
  'allowance': { used: 88, cap: 100, remaining: 12, tracked: true },
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

const DEVICES = [
  { name: 'iPhone 15 portrait',      width: 393,  height: 852,  dpr: 3, touch: true },
  { name: 'iPhone SE portrait',      width: 375,  height: 667,  dpr: 2, touch: true },
  { name: 'Pixel 8 portrait',        width: 412,  height: 915,  dpr: 2.6, touch: true },
  { name: 'iPhone 15 landscape',     width: 852,  height: 393,  dpr: 3, touch: true },
  { name: 'iPad mini portrait',      width: 744,  height: 1133, dpr: 2, touch: true },
  { name: 'iPad Pro 11 portrait',    width: 834,  height: 1194, dpr: 2, touch: true },
  { name: 'iPad Pro 11 landscape',   width: 1194, height: 834,  dpr: 2, touch: true },
  { name: 'iPad Pro 12.9 landscape', width: 1366, height: 1024, dpr: 2, touch: true },
]

let problems = 0
for (const d of DEVICES) {
  const context = await browser.newContext({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.dpr,
    hasTouch: d.touch,
    isMobile: d.touch,
  })
  await context.route('**/api/**', (route) => {
    const key = route.request().url().split('/api/')[1].split('?')[0]
    const body = MOCK[key] ?? {}
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  const page = await context.newPage()
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })

  // Into a stream, which is where the app actually lives during a broadcast.
  const stream = page.locator('text=Katrin BJ — ceramic run').first()
  if (await stream.count()) { await stream.click(); await page.waitForTimeout(400) }

  const report = await page.evaluate(() => {
    const doc = document.documentElement
    const overflow = doc.scrollWidth - window.innerWidth
    const small = []
    for (const el of document.querySelectorAll('button, select, input, [role="button"], a')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue          // hidden
      if (getComputedStyle(el).display === 'none') continue
      if (r.height < 44 || r.width < 44) {
        small.push({
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 34),
          w: Math.round(r.width), h: Math.round(r.height),
        })
      }
    }
    // Anything sticking out past the right edge is a layout escape.
    const escaped = []
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > window.innerWidth + 1) {
        escaped.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 44), right: Math.round(r.right) })
      }
    }
    const cols = document.querySelector('.listing-columns')
    return {
      overflow,
      small,
      escaped: escaped.slice(0, 5),
      twoColumn: cols ? getComputedStyle(cols).gridTemplateColumns.split(' ').length === 2 : null,
    }
  })

  const ok = report.overflow <= 0 && report.small.length === 0 && report.escaped.length === 0
  if (!ok) problems++
  console.log(`\n${ok ? 'OK  ' : 'FAIL'} ${d.name}  ${d.width}x${d.height}`)
  if (report.overflow > 0) console.log(`       horizontal overflow: ${report.overflow}px`)
  if (report.escaped.length) report.escaped.forEach((e) => console.log(`       escapes right edge: <${e.tag}> ${e.cls} → ${e.right}px`))
  if (report.small.length) report.small.slice(0, 8).forEach((s) => console.log(`       small target: <${s.tag}> "${s.label}" ${s.w}x${s.h}`))
  if (report.twoColumn !== null) console.log(`       layout: ${report.twoColumn ? 'two columns' : 'one column'}`)

  await page.screenshot({ path: `${SHOTS}/${d.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`, fullPage: false })
  await context.close()
}

await browser.close()
server.close()
console.log(`\n${DEVICES.length - problems}/${DEVICES.length} device classes clean\n`)
process.exit(problems ? 1 : 0)
