/**
 * Every control on every screen, in a real browser.
 *
 * Brien's requirement, verbatim: "ensure you check all the buttons and no dead
 * links". Unit tests cannot see a button that renders but goes nowhere, or a
 * link whose href is `#`, or a control that ends up 30 px tall on a phone. So
 * this walks the built app across the device classes it is used on, enumerates
 * every button, link and select, and asserts the things that would ship broken:
 *
 *   dead        a link with no href, `#`, or `javascript:`
 *   unnamed     a control with no accessible name — unreachable by voice or
 *               screen reader, and unlabelled in a screenshot
 *   small       under 44x44 on a touch screen (Apple's floor; Material's is 48)
 *   overlap     two controls drawn on top of each other, so both are unreadable
 *   spill       text wider than its own box with nothing clipping it, so it
 *               paints over its neighbour
 *   overflow    the page scrolls sideways, or something escapes the right edge
 *   dead        clicking a control produces no request, no navigation and no
 *               visible change, so it looks live and is not
 *   crash       clicking a control throws, or logs an error
 *
 * It clicks everything that is safe to click. Anything that would spend money,
 * push to TikTok or delete a variation is named in DESTRUCTIVE and checked for
 * shape only — an audit that lists 200 products on a live shop is not an audit.
 *
 *   node tools/ui-audit.mjs           every device
 *   node tools/ui-audit.mjs --shots   and write screenshots to dist/ui-audit
 */
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const SHOTS = process.argv.includes('--shots')
const OUT = new URL('../dist/ui-audit', import.meta.url).pathname
if (SHOTS) fs.mkdirSync(OUT, { recursive: true })

const DIST = new URL('../dist', import.meta.url).pathname
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png' }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  let file = path.join(DIST, url === '/' ? 'index.html' : url)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(4178, r))

/** A session token the app will accept: base64url payload, 12 hours out. */
const session = (() => {
  const body = Buffer.from(JSON.stringify({ e: 'brienchua@sheldonglobal.com', n: 'Brien Chua', x: Date.now() + 12 * 3600_000 })).toString('base64url')
  return `${body}.stub`
})()

const LINKS = {
  sheet: 'https://docs.google.com/spreadsheets/d/SHEET/edit',
  log: 'https://docs.google.com/spreadsheets/d/SHEET/edit#gid=0',
  exports: 'https://drive.google.com/drive/folders/EXPORTS',
  photos: 'https://drive.google.com/drive/folders/PHOTOS',
  root: 'https://drive.google.com/drive/folders/ROOT',
}

const variant = (over = {}) => ({
  identifier: 'A1', variant: 'A1 Ceramic Serving Bowl', price: '18.90', status: 'pushed',
  external: false, tiktok_sku_id: '9001', image_url: '', created_at: '2026-09-07T01:00:00Z',
  created_by: 'Brien Chua', on_tiktok: true, under_review: false, unaccounted: false,
  removed: false, stock_set: 50, stock_available: 48, sold: 2, cancelled: 0, ...over,
})

