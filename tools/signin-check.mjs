/**
 * The sign-in screen must offer exactly ONE way in, and must not fire One Tap.
 *
 * Google's GIS script is stubbed rather than loaded, so this asserts what the
 * app ASKS Google to do — which is the thing that changed — without depending
 * on accounts.google.com being reachable from here.
 */
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const DIST = '/home/user/tikshop/dist'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }

const server = http.createServer((req, res) => {
  let file = path.join(DIST, decodeURIComponent(req.url.split('?')[0]))
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true })

// Stub GIS before any app code runs, and record every call.
await ctx.addInitScript(() => {
  window.__gis = { initialize: 0, renderButton: 0, prompt: 0 }
  window.google = { accounts: { id: {
    initialize: () => { window.__gis.initialize++ },
    renderButton: (parent) => {
      window.__gis.renderButton++
      const b = document.createElement('button')
      b.textContent = 'Continue with Google'
      parent.appendChild(b)
    },
    prompt: () => { window.__gis.prompt++ },
    disableAutoSelect: () => {},
  } } }
})
// No credential on the device, so the app must land on sign-in.
await ctx.route('**script.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))

const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(base + '/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

const gis = await page.evaluate(() => window.__gis)
const buttons = await page.locator('button:visible, [role=button]:visible').allTextContents()

let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  ok   ' + name)
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')) }
}

check('the sign-in screen rendered', (await page.locator('text=TikShop').count()) > 0)
check('Google button was drawn', gis.renderButton === 1, JSON.stringify(gis))
check('One Tap was NOT fired', gis.prompt === 0, `prompt() called ${gis.prompt} time(s)`)
check('GIS initialised exactly once', gis.initialize === 1, JSON.stringify(gis))
check('exactly one sign-in control on screen', buttons.filter((t) => /google/i.test(t)).length === 1, JSON.stringify(buttons))
check('no page errors', errors.length === 0, errors.join('\n'))

await browser.close()
server.close()
console.log(fail ? `\n${fail} FAILED\n` : '\nsign-in screen clean\n')
process.exit(fail ? 1 : 0)
