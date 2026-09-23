/**
 * How long until the app is usable, against a backend that is having a bad day.
 *
 * Brien, 23 Sep: "I tried just logging into the app just now and it took
 * 1 minute to just enter the app." Measured against the live deployment the
 * same day, `ping` — which touches no Sheet, no network and no auth — took
 * 1.5s at best and 11-31s at worst. That spike is Google's, not ours, and no
 * amount of code tidying removes it. What CAN be removed is the app waiting
 * for it.
 *
 * This serves the real built app and answers every backend call after a
 * deliberate delay, then times how long until the listing screen can be used.
 * Two cases, and both must hold:
 *
 *   REMEMBERED  a phone signed in earlier today. The backend is made SLOW
 *               (whoami and shops take 20s each). The app must be usable in
 *               under three seconds anyway, because it no longer waits.
 *
 *   FIRST RUN   nothing remembered. The app is ALLOWED to wait here — it has
 *               nothing to show — and this case exists to prove the harness
 *               can measure a slow start at all. A speed test that cannot
 *               fail is decoration.
 *
 * Run after `npm run build:audit`.
 */
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 4179
const DIST = new URL('../dist', import.meta.url).pathname
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }

const SLOW_MS = 20_000
const BUDGET_MS = 3_000
/** A cold-start hang, longer than any single attempt is allowed to wait. */
const SPIKE_MS = 30_000
/** First sign-in through one spike per gating call. Was ~52s; must now be well under. */
const SPIKE_BUDGET_MS = 25_000

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  let file = path.join(DIST, url === '/' ? 'index.html' : url)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(PORT, r))

const session = (() => {
  const body = Buffer.from(JSON.stringify({ e: 'brienchua@sheldonglobal.com', n: 'Brien Chua', x: Date.now() + 12 * 3600_000 })).toString('base64url')
  return `${body}.stub`
})()

const ME = {
  email: 'brienchua@sheldonglobal.com', name: 'Brien Chua', picture: null, role: 'admin',
  approved: true, admin: true,
}
const SHOPS = [
  { shop_id: 'HZ', brand: 'HOUZE', tiktok_handle: '@houze.com.sg', entity: 'Sheldon Global Pte Ltd', shop_cipher: 'c', authorised: true, daily_listing_cap: 1000, listings_used_today: 12 },
]
const REPLIES = {
  whoami: { ...ME, session_token: session, session_expires_at: new Date(Date.now() + 12 * 3600_000).toISOString() },
  shops: SHOPS,
  listings: [{ listing_id: '1734903629786286062', shop_id: 'HZ', brand: 'HOUZE', product_name: 'HOUZE x Table Matters - I12 Clearance Sale', supplier: 'Katrin BJ', created_at: '2026-09-06T06:43:29Z' }],
  allowance: { used: 12, cap: 1000, remaining: 988, tracked: true },
  skus: [],
}

/** The calls that used to gate the app, made deliberately slow. */
const SLOW = new Set(['whoami', 'shops'])

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

async function timeToUsable({ remembered, spike = false }) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true })
  const seen = {}
  await context.route('**script.google.com/**', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action') ?? ''
    seen[action] = (seen[action] || 0) + 1
    if (spike) {
      // Google's spike: the FIRST request for each gating call hangs, as a
      // cold start does, and a fresh one lands at once. Independent draws,
      // which is what the live measurements show.
      if (SLOW.has(action) && seen[action] === 1) await new Promise((r) => setTimeout(r, SPIKE_MS))
    } else if (SLOW.has(action)) {
      await new Promise((r) => setTimeout(r, SLOW_MS))
    }
    const body = REPLIES[action]
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(body === undefined ? { _status: 200 } : body),
    }).catch(() => {})
  })
  await context.addInitScript(
    ([tok, me, shops, withMemory]) => {
      localStorage.setItem('tikshop.session', tok)
      localStorage.setItem('tikshop.shop', 'HZ')
      if (withMemory) {
        localStorage.setItem('tikshop.boot', JSON.stringify({ session: tok, me, shops, savedAt: Date.now() }))
      } else {
        localStorage.removeItem('tikshop.boot')
      }
    },
    [session, ME, SHOPS, remembered],
  )

  const page = await context.newPage()
  const t0 = Date.now()
  await page.goto(`http://localhost:${PORT}/live-listing`)
  // Usable = the listing screen for the shop is on screen, not the sign-in
  // screen and not the "checking your session" placeholder.
  let usable = -1
  try {
    await page.waitForSelector('text=I12 Clearance Sale', { timeout: SLOW_MS * 2 + 10_000 })
    usable = Date.now() - t0
  } catch {
    usable = -1
  }
  await context.close()
  return usable
}