/** The backend, as far as the app can tell. Keyed by `?action=`. */
const REPLIES = {
  ping: { ok: true, time: '2026-09-07T04:00:00Z' },
  whoami: {
    email: 'brienchua@sheldonglobal.com', name: 'Brien Chua', role: 'admin',
    approved: true, admin: true, session_token: session,
    session_expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(), links: LINKS,
  },
  shops: [
    { shop_id: 'HZ', brand: 'HOUZE', tiktok_handle: '@houze.com.sg', entity: 'Sheldon Global Pte Ltd', shop_cipher: 'c', authorised: true, daily_listing_cap: 1000, listings_used_today: 12 },
    { shop_id: 'TM', brand: 'Table Matters', tiktok_handle: '@tablematterssg', entity: 'Audrey Global Pte Ltd', shop_cipher: 'c', authorised: true, daily_listing_cap: 1000, listings_used_today: 0 },
  ],
  listings: [
    { listing_id: '1734903629786286062', shop_id: 'HZ', brand: 'HOUZE', product_name: 'HOUZE x Table Matters - I12 Clearance Sale', supplier: 'Katrin BJ', created_at: '2026-09-06T06:43:29Z' },
    { listing_id: '1734901671510509550', shop_id: 'HZ', brand: 'HOUZE', product_name: 'Table Matters - Assorted 7-inch Ramen Bowl', supplier: null, created_at: '2026-09-04T02:00:00Z' },
  ],
  skus: [{ seller_sku: 'A1', title: 'Ceramic Serving Bowl White Glaze' }],
  allowance: { used: 88, cap: 1000, remaining: 912, tracked: true },
  listingState: {
    listing_id: '1734903629786286062', title: 'HOUZE x Table Matters - I12 Clearance Sale',
    product_status: 'ACTIVATE', audit_reasons: [], variations_on_tiktok: 3, max_skus: 100,
    checked_at: new Date().toISOString(),
    variants: [
      variant(),
      variant({ identifier: 'L11', variant: 'L11 Chrome Trolley', tiktok_sku_id: '9002', created_by: 'Judy', created_at: '2026-09-07T05:50:00Z' }),
      variant({ identifier: '', variant: 'Diatomite Absorbent Mat', external: true, tiktok_sku_id: '9003', created_at: '', created_by: '', stock_set: null, sold: null }),
      // Sold out, so the red label renders and gets audited.
      variant({ identifier: 'L12', variant: 'L12 Rattan Basket Large', tiktok_sku_id: '9004', created_by: 'Liz Liu', created_at: '2026-09-07T05:55:00Z', stock_set: 2, stock_available: 0, sold: 2 }),
      // Removed, so the second tab exists and its button is clicked.
      variant({ identifier: 'B1', variant: 'B1 Oval Storage Ottoman', tiktok_sku_id: '9005', created_by: 'Liz Liu', created_at: '2026-09-07T00:30:00Z', on_tiktok: false, removed: true, stock_available: 0, sold: null }),
    ],
  },
  orderSummary: {
    from: '2026-09-04 00:00', to: '2026-09-07 23:59', total_orders: 50, total_units: 59, total_revenue: 2394.05,
    listings: [
      { listing_id: '1734903629786286062', product_name: 'HOUZE x Table Matters - I12 Clearance Sale', order_count: 43, units: 50, unsold_units: 7, revenue: 2114.75, latest_order_sgt: '2026-09-04 14:48' },
      { listing_id: '1734901671510509550', product_name: 'Table Matters - Assorted 7-inch Ramen Bowl', order_count: 1, units: 1, unsold_units: 0, revenue: 9.79, latest_order_sgt: '2026-09-04 15:22' },
    ],
  },
  listingOrders: {
    listing_id: '1734903629786286062', from: '2026-09-04 00:00', to: '2026-09-07 23:59',
    order_count: 43, total_units: 50, total_revenue: 2114.75,
    variations: [{ sku_id: '1', seller_sku: 'F20', variation: 'F20-Segretto cast iron RED', sku_image: '', units: 8, unsold_units: 1, revenue: 696, price: '87' }],
  },
  syncOrders: { orders: 50, items: 59, from: '2026-09-04', to: '2026-09-07' },
  users: [
    { email: 'brienchua@sheldonglobal.com', name: 'Brien Chua', role: 'admin', first_seen: '2026-09-05T03:57:15Z', last_seen: '2026-09-07T04:56:09Z', approved_by: 'system', note: 'Seeded owner' },
    { email: 'judy@sheldonglobal.com', name: 'Judy', role: 'pending', first_seen: '2026-09-07T05:00:00Z', last_seen: '2026-09-07T05:00:00Z', approved_by: '', note: 'Awaiting approval' },
    // A row whose role can actually be changed. Without one the only user in
    // the list was the owner, whose current role is the disabled segment and
    // whose other two are refused by the backend anyway, so the audit pressed
    // nothing that a real admin presses.
    { email: 'liz@sheldonglobal.com', name: 'Liz Liu', role: 'lister', first_seen: '2026-09-06T01:00:00Z', last_seen: '2026-09-07T04:00:00Z', approved_by: 'brienchua@sheldonglobal.com', note: '' },
    // Role recorded with a capital letter, as a person typing in the Sheet
    // writes it. The backend lowercases before comparing; the app did not.
    { email: 'franze@sheldonglobal.com', name: 'Franze.S', role: 'Lister', first_seen: '2026-09-06T02:00:00Z', last_seen: '2026-09-07T03:00:00Z', approved_by: 'brienchua@sheldonglobal.com', note: '' },
  ],
  setRole: { email: 'judy@sheldonglobal.com', role: 'lister' },
  tiktokProducts: { products: [{ id: '1734903629786286062', title: 'HOUZE x Table Matters - I12 Clearance Sale', status: 'ACTIVATE', sku_count: 3 }], next_page_token: '' },
  exportOrders: { url: 'https://docs.google.com/x', name: 'HOUZE - Purchase order.xlsx', folder: 'Exports/2026/2026-09/2026-09-07', folder_url: LINKS.exports, listings: 2, units: 59, revenue: 2394.05, cost_divisor: 1.6, photos_placed: 25, photos_missing: 0 },
}