/**
 * The same as REMEMBERED, but nothing is planted: the app must write its own
 * memory on a normal visit, and the NEXT visit must open on it. The case
 * above seeds `tikshop.boot` by hand, so it passed with the app's two writes
 * deleted — every real phone would have waited forty seconds on every launch
 * while this said "clean". Found by the speed review, 23 Sep.
 */
async function roundTrip() {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true })
  let slow = false
  await context.route('**script.google.com/**', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action') ?? ''
    if (slow && SLOW.has(action)) await new Promise((r) => setTimeout(r, SLOW_MS))
    const body = REPLIES[action]
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(body === undefined ? { _status: 200 } : body),
    }).catch(() => {})
  })
  await context.addInitScript((tok) => {
    // Only when missing, so the reload keeps whatever the app itself stored.
    if (!localStorage.getItem('tikshop.session')) localStorage.setItem('tikshop.session', tok)
    if (!localStorage.getItem('tikshop.shop')) localStorage.setItem('tikshop.shop', 'HZ')
    if (!sessionStorage.getItem('speed.seeded')) {
      localStorage.removeItem('tikshop.boot')
      sessionStorage.setItem('speed.seeded', '1')
    }
  }, session)
  const page = await context.newPage()
  await page.goto(`http://localhost:${PORT}/live-listing`)
  await page.waitForSelector('text=I12 Clearance Sale', { timeout: 30_000 })
  // Give the background whoami/shops a moment to land and be remembered.
  await page.waitForFunction(() => {
    try { const b = JSON.parse(localStorage.getItem('tikshop.boot') || 'null'); return Boolean(b && b.me && b.shops) } catch { return false }
  }, null, { timeout: 10_000 }).catch(() => {})
  const stored = await page.evaluate(() => Boolean(localStorage.getItem('tikshop.boot')))
  slow = true
  const t0 = Date.now()
  await page.reload()
  let usable = -1
  try {
    await page.waitForSelector('text=I12 Clearance Sale', { timeout: SLOW_MS * 2 + 10_000 })
    usable = Date.now() - t0
  } catch {
    usable = -1
  }
  await context.close()
  return { usable, stored }
}

let failed = 0
function report(label, ms, ok, why) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(12)} ${ms < 0 ? 'never usable' : (ms / 1000).toFixed(2) + 's'}  ${why}`)
  if (!ok) failed++
}

const remembered = await timeToUsable({ remembered: true })
report('remembered', remembered, remembered >= 0 && remembered < BUDGET_MS,
  `backend answers in ${SLOW_MS / 1000}s; budget ${BUDGET_MS / 1000}s`)

const trip = await roundTrip()
report('round trip', trip.usable, trip.stored && trip.usable >= 0 && trip.usable < BUDGET_MS,
  `app stores its own memory (${trip.stored ? 'yes' : 'NO'}), then reopens on it against a ${SLOW_MS / 1000}s backend; budget ${BUDGET_MS / 1000}s`)

const first = await timeToUsable({ remembered: false })
report('first run', first, first >= SLOW_MS,
  `must WAIT for the backend (proves the harness can see a slow start)`)

/**
 * The case Brien actually hit: a first sign-in where Google's first reply
 * hangs. Each attempt used to wait the full 25s before retrying, so two
 * gating calls cost ~52s. Now the first attempt is abandoned at 8s and a
 * fresh one lands, so the same spike costs well under half that.
 */
const spiked = await timeToUsable({ remembered: false, spike: true })
report('spike', spiked, spiked >= 0 && spiked < SPIKE_BUDGET_MS,
  `first reply hangs ${SPIKE_MS / 1000}s, retry lands; budget ${SPIKE_BUDGET_MS / 1000}s`)

await browser.close()
server.close()

console.log(failed ? `\n${failed} speed check(s) failed\n` : '\nspeed checks clean\n')
process.exit(failed ? 1 : 0)