/**
 * Controls we look at but never click.
 *
 * Not because they are broken — because clicking them in an audit would push a
 * SKU to a live shop, delete a variation buyers can see, or take the camera.
 * Their shape, name and size are still checked.
 */
const DESTRUCTIVE = [
  /^list /i, /^remove/i, /^delete/i, /^sign out$/i, /^camera$/i, /^voice$/i, /^take$/i,
  /^photos$/i, /^ai name$/i,
  /^export purchase order$/i, /^start continuation/i, /^retry/i, /^bulk add$/i,
]
const isDestructive = (name) => DESTRUCTIVE.some((re) => re.test(name.trim()))

/**
 * Controls for which "nothing happened" is the correct outcome.
 *
 * Kept deliberately short. Every entry here is a control the dead-button check
 * cannot judge, and each one is a place a real dead button could hide, so a
 * name goes in only with a reason.
 */
const INERT = [
  // Dismisses a banner that may not be showing on this device.
  /^dismiss$/i,
  // The tab you are already on. Pressing it is a no-op by design and the app
  // is right not to redraw. Handled by name rather than by `aria-current`
  // because the router marks the active link, not the button.
  /^listing$/i, /^orders$/i, /^more$/i,
]

const DEVICES = [
  { name: 'iPhone SE',        width: 375,  height: 667,  dpr: 2,   touch: true },
  { name: 'iPhone 15',        width: 393,  height: 852,  dpr: 3,   touch: true },
  { name: 'Pixel 8',          width: 412,  height: 915,  dpr: 2.6, touch: true },
  { name: 'iPad Pro 11',      width: 834,  height: 1194, dpr: 2,   touch: true },
  { name: 'iPad Pro 11 land', width: 1194, height: 834,  dpr: 2,   touch: true },
]

/** The screens, and how to get to each one. */
const SCREENS = [
  { id: 'listing-picker', path: '/live-listing', setup: async () => {} },
  {
    id: 'listing-detail',
    path: '/live-listing',
    setup: async (page) => {
      const row = page.locator('text=I12 Clearance Sale').first()
      if (await row.count()) await row.click()
      await page.waitForTimeout(500)
    },
  },
  { id: 'orders', path: '/orders', setup: async (page) => page.waitForTimeout(500) },
  { id: 'more', path: '/more', setup: async (page) => page.waitForTimeout(300) },
  { id: 'more-users', path: '/more/users', setup: async (page) => page.waitForTimeout(300) },
  { id: 'more-about', path: '/more/about', setup: async (page) => page.waitForTimeout(300) },
]

/** Enumerate every visible control and report what is wrong with it. */
const INSPECT = () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01
  }
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim()

  const controls = []
  const controlEls = []
  const dead = []
  const unnamed = []
  const small = []

  for (const el of document.querySelectorAll('button, a, select, [role="button"]')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    const name = nameOf(el)
    const tag = el.tagName.toLowerCase()
    const entry = { tag, name, w: Math.round(r.width), h: Math.round(r.height) }
    controls.push(entry)
    controlEls.push({ el, r, name })

    if (tag === 'a') {
      const href = el.getAttribute('href')
      if (!href || href === '#' || href.startsWith('javascript:')) dead.push({ ...entry, href })
    }
    // A control with no name is unusable by voice, unreadable by a screen
    // reader, and unidentifiable in a screenshot. An <a> wrapping content
    // counts as named by that content, which nameOf already picks up.
    if (!name) unnamed.push(entry)
    if (r.height < 43.5 || r.width < 43.5) small.push(entry)
  }

  /**
   * Two controls drawn on top of each other.
   *
   * The check that was missing. Adding a second tab to the listing header made
   * the row exceed 375px, and flex collapsed the text boxes below their
   * content width rather than overflowing, so "ON LISTING" and "REMOVED" were
   * painted over one another. Nothing escaped the right edge and nothing
   * scrolled sideways, so every existing check passed and only a screenshot
   * showed it.
   *
   * Two things are legitimately allowed to overlap and are excluded:
   *
   *   Nesting — a button inside a label, an icon inside a button.
   *   Different layers — a fixed bottom bar is SUPPOSED to sit over the page
   *     content scrolling beneath it. Comparing across layers reported the
   *     List button over every row behind it, which is the design working.
   *
   * So a fault is two controls in the SAME layer, neither containing the
   * other, still sharing pixels. The 4px floor allows for a shared border.
   */
  const layerOf = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position
      if (pos === 'fixed' || pos === 'sticky') return n
    }
    return null
  }
  const overlapping = []
  for (let i = 0; i < controlEls.length; i++) {
    for (let j = i + 1; j < controlEls.length; j++) {
      const a = controlEls[i], b = controlEls[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      if (layerOf(a.el) !== layerOf(b.el)) continue
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (w > 4 && h > 4) {
        overlapping.push({
          a: a.name || `<${a.el.tagName.toLowerCase()}>`,
          b: b.name || `<${b.el.tagName.toLowerCase()}>`,
          by: `${Math.round(w)}x${Math.round(h)}px`,
        })
      }
    }
  }

  /**
   * Text painted outside the box it belongs to.
   *
   * This is what actually went wrong, and why the overlap check above did not
   * see it: flex shrank the two tab buttons below their content width, so the
   * BUTTON rectangles stayed neatly side by side while the WORDS inside them
   * spilled out and drew over each other. "ON LISTING" and "REMOVED" were
   * illegible; every rectangle-based check passed.
   *
   * An element whose content is wider than its box is only a fault when
   * nothing clips it. With `overflow: hidden` or a truncate rule the text is
   * cut off, which is ugly but honest and readable. With `overflow: visible`
   * it is painted over whatever is next to it.
   */
  const spilling = []
  for (const el of document.querySelectorAll('button, a, select, [role="button"], span, p, h1, h2, h3, label')) {
    if (!visible(el)) continue
    const over = el.scrollWidth - el.clientWidth
    if (over <= 1) continue
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'visible') continue
    // A one-line box with no wrapping is the shape that spills sideways.
    // Something set to wrap is taller than its content, not wider.
    if (cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre') continue
    spilling.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32),
      by: Math.round(over),
      box: Math.round(el.clientWidth),
    })
  }

  const doc = document.documentElement
  const escaped = []
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > window.innerWidth + 1) {
      escaped.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), right: Math.round(r.right) })
    }
  }
  return { controls, dead, unnamed, small, overlapping: overlapping.slice(0, 4), spilling: spilling.slice(0, 4), escaped: escaped.slice(0, 4), overflow: doc.scrollWidth - window.innerWidth }
}

/**
 * Content a fixed bottom bar hides and scrolling cannot free.
 *
 * The shell pads the page by the tab bar's height. A screen that adds a second
 * fixed bar above it — the List button, the export bar — eats another ~56px
 * that nothing accounts for, so at maximum scroll the last row of the page
 * still sits under it and can never be read. On the listing screen that is the
 * newest variation in the queue, which is the row that matters most.
 *
 * Scrolls to the bottom, finds the highest bar pinned to the viewport floor,
 * and reports any text the bar covers there. Static analysis cannot see this
 * and a screenshot only shows it if someone looks closely.
 */
const TRAPPED = () => {
  const el = document.scrollingElement || document.documentElement
  el.scrollTop = el.scrollHeight

  // Every wide fixed bar in the lower part of the viewport — not just the one
  // touching the floor. The bug this exists to catch is precisely a *second*
  // bar stacked above the tab bar, so a floor-only test would miss it.
  const bars = []
  for (const node of document.querySelectorAll('*')) {
    if (getComputedStyle(node).position !== 'fixed') continue
    const r = node.getBoundingClientRect()
    if (r.height === 0 || r.width < window.innerWidth * 0.5) continue
    if (r.bottom < window.innerHeight * 0.6) continue
    // A full-height overlay is a sheet, not a bar; it is meant to cover.
    if (r.height > window.innerHeight * 0.5) continue
    bars.push({ node, top: r.top })
  }
  if (bars.length === 0) return { barTop: null, trapped: [] }
  const barTop = Math.min(...bars.map((b) => b.top))
  const inBar = (node) => bars.some((b) => b.node.contains(node))

  // Leaf text only: a container's box may legitimately extend under a bar as
  // long as nothing readable sits down there.
  const trapped = []
  for (const node of document.querySelectorAll('p, span, h1, h2, h3, td, th, li, label, button, a, div')) {
    if (node.children.length > 0) continue
    const text = (node.textContent || '').trim()
    if (!text) continue
    if (inBar(node)) continue
    if (getComputedStyle(node).visibility === 'hidden') continue
    const r = node.getBoundingClientRect()
    if (r.height === 0 || r.width === 0) continue
    // Above the bar, or scrolled off the top: either way not trapped.
    if (r.bottom <= barTop + 1 || r.top >= window.innerHeight) continue
    trapped.push({ text: text.slice(0, 40), bottom: Math.round(r.bottom) })
  }
  return { barTop: Math.round(barTop), trapped: trapped.slice(0, 3) }
}

let failures = 0
let clicked = 0
let checked = 0
const seenControls = new Set()

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

for (const theme of ['dark', 'day']) {
  for (const device of DEVICES) {
    // Only sweep every device in dark; day is about colour, not layout, so one
    // phone and one tablet prove it without quintupling the run.
    if (theme === 'day' && !['iPhone 15', 'iPad Pro 11 land'].includes(device.name)) continue

    for (const screen of SCREENS) {
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.dpr,
        hasTouch: device.touch,
        isMobile: device.touch,
      })

      // Every backend action the page asked for, in order. Used to tell a
      // control that DID something from one that merely looked like it might.
      const asked = []

      // The backend, and only the backend. Anything else the page reaches for
      // is a finding in itself, so it is left to fail loudly.
      await context.route('**script.google.com/**', (route) => {
        const url = new URL(route.request().url())
        const action = url.searchParams.get('action') ?? ''
        asked.push(action)
        const body = REPLIES[action]
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body === undefined ? { _status: 400, error: `audit: no mock for "${action}"` } : body),
        })
      })
      await context.addInitScript(
        ([tok, mode]) => {
          localStorage.setItem('tikshop.session', tok)
          localStorage.setItem('tikshop.shop', 'HZ')
          localStorage.setItem('tikshop.theme', mode)
        },
        [session, theme],
      )

      const page = await context.newPage()
      const noise = []
      page.on('console', (m) => {
        if (m.type() !== 'error') return
        const text = m.text()
        // Google Identity Services is not loaded in the audit, and the service
        // worker has no origin to register against. Neither is the app.
        if (/gsi|accounts\.google|service ?worker|Failed to load resource/i.test(text)) return
        noise.push(text)
      })
      page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`))

      await page.goto(`http://localhost:4178${screen.path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(250)
      await screen.setup(page)

      // The screenshot is taken here, before anything is clicked. Taken
      // after the sweep it shows whatever the last click left behind — a
      // day-mode run screenshotted in dark because the sweep pressed the
      // theme buttons. A shot of the screen as it loads is the reviewable one.
      if (SHOTS) await page.screenshot({ path: `${OUT}/${theme}-${device.name.replace(/\s+/g, '-')}-${screen.id}.png` })

      const label = `${theme}/${device.name}/${screen.id}`
      const report = await page.evaluate(INSPECT)
      checked += report.controls.length
      report.controls.forEach((c) => seenControls.add(`${screen.id}:${c.name || '(unnamed)'}`))

      const issues = []
      // A screen with nothing on it means the app never rendered — which is
      // exactly the kind of silence an audit must not report as a pass.
      if (report.controls.length === 0) issues.push('no controls rendered at all — the screen did not load')
      if (report.overflow > 0) issues.push(`page scrolls sideways by ${report.overflow}px`)
      report.escaped.forEach((e) => issues.push(`escapes right edge: <${e.tag}> ${e.cls} → ${e.right}px`))
      report.dead.forEach((d) => issues.push(`dead link: "${d.name}" href=${JSON.stringify(d.href)}`))
      report.unnamed.forEach((u) => issues.push(`unnamed ${u.tag} ${u.w}x${u.h}`))
      report.overlapping.forEach((o) => issues.push(`controls drawn over each other: "${o.a}" and "${o.b}" share ${o.by}`))
      report.spilling.forEach((t) => issues.push(`text painted outside its box, nothing clipping it: <${t.tag}> "${t.text}" needs ${t.by}px more than its ${t.box}px`))
      if (device.touch) report.small.forEach((s) => issues.push(`small target: <${s.tag}> "${s.name}" ${s.w}x${s.h}`))

      // Scroll to the bottom and check nothing readable is stranded under a
      // fixed bar. Done after the screenshot so the shot is of the top.
      const cover = await page.evaluate(TRAPPED)
      cover.trapped.forEach((t) =>
        issues.push(`hidden behind the bottom bar at full scroll: "${t.text}" (bottom ${t.bottom}px, bar top ${cover.barTop}px)`),
      )
      await page.evaluate(() => { (document.scrollingElement || document.documentElement).scrollTop = 0 })

      // Click everything safe, and require the app to survive it.
      const buttons = await page.locator('button:visible').all()
      for (const button of buttons) {
        const name = ((await button.getAttribute('aria-label')) || (await button.textContent()) || '').trim()
        if (!name || isDestructive(name)) continue
        // A control that an earlier click navigated away from is not a
        // finding — it is gone because the app did what it was asked. Only
        // something still on the page and still unclickable is a problem.
        if (!(await button.isVisible().catch(() => false))) continue
        // A disabled control is a deliberate state, not a fault. The segment
        // showing someone's CURRENT role is disabled precisely so it cannot be
        // set to what it already is; clicking it waits for it to become
        // enabled and times out, which reported the Users screen as broken
        // when it was working. Its shape is still checked above.
        if (await button.isDisabled().catch(() => false)) continue
        try {
          /**
           * What the page looks like, cheaply, so a click can be shown to have
           * changed something.
           *
           * The check this enables is the one that was missing when Brien
           * reported that he could not change anyone's role: every control on
           * that screen rendered, was named, was big enough and survived a
           * click, so the audit passed it. A control that produces no request,
           * no navigation and no change on screen is a dead button, and until
           * now nothing looked for one.
           */
          const signature = async () =>
            page.evaluate(() => {
              const root = document.documentElement
              return [
                location.pathname,
                document.body.innerHTML.length,
                // WHICH controls are pressed, not how many. A segmented
                // control moving its selection keeps the count at one, so a
                // count reported the theme buttons as dead when they worked.
                [...document.querySelectorAll('[aria-pressed]')]
                  .map((el) => el.getAttribute('aria-pressed'))
                  .join(''),
                [...document.querySelectorAll('button')].map((b) => (b.disabled ? '1' : '0')).join(''),
                document.querySelectorAll('[role="dialog"], .fixed').length,
                // Theme lives on the root element, outside the body entirely.
                root.getAttribute('data-theme') ?? '',
                root.className,
              ].join('|')
            })
          const askedBefore = asked.length
          const before = await signature()
          // A control already in its selected state is SUPPOSED to do nothing:
          // the tab you are on, the theme already applied, the role somebody
          // already has. Read from the element rather than from a list of
          // names, so every segmented control is covered and none is excused
          // by accident.
          const alreadyOn = (await button.getAttribute('aria-pressed')) === 'true'

          await button.click({ timeout: 1500, trial: false })
          clicked++
          await page.waitForTimeout(120)
          // A click must not blank the screen or strand the person: something
          // is always on the page, and a way back always exists.
          const alive = await page.locator('body *:visible').count()
          if (alive < 3) issues.push(`clicking "${name}" emptied the screen`)

          // Give an in-flight request a moment to land before judging.
          if (asked.length === askedBefore) await page.waitForTimeout(250)
          const after = await signature()
          if (asked.length === askedBefore && after === before && !alreadyOn && !INERT.some((re) => re.test(name.trim()))) {
            issues.push(`clicking "${name}" did nothing: no request, no navigation, nothing changed on screen`)
          }

          await page.keyboard.press('Escape').catch(() => {})
          await page.waitForTimeout(60)
        } catch (e) {
          const gone = (await button.count().catch(() => 0)) === 0 || !(await button.isVisible().catch(() => false))
          if (gone) continue
          issues.push(`clicking "${name}" failed: ${String(e).split('\n')[0].slice(0, 90)}`)
        }
      }
      noise.forEach((n) => issues.push(`console error: ${n.slice(0, 110)}`))

      if (issues.length) {
        failures += issues.length
        console.log(`FAIL ${label}`)
        issues.slice(0, 10).forEach((i) => console.log(`       ${i}`))
      } else {
        console.log(`ok   ${label}  (${report.controls.length} controls)`)
      }
      await context.close()
    }
  }
}

await browser.close()
server.close()

console.log(`\n${checked} control renders inspected, ${clicked} clicked, ${seenControls.size} distinct controls`)
console.log(
  failures === 0
    ? 'No dead links, unnamed or undersized controls, no overlap or spilled text, nothing hidden behind a bottom bar, and nothing broke on click.'
    : `${failures} problems`,
)
process.exit(failures === 0 ? 0 : 1)
