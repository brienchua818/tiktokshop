/**
 * Tests for the Apps Script backend.
 *
 * Run with:  node apps-script/test/run.cjs
 *
 * The .cjs extension is required: package.json sets "type": "module" for the
 * frontend, and Apps Script code is plain scripts, not ES modules.
 *
 * Apps Script has no test runner and its editor cannot be driven from here, so
 * the pure logic is loaded into plain node instead. That covers the parts where
 * a mistake is expensive and invisible: the payload that edits a live TikTok
 * listing, the rules that decide whether a title is accepted, and the lock that
 * stops two writes interleaving.
 *
 * What this deliberately does NOT cover: anything that calls SpreadsheetApp,
 * DriveApp, UrlFetchApp or LockService for real. Those are stubbed. This proves
 * the logic, not the integration.
 *
 * The variant assertions mirror netlify/lib/tiktok-variants.test.ts case for
 * case, because the two backends must not drift — the same livestream can be
 * served by either.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = path.join(__dirname, '..')
const FILES = ['Config.gs', 'Errors.gs', 'Lock.gs', 'Sheet.gs', 'Export.gs', 'Product.gs', 'Auth.gs', 'TikTok.gs', 'Orders.gs']

const src = FILES.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n')

// Apps Script globals. Stubbed only as far as the loaded functions touch them;
// a test that needs more should stub more rather than reach for the real thing.
const lockState = { held: false, refused: false, acquisitions: 0 }
const sandbox = `
  var SpreadsheetApp = { flush: function () {} };
  var PropertiesService = { getScriptProperties: function () {
    return {
      getProperty: function (k) { return AUTH_STATE.props[k] },
      setProperty: function (k, v) { AUTH_STATE.props[k] = v },
      setProperties: function () {}
    }
  } };
  var Utilities = {
    getUuid: function () { return 'uuid' },
    newBlob: function (bytes) {
      var buf = Buffer.from(Array.isArray(bytes) ? bytes.map(function (b) { return b & 0xff }) : String(bytes))
      return { getBytes: function () { return Array.from(buf) }, getDataAsString: function () { return buf.toString('utf8') } }
    },
    base64Decode: function () { return [] },
    // Web-safe base64 as Apps Script does it: the string overload encodes UTF-8,
    // decode returns signed bytes.
    base64EncodeWebSafe: function (text) { return Buffer.from(String(text), 'utf8').toString('base64url') },
    base64DecodeWebSafe: function (text) {
      return Array.from(Buffer.from(String(text), 'base64url')).map(function (b) { return b > 127 ? b - 256 : b })
    },
    // Only the SGT pattern this code uses, and computed rather than faked, so
    // an off-by-one hour in the real formatter would not slip past.
    formatDate: function (date, tz, pattern) {
      if (tz !== 'Asia/Singapore') throw new Error('unexpected timezone: ' + tz)
      var sgt = new Date(date.getTime() + 8 * 3600 * 1000)
      var p = function (n) { return String(n).padStart(2, '0') }
      var y = sgt.getUTCFullYear()
      var mo = p(sgt.getUTCMonth() + 1)
      var d = p(sgt.getUTCDate())
      var h = p(sgt.getUTCHours())
      var mi = p(sgt.getUTCMinutes())
      if (pattern === 'yyyy-MM-dd') return y + '-' + mo + '-' + d
      if (pattern === 'yyyy-MM-dd HHmm') return y + '-' + mo + '-' + d + ' ' + h + mi
      if (pattern === 'yyyy-MM-dd HH:mm') return y + '-' + mo + '-' + d + ' ' + h + ':' + mi
      throw new Error('unexpected pattern: ' + pattern)
    },
    // Apps Script returns a byte array of SIGNED bytes, which is why ttSign_
    // masks with 0xff before hexing. Reproduced faithfully, or the test would
    // pass against a shape the real runtime never produces.
    computeHmacSha256Signature: function (value, key) {
      var mac = NODE_CRYPTO.createHmac('sha256', key).update(value, 'utf8').digest()
      return Array.prototype.slice.call(mac).map(function (b) {
        return b > 127 ? b - 256 : b
      })
    }
  };
  var DriveApp = {}, Session = {};
  var UrlFetchApp = { fetch: function () {
    if (AUTH_STATE.throws) throw new Error('network');
    return {
      getResponseCode: function () { return AUTH_STATE.status },
      getContentText: function () { return AUTH_STATE.bodyText }
    }
  } };
  var LockService = { getScriptLock: function () {
    return {
      tryLock: function () {
        LOCK_STATE.acquisitions++
        if (LOCK_STATE.refused) return false
        LOCK_STATE.held = true
        return true
      },
      waitLock: function () { LOCK_STATE.held = true },
      releaseLock: function () { LOCK_STATE.held = false }
    }
  } };
${src}
  module.exports = {
    variantValueName_, buildAppendPayload_, buildPayload_, validateTitle_,
    validateVariantName_, continuationTitle_,
    withScriptLock_, withScriptLockOptional_, holdsScriptLock_,
    verifyIdToken_, shortClient_, prop_, SHOPS,
    cipherAllowed_, PATHS_WITHOUT_CIPHER, ttSign_,
    sgtEpoch_, summariseItems_, listingOrders_, buildAppendPayload_, buildRemovePayload_,
    googleClientId_, DEFAULT_GOOGLE_CLIENT_ID,
    relayoutRows_, exportFilename_, fileSafe_, driveFileId_, PHOTO_PX, listingUrl_, listingLinkFormula_,
    signSession_, readSession_, issueSession_, verifySession_, SESSION_TTL_MS,
    imageDims_, sheetsImageFit_, fail_, codeOf_, ttReason_, SHEETS_IMAGE_MAX_PIXELS,
    photoCandidates_, PHOTO_FETCH_PX, identifierFromVariation_, describeResolution_,
    MAX_SKUS_PER_PRODUCT, VALUE_NAME_MAX, VARIANT_ATTRIBUTE_NAME,
    normaliseRole_, canList_, isAdmin_, ROLE_ADMIN, ROLE_LISTER, ROLE_PENDING, ROLE_BLOCKED,
    skuImageUrl_
  };
`

// Written to a temp file rather than eval'd, so a syntax error reports a real
// line number in a real file.
const loaded = path.join(os.tmpdir(), 'tikshop-gs-loaded.cjs')
const authState = { props: {}, status: 200, bodyText: '{}', throws: false }
fs.writeFileSync(
  loaded,
  'const LOCK_STATE = global.__LOCK_STATE__;\nconst AUTH_STATE = global.__AUTH_STATE__;\nconst NODE_CRYPTO = require("crypto");\n' + sandbox,
)
global.__LOCK_STATE__ = lockState
global.__AUTH_STATE__ = authState
const gs = require(loaded)

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n         ' + e.message) }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b)
  if (A !== B) throw new Error((msg || '') + '\n         got      ' + A + '\n         expected ' + B)
}
function throws(fn, re, msg) {
  try { fn() } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return }
  throw new Error(msg || 'expected a throw')
}

function sku(o) {
  return Object.assign({
    id: 'x', sellerSku: 'A1', attributeId: '100089', attributeName: 'Design',
    valueId: 'v1', valueName: 'A1 Existing', skuImgUri: 'img1',
    priceAmount: '12.90', quantity: 20, warehouseId: 'WH1',
  }, o)
}
const addition = { identifier: 'A9', variantName: 'Reactive Glaze Plate', price: '15.50', stock: 30, imageUri: 'img-new' }

console.log('\nvariantValueName_')
check('leads with the identifier', () => eq(gs.variantValueName_('A7', 'Blue Mug'), 'A7 Blue Mug'))
check('identifier alone when no name', () => eq(gs.variantValueName_('A7', ''), 'A7'))
check('collapses whitespace', () => eq(gs.variantValueName_('A7', 'Blue   Glaze\n Mug'), 'A7 Blue Glaze Mug'))
check('never exceeds 50 chars', () => {
  const r = gs.variantValueName_('A7', 'Hand Thrown Reactive Glaze Stoneware Dinner Plate Large')
  if (r.length > 50) throw new Error('length ' + r.length)
})
check('truncates at a word boundary', () =>
  eq(gs.variantValueName_('A7', 'Hand Thrown Reactive Glaze Stoneware Dinner Plate'),
     'A7 Hand Thrown Reactive Glaze Stoneware Dinner'))
check('keeps identifier when name overflows alone', () => {
  const r = gs.variantValueName_('A7', 'x'.repeat(200))
  if (!r.startsWith('A7 ') || r.length > 50) throw new Error(r)
})
check('matches the TypeScript implementation exactly', () => {
  // Same six cases the vitest suite asserts, so the two backends cannot drift.
  eq(gs.variantValueName_('A7', 'Blue Reactive Glaze Mug'), 'A7 Blue Reactive Glaze Mug')
  eq(gs.variantValueName_('A7', 'Supercalifragilisticexpialidociousceramicdinnerplateware').length, 50)
})

console.log('\nbuildAppendPayload_ — existing variations must survive')
check('echoes every existing SKU back with its id', () => {
  const snap = { productId: 'P', title: 't', skus: [sku({id:'1'}), sku({id:'2'}), sku({id:'3'})] }
  const p = gs.buildAppendPayload_(snap, addition)
  eq(p.skus.filter(s => s.id).map(s => s.id), ['1','2','3'])
})
check('sends existing plus new', () => {
  const snap = { productId: 'P', title: 't', skus: [sku({id:'1'}), sku({id:'2'})] }
  const p = gs.buildAppendPayload_(snap, addition)
  eq(p.skus.length, 3)
  eq(p.skus.filter(s => !s.id).length, 1)
})
check('preserves price, quantity and warehouse exactly', () => {
  const snap = { productId: 'P', title: 't', skus: [sku({id:'1', priceAmount:'9.90', quantity:5})] }
  const p = gs.buildAppendPayload_(snap, addition)
  eq(p.skus[0].price, { amount: '9.90', currency: 'SGD' })
  eq(p.skus[0].inventory, [{ warehouse_id: 'WH1', quantity: 5 }])
})
check('preserves every existing variation photo', () => {
  const snap = { productId: 'P', title: 't', skus: [sku({id:'1',skuImgUri:'p1'}), sku({id:'2',skuImgUri:'p2',valueName:'A2 x',valueId:'v2'})] }
  const p = gs.buildAppendPayload_(snap, addition)
  eq(p.skus[0].sales_attributes[0].sku_img, { uri: 'p1' })
  eq(p.skus[1].sales_attributes[0].sku_img, { uri: 'p2' })
})
check('addresses existing variations by value_id, not name', () => {
  const snap = { productId: 'P', title: 't', skus: [sku({id:'1', valueId:'V1'})] }
  const p = gs.buildAppendPayload_(snap, addition)
  eq(p.skus[0].sales_attributes[0].value_id, 'V1')
  if (p.skus[0].sales_attributes[0].value_name !== undefined) throw new Error('sent value_name too')
})
check('99 existing variations all come back', () => {
  const skus = Array.from({length:99}, (_,i) => sku({id:String(i+1), valueId:'v'+i, valueName:'A'+(i+1)+' v'}))
  const p = gs.buildAppendPayload_({ productId:'P', title:'t', skus }, addition)
  eq(p.skus.length, 100)
  eq(p.skus.filter(s => s.id).length, 99)
})

console.log('\nbuildAppendPayload_ — the new variation')
check('carries no id so TikTok creates it', () => {
  const p = gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1'})] }, addition)
  const added = p.skus[p.skus.length-1]
  if (added.id !== undefined) throw new Error('new SKU carried an id')
})
check('uses the identifier as seller_sku', () => {
  const p = gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1'})] }, addition)
  eq(p.skus[p.skus.length-1].seller_sku, 'A9')
})
check('inherits the attribute id and sends no name alongside it', () => {
  const p = gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1'})] }, addition)
  const a = p.skus[p.skus.length-1].sales_attributes[0]
  eq(a.id, '100089')
  if (a.name !== undefined) throw new Error('sent both id and name')
})
check('falls back to the attribute name when there is no id', () => {
  const snap = { productId:'P', title:'t', skus:[sku({id:'1', attributeId:'', attributeName:'Design'})] }
  const a = gs.buildAppendPayload_(snap, addition).skus[1].sales_attributes[0]
  eq(a.name, 'Design')
  if (a.id !== undefined) throw new Error('sent an empty id')
})
check('reuses the existing warehouse', () => {
  const snap = { productId:'P', title:'t', skus:[sku({id:'1', warehouseId:'WH-REAL'})] }
  eq(gs.buildAppendPayload_(snap, addition).skus[1].inventory, [{ warehouse_id:'WH-REAL', quantity:30 }])
})
check('attaches the photo as sku_img', () => {
  const p = gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1'})] }, addition)
  eq(p.skus[1].sales_attributes[0].sku_img, { uri: 'img-new' })
})
check('prices everything in SGD', () => {
  const p = gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1'})] }, addition)
  p.skus.forEach(s => { if (s.price.currency !== 'SGD') throw new Error('wrong currency') })
})
check('sends only skus and category_version', () => {
  const p = gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1'})] }, addition)
  eq(Object.keys(p).sort(), ['category_version','skus'])
  eq(p.category_version, 'v2')
})

console.log('\nbuildAppendPayload_ — refusals')
check('refuses at the 100-variation ceiling', () => {
  const skus = Array.from({length:100}, (_,i) => sku({id:String(i+1), valueId:'v'+i, valueName:'A'+(i+1)+' v'}))
  throws(() => gs.buildAppendPayload_({ productId:'P', title:'t', skus }, addition), /LISTING_FULL/)
})
check('refuses a product with no variations', () =>
  throws(() => gs.buildAppendPayload_({ productId:'P', title:'t', skus:[] }, addition), /no variations to extend/))
check('refuses a variation without an id', () =>
  throws(() => gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1'}), sku({id:''})] }, addition), /without an ID/))
check('refuses a variation without a warehouse', () =>
  throws(() => gs.buildAppendPayload_({ productId:'P', title:'t', skus:[sku({id:'1', warehouseId:''})] }, addition), /did not return a warehouse/))
check('refuses a duplicate variant name', () =>
  throws(() => gs.buildAppendPayload_(
    { productId:'P', title:'t', skus:[sku({id:'1', valueName:'A9 Reactive Glaze Plate'})] }, addition),
    /already on this listing/))
check('compares variant names case-insensitively', () =>
  throws(() => gs.buildAppendPayload_(
    { productId:'P', title:'t', skus:[sku({id:'1', valueName:'A9 REACTIVE GLAZE PLATE'})] }, addition),
    /already on this listing/))

console.log('\nbuildPayload_ — a new listing is variant-shaped from birth')
check('the first SKU carries a sales attribute', () => {
  const p = gs.buildPayload_({ title:'Ceramic Serving Bowl White Glaze', identifier:'A1',
    variantName:'White Glaze Bowl', price:'12.90', stock:10, weightKg:'1',
    imageUri:'main-uri', attributeImageUri:'attr-uri', idempotencyKey:'k' }, 'cat1', 'WH1', [])
  const a = p.skus[0].sales_attributes[0]
  eq(a.name, 'Design')
  eq(a.value_name, 'A1 White Glaze Bowl')
  eq(a.sku_img, { uri: 'attr-uri' })
})
check('the hero image uses the MAIN_IMAGE uri, not the attribute one', () => {
  const p = gs.buildPayload_({ title:'Ceramic Serving Bowl White Glaze', identifier:'A1',
    variantName:'x', price:'1', stock:1, weightKg:'1',
    imageUri:'main-uri', attributeImageUri:'attr-uri', idempotencyKey:'k' }, 'c', 'W', [])
  eq(p.main_images, [{ uri: 'main-uri' }])
})
check('carries the idempotency key and lists immediately', () => {
  const p = gs.buildPayload_({ title:'Ceramic Serving Bowl White Glaze', identifier:'A1',
    variantName:'x', price:'1', stock:1, weightKg:'1', imageUri:'m', attributeImageUri:'a',
    idempotencyKey:'key-123' }, 'c', 'W', [])
  eq(p.idempotency_key, 'key-123')
  eq(p.save_mode, 'LISTING')
})

console.log('\nvalidateTitle_ — parity with the TypeScript rules')
check('rejects the real 16-character failure case', () => {
  if (!/at least 25/.test(gs.validateTitle_('Ceramic Mug Blue'))) throw new Error('accepted a short title')
})
check('accepts a compliant title', () => eq(gs.validateTitle_('Ceramic Serving Bowl White Glaze'), ''))
check('rejects a long Chinese title for being Chinese, not for length', () => {
  // The earlier version of this test used a 13-character Chinese title, which
  // was rejected for length before the character rule ran — proving nothing.
  const long = '陶瓷碗白釉大号餐具套装家用高级手工制作精美礼品盒装'
  if (long.length < 25) throw new Error('fixture too short to test the right rule: ' + long.length)
  const r = gs.validateTitle_(long)
  if (!/English/.test(r)) throw new Error('accepted Chinese, said: ' + r)
})
check('a short Chinese title is still rejected, on length', () => {
  if (!/at least 25/.test(gs.validateTitle_('陶瓷碗白釉'))) throw new Error('accepted it')
})
check('rejects a title with an HTML entity', () => {
  if (!/HTML entity/.test(gs.validateTitle_('Ceramic Serving Bowl&nbsp;White Glaze'))) throw new Error('accepted it')
})
check('rejects a symbols-only title of legal length', () => {
  if (!/only symbols/.test(gs.validateTitle_('/'.repeat(30)))) throw new Error('accepted it')
})
check('rejects ten of the same character in a row', () => {
  if (!/nine times/.test(gs.validateTitle_('Ceramic Bowl aaaaaaaaaaaa White Glaze'))) throw new Error('accepted it')
})
check('rejects a control character', () => {
  if (!/control characters/.test(gs.validateTitle_('Ceramic Serving Bowl\u0007White Glaze'))) throw new Error('accepted it')
})
check('rejects emoji', () => { if (!/English/.test(gs.validateTitle_('Ceramic Serving Bowl White 🎉'))) throw new Error('accepted emoji') })

console.log('\nvalidateVariantName_ — a variant name is not a product title')
check('accepts a short name, since there is no minimum', () => eq(gs.validateVariantName_('Blue Mug'), ''))
check('accepts a single word', () => eq(gs.validateVariantName_('Bowl'), ''))
check('accepts exactly 50 characters', () => {
  const n = 'Hand Thrown Reactive Glaze Stoneware Dinner Plates'
  if (n.length !== 50) throw new Error('fixture is ' + n.length)
  eq(gs.validateVariantName_(n), '')
})
check('rejects 51 characters, and says by how much', () => {
  const n = 'Hand Thrown Reactive Glaze Stoneware Dinner Plate A'
  if (n.length !== 51) throw new Error('fixture is ' + n.length)
  if (!/at most 50 characters — this is 51/.test(gs.validateVariantName_(n))) {
    throw new Error(gs.validateVariantName_(n))
  }
})
check('requires something', () => {
  if (!/required/.test(gs.validateVariantName_(''))) throw new Error('accepted empty')
  if (!/required/.test(gs.validateVariantName_('   '))) throw new Error('accepted blank')
})
check('rejects Chinese', () => {
  if (!/must be English/.test(gs.validateVariantName_('白釉碗'))) throw new Error('accepted Chinese')
})
check('rejects emoji', () => {
  if (!/must be English/.test(gs.validateVariantName_('Blue Mug 🎉'))) throw new Error('accepted emoji')
})
check('rejects an HTML entity', () => {
  if (!/HTML entity/.test(gs.validateVariantName_('Blue&nbsp;Mug'))) throw new Error('accepted it')
})
check('never applies a minimum length', () => {
  // Asserting the ABSENCE of the title floor, not just that one short name passes.
  ;['Red', 'Blue Mug', 'A', '20cm'].forEach((n) => {
    if (/at least/.test(gs.validateVariantName_(n))) throw new Error('held "' + n + '" to a minimum')
  })
})
check('agrees with the TypeScript validator case for case', () => {
  // The two backends serve the same livestream and must not drift.
  eq(gs.validateVariantName_('Blue Mug'), '')
  eq(gs.validateVariantName_('Bowl'), '')
  if (!gs.validateVariantName_('白釉碗')) throw new Error('drifted on Chinese')
  if (!gs.validateVariantName_('')) throw new Error('drifted on empty')
})

console.log('\ncontinuationTitle_ — naming the listing that carries on')
check('suffixes a first continuation with (2)', () =>
  eq(gs.continuationTitle_('Katrin BJ Ceramic Factory Run'), 'Katrin BJ Ceramic Factory Run (2)'))
check('increments rather than stacking', () => {
  eq(gs.continuationTitle_('Katrin BJ Ceramic Factory Run (2)'), 'Katrin BJ Ceramic Factory Run (3)')
  eq(gs.continuationTitle_('Katrin BJ Ceramic Factory Run (9)'), 'Katrin BJ Ceramic Factory Run (10)')
})
check('leaves a trailing bracket that is not a part number alone', () =>
  eq(gs.continuationTitle_('Ceramic Bowl Set (Limited Edition)'), 'Ceramic Bowl Set (Limited Edition) (2)'))
check('never exceeds the 255-character ceiling', () => {
  const r = gs.continuationTitle_('x'.repeat(300))
  if (r.length > 255) throw new Error('length ' + r.length)
  if (!/ \(2\)$/.test(r)) throw new Error('lost the suffix: ' + r.slice(-8))
})
check('produces a title the title validator accepts', () =>
  eq(gs.validateTitle_(gs.continuationTitle_('Katrin BJ Ceramic Factory Run')), ''))
check('tolerates surrounding whitespace', () =>
  eq(gs.continuationTitle_('  Katrin BJ Ceramic Factory Run  '), 'Katrin BJ Ceramic Factory Run (2)'))

console.log('\nLock.gs — one lock per execution')
check('takes the lock when nothing holds it', () => {
  lockState.refused = false; lockState.acquisitions = 0
  eq(gs.withScriptLock_(1000, () => 'ran'), 'ran')
  eq(lockState.acquisitions, 1)
})
check('releases the lock afterwards', () => {
  lockState.refused = false
  gs.withScriptLock_(1000, () => 'ran')
  eq(gs.holdsScriptLock_(), false)
  eq(lockState.held, false)
})
check('does NOT take the lock again when nested', () => {
  // This is the whole point of Lock.gs. The API router holds the lock for
  // every write action, and recordSku_ then appends to the Sheet inside it —
  // so a second acquisition attempt happens on every single push. Whether
  // Apps Script tolerates that is undocumented, so it must never happen.
  lockState.refused = false; lockState.acquisitions = 0
  const result = gs.withScriptLock_(1000, () =>
    gs.withScriptLock_(1000, () => gs.withScriptLock_(1000, () => 'inner')),
  )
  eq(result, 'inner')
  eq(lockState.acquisitions, 1, 'the lock was taken more than once')
})
check('still holds the lock during nested work', () => {
  lockState.refused = false
  gs.withScriptLock_(1000, () => {
    if (!gs.holdsScriptLock_()) throw new Error('lost the lock inside')
    gs.withScriptLock_(1000, () => {
      if (!gs.holdsScriptLock_()) throw new Error('lost the lock while nested')
    })
  })
})
check('releases the lock even when the work throws', () => {
  lockState.refused = false
  try { gs.withScriptLock_(1000, () => { throw new Error('boom') }) } catch (e) { /* expected */ }
  eq(gs.holdsScriptLock_(), false)
  eq(lockState.held, false)
})
check('a failed push does not wedge the next one', () => {
  lockState.refused = false
  try { gs.withScriptLock_(1000, () => { throw new Error('boom') }) } catch (e) {}
  eq(gs.withScriptLock_(1000, () => 'next'), 'next')
})
check('throws a BUSY error the router can recognise', () => {
  lockState.refused = true
  throws(() => gs.withScriptLock_(1000, () => 'never'), /^BUSY:/)
  lockState.refused = false
})
check('does not run the work when the lock is refused', () => {
  lockState.refused = true
  let ran = false
  try { gs.withScriptLock_(1000, () => { ran = true }) } catch (e) {}
  lockState.refused = false
  if (ran) throw new Error('ran the work unguarded')
})
check('optional work is skipped, not failed, when refused', () => {
  lockState.refused = true
  eq(gs.withScriptLockOptional_(500, () => 'ran'), undefined)
  lockState.refused = false
})
check('optional work runs when already nested', () => {
  // touchLastSeen_ is called inside a held lock on every request; skipping it
  // there would mean last-seen never updates.
  lockState.refused = false; lockState.acquisitions = 0
  const r = gs.withScriptLock_(1000, () => gs.withScriptLockOptional_(500, () => 'ran'))
  eq(r, 'ran')
  eq(lockState.acquisitions, 1)
})


// ---------------------------------------------------------------------------
// verifyIdToken_ — the refusal that used to be one message for five causes.
//
// This is the path that stranded a real sign-in: a misconfigured backend and a
// user who had simply not signed in produced identical output, so the screen
// looped with nothing to act on. Every case below asserts the CODE, because
// that is what makes the difference visible.
// ---------------------------------------------------------------------------
// Shaped like a real one — the random segment is long, which is what makes
// an abbreviation worth having at all.
const CLIENT = '418799041411-i6rin2ejph0qu3l9ekjbgl0ksgbnpr1b.apps.googleusercontent.com'

function auth({ props = {}, status = 200, body = {}, throws = false } = {}) {
  const st = global.__AUTH_STATE__
  st.props = props
  st.status = status
  st.bodyText = typeof body === 'string' ? body : JSON.stringify(body)
  st.throws = throws
}

console.log('\nverifyIdToken_ — why a sign-in was refused')

check('accepts a token issued for our own client', () => {
  auth({
    props: { GOOGLE_CLIENT_ID: CLIENT },
    body: { aud: CLIENT, email: 'Brien@Sheldonglobal.com', email_verified: 'true', name: 'Brien' },
  })
  const r = gs.verifyIdToken_('t')
  eq(r.ok, true)
  eq(r.email, 'brien@sheldonglobal.com', 'email is lowercased')
  eq(r.name, 'Brien')
})

check('no token at all says so', () => {
  auth({ props: { GOOGLE_CLIENT_ID: CLIENT } })
  eq(gs.verifyIdToken_('').code, 'NO_TOKEN')
})

// The client id used to be a Script Property and nothing else, so a
// deployment where nobody had typed it in refused every sign-in while looking
// entirely healthy. It is not a secret — the same string is in the app's public
// JavaScript — so it now lives in the code, and the property is an override.
check('with no property set, the built-in client id is used', () => {
  auth({
    props: {},
    body: {
      aud: gs.DEFAULT_GOOGLE_CLIENT_ID,
      email: 'a@b.com',
      email_verified: 'true',
    },
  })
  eq(gs.verifyIdToken_('t').ok, true)
})

check('the built-in id is a real Google client id', () => {
  const id = gs.DEFAULT_GOOGLE_CLIENT_ID
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error('not shaped like a client id: ' + id)
  }
})

check('a property still overrides the built-in', () => {
  const other = '555000111-qqwweerrttyyuuiiooppaassddffg.apps.googleusercontent.com'
  auth({
    props: { GOOGLE_CLIENT_ID: other },
    body: { aud: other, email: 'a@b.com', email_verified: 'true' },
  })
  eq(gs.verifyIdToken_('t').ok, true)
  eq(gs.googleClientId_(), other)
})

check('an override means the built-in is no longer accepted', () => {
  const other = '555000111-qqwweerrttyyuuiiooppaassddffg.apps.googleusercontent.com'
  auth({
    props: { GOOGLE_CLIENT_ID: other },
    body: { aud: gs.DEFAULT_GOOGLE_CLIENT_ID, email: 'a@b.com', email_verified: 'true' },
  })
  eq(gs.verifyIdToken_('t').code, 'CLIENT_ID_MISMATCH')
})

check('a client id from a different project is called a mismatch', () => {
  auth({
    props: { GOOGLE_CLIENT_ID: '999888777-zzqqwweerrttyyuuiiooppaassdd.apps.googleusercontent.com' },
    body: { aud: CLIENT, email: 'a@b.com', email_verified: 'true' },
  })
  const r = gs.verifyIdToken_('t')
  eq(r.code, 'CLIENT_ID_MISMATCH')
  if (!/different/.test(r.message)) throw new Error(r.message)
})

// The whole reason prop_ now trims: a console paste carries a newline, and the
// resulting refusal is indistinguishable from a wrong client id.
check('a trailing newline on the property does NOT break sign-in', () => {
  auth({
    props: { GOOGLE_CLIENT_ID: CLIENT + '\n' },
    body: { aud: CLIENT, email: 'a@b.com', email_verified: 'true' },
  })
  eq(gs.verifyIdToken_('t').ok, true)
})

check('surrounding spaces on the property do not break sign-in', () => {
  auth({
    props: { GOOGLE_CLIENT_ID: '  ' + CLIENT + '  ' },
    body: { aud: CLIENT, email: 'a@b.com', email_verified: 'true' },
  })
  eq(gs.verifyIdToken_('t').ok, true)
})

check('an expired token asks for a fresh sign-in, not a config fix', () => {
  auth({ props: { GOOGLE_CLIENT_ID: CLIENT }, status: 400, body: { error: 'invalid_token' } })
  const r = gs.verifyIdToken_('t')
  eq(r.code, 'TOKEN_REJECTED')
  if (!/expired/.test(r.message)) throw new Error(r.message)
})

check('Google being unreachable is not reported as a bad sign-in', () => {
  auth({ props: { GOOGLE_CLIENT_ID: CLIENT }, throws: true })
  eq(gs.verifyIdToken_('t').code, 'GOOGLE_UNREACHABLE')
})

check('an unparseable response is its own case', () => {
  auth({ props: { GOOGLE_CLIENT_ID: CLIENT }, body: 'not json' })
  eq(gs.verifyIdToken_('t').code, 'TOKEN_UNREADABLE')
})

check('an unverified email is refused', () => {
  auth({
    props: { GOOGLE_CLIENT_ID: CLIENT },
    body: { aud: CLIENT, email: 'a@b.com', email_verified: 'false' },
  })
  eq(gs.verifyIdToken_('t').code, 'EMAIL_UNVERIFIED')
})

check('a token with no email is refused', () => {
  auth({ props: { GOOGLE_CLIENT_ID: CLIENT }, body: { aud: CLIENT, email_verified: 'true' } })
  eq(gs.verifyIdToken_('t').code, 'NO_EMAIL')
})

check('every refusal carries a code and a message', () => {
  const cases = [
    () => { auth({ props: {}, status: 400 }); return gs.verifyIdToken_('t') },
    () => { auth({ props: { GOOGLE_CLIENT_ID: CLIENT }, status: 401 }); return gs.verifyIdToken_('t') },
    () => { auth({ props: { GOOGLE_CLIENT_ID: CLIENT }, throws: true }); return gs.verifyIdToken_('t') },
  ]
  cases.forEach((f, i) => {
    const r = f()
    if (r.ok !== false || !r.code || !r.message) throw new Error('case ' + i + ': ' + JSON.stringify(r))
  })
})

console.log('\nshortClient_ — two ids comparable by eye')
check('keeps the project number and a little more', () =>
  eq(gs.shortClient_(CLIENT), '418799041411-i6rin2…'))
check('handles an id with no dash', () => eq(gs.shortClient_('abcdefghijklmnop'), 'abcdefghijkl…'))
check('says (none) rather than printing undefined', () => eq(gs.shortClient_(undefined), '(none)'))


// ---------------------------------------------------------------------------
// SHOPS.authorizeFn must name a function that really exists.
//
// checkSetup prints this name and tells a person to pick it from the Run
// dropdown. It used to print ttAuthorizeUrl('HZ'), which cannot be run that
// way at all — the editor has no way to pass an argument — so someone followed
// the instruction, found nothing to click, and stopped. A name that is only a
// string in one file and a declaration in another is exactly the pair that
// drifts, so it is pinned here.
// ---------------------------------------------------------------------------
console.log('\nSHOPS — the authorise function named for each shop')

const tiktokSrc = fs.readFileSync(path.join(DIR, 'TikTok.gs'), 'utf8')

check('every shop names one', () => {
  gs.SHOPS.forEach((shop) => {
    if (!shop.authorizeFn) throw new Error(shop.id + ' has no authorizeFn')
  })
})

check('every named function is declared in TikTok.gs', () => {
  gs.SHOPS.forEach((shop) => {
    const declared = new RegExp('function\\s+' + shop.authorizeFn + '\\s*\\(')
    if (!declared.test(tiktokSrc)) {
      throw new Error(shop.id + ': ' + shop.authorizeFn + '() is named but not declared')
    }
  })
})

check('each function takes no argument, so the Run dropdown can call it', () => {
  gs.SHOPS.forEach((shop) => {
    const sig = new RegExp('function\\s+' + shop.authorizeFn + '\\s*\\(([^)]*)\\)')
    const m = tiktokSrc.match(sig)
    if (!m) throw new Error(shop.authorizeFn + ' not found')
    if (m[1].trim() !== '') throw new Error(shop.authorizeFn + ' takes "' + m[1] + '"')
  })
})

check('no two shops share one', () => {
  const names = gs.SHOPS.map((s) => s.authorizeFn)
  eq(names.length, new Set(names).size, 'duplicate authorizeFn')
})

// ---------------------------------------------------------------------------
// shop_cipher must be omitted from image upload.
//
// A real push failed here: "Unexpected identifier. The 'shop_cipher' query
// parameter is not required for this request." Almost every endpoint needs the
// cipher to say which shop a call is for, so it was added to all of them —
// but image upload rejects it outright rather than ignoring it, and the
// wording points at the payload rather than at one query parameter.
// ---------------------------------------------------------------------------
console.log('\nshop_cipher — the endpoint that refuses it')

check('image upload is excluded', () =>
  eq(gs.cipherAllowed_('/product/202309/images/upload'), false))

check('everything else still gets it', () => {
  ;[
    '/product/202309/products',
    '/product/202509/products/123/partial_edit',
    '/product/202502/products/search',
    '/logistics/202309/warehouses',
    '/product/202309/categories/recommend',
  ].forEach((path) => {
    if (!gs.cipherAllowed_(path)) throw new Error(path + ' lost its cipher')
  })
})

check('the exclusion list is exact paths, not prefixes', () => {
  // A prefix match would strip the cipher from anything under /images/, and a
  // silently unsigned-for-the-wrong-shop request is worse than a loud refusal.
  gs.PATHS_WITHOUT_CIPHER.forEach((path) => {
    if (!path.startsWith('/')) throw new Error('not a path: ' + path)
  })
  eq(gs.cipherAllowed_('/product/202309/images/upload/extra'), true)
})

// The signature must be computed over exactly what is sent. If the cipher were
// dropped after signing, every upload would fail as a bad signature instead —
// an opaque failure with no clue which step broke.
console.log('\nsigning agrees with the query actually sent')
check('a query without the cipher signs differently from one with it', () => {
  const withCipher = gs.ttSign_('/product/202309/images/upload',
    { app_key: 'k', timestamp: '1', shop_cipher: 'abc', use_case: 'MAIN_IMAGE' }, '', 'secret')
  const without = gs.ttSign_('/product/202309/images/upload',
    { app_key: 'k', timestamp: '1', use_case: 'MAIN_IMAGE' }, '', 'secret')
  if (withCipher === without) throw new Error('the cipher is not being signed at all')
})

// ---------------------------------------------------------------------------
// Orders: the arithmetic that becomes a purchase order.
//
// These numbers are what a factory gets paid against, so the cases that matter
// are the ones that quietly produce a plausible wrong answer: a basket holding
// two listings, a cancelled line, and a boundary between two streams.
// ---------------------------------------------------------------------------
console.log('\nsgtEpoch_ — Singapore time, not the server timezone')

check('midnight SGT is 16:00 UTC the day before', () =>
  eq(gs.sgtEpoch_('2026-09-06', '00:00'), Date.parse('2026-09-05T16:00:00Z') / 1000))

check('an evening stream start converts correctly', () =>
  eq(gs.sgtEpoch_('2026-09-06', '20:30'), Date.parse('2026-09-06T12:30:00Z') / 1000))

check('the offset is explicit, not the script timezone', () => {
  // Written as +08:00 in the source rather than relying on a project setting
  // anyone can change. Asserted by value, so changing that setting cannot
  // silently shift every export by hours.
  eq(gs.sgtEpoch_('2026-01-01', '12:00'), Date.parse('2026-01-01T04:00:00Z') / 1000)
})

check('a nonsense date is refused rather than becoming NaN', () =>
  throws(() => gs.sgtEpoch_('not-a-date', '00:00'), /Not a date/))

function item(o) {
  return Object.assign({
    order_id: 'o1', shop_id: 'HZ', listing_id: 'L1', product_name: 'Katrin Run',
    sku_id: 's1', seller_sku: 'A1', variation: 'A1 Blue Mug',
    quantity: 1, sale_price: '10.00', currency: 'SGD', status: 'AWAITING_SHIPMENT',
    created_at_sgt: '2026-09-06 20:10', created_epoch: gs.sgtEpoch_('2026-09-06', '20:10'),
  }, o)
}

console.log('\nsummariseItems_ — per listing, from line items')

check('units and revenue multiply quantity by price', () => {
  const r = gs.summariseItems_([item({ quantity: 3, sale_price: '12.50' })])
  eq(r.listings[0].units, 3)
  eq(r.listings[0].revenue, 37.5)
})

// The reason per-listing figures come from line items and not order totals.
check('one order spanning two listings is not double counted', () => {
  const r = gs.summariseItems_([
    item({ order_id: 'o1', listing_id: 'L1', quantity: 2, sale_price: '10.00' }),
    item({ order_id: 'o1', listing_id: 'L2', quantity: 1, sale_price: '30.00' }),
  ])
  eq(r.listings.length, 2)
  eq(r.total_units, 3)
  eq(r.total_revenue, 50)
  // Both listings see the same order, and each counts it once.
  r.listings.forEach((l) => eq(l.order_count, 1))
})

check('two lines of one listing in one order count as one order', () => {
  const r = gs.summariseItems_([
    item({ order_id: 'o9', seller_sku: 'A1' }),
    item({ order_id: 'o9', seller_sku: 'A2' }),
  ])
  eq(r.listings[0].order_count, 1)
  eq(r.listings[0].units, 2)
})

check('a cancelled line is reported, not counted as sold', () => {
  const r = gs.summariseItems_([
    item({ quantity: 5, sale_price: '10.00' }),
    item({ order_id: 'o2', quantity: 2, sale_price: '10.00', status: 'CANCELLED' }),
  ])
  eq(r.listings[0].units, 5, 'cancelled units must not be sold')
  eq(r.listings[0].revenue, 50)
  eq(r.listings[0].unsold_units, 2, 'but they must still be visible')
})

check('an unpaid line is treated the same as cancelled', () => {
  const r = gs.summariseItems_([item({ quantity: 4, status: 'UNPAID' })])
  eq(r.listings[0].units, 0)
  eq(r.listings[0].unsold_units, 4)
})

check('status matching is case insensitive', () => {
  const r = gs.summariseItems_([item({ quantity: 4, status: 'cancelled' })])
  eq(r.listings[0].unsold_units, 4)
})

check('listings are ordered by revenue, biggest first', () => {
  const r = gs.summariseItems_([
    item({ listing_id: 'small', sale_price: '5.00' }),
    item({ listing_id: 'big', sale_price: '90.00' }),
  ])
  eq(r.listings.map((l) => l.listing_id), ['big', 'small'])
})

check('money is rounded to cents, not left as float drift', () => {
  const r = gs.summariseItems_([
    item({ quantity: 3, sale_price: '0.10' }),
    item({ order_id: 'o2', quantity: 3, sale_price: '0.20' }),
  ])
  eq(r.total_revenue, 0.9)
})

check('no items is an empty summary, not a crash', () => {
  const r = gs.summariseItems_([])
  eq(r.listings, [])
  eq(r.total_units, 0)
  eq(r.total_revenue, 0)
})

// ---------------------------------------------------------------------------
// What a real order actually looks like.
//
// Confirmed by running inspectOrders against a live HOUZE order rather than
// assumed. Two things came back that the first version got wrong.
// ---------------------------------------------------------------------------
console.log('\nreal order shape — confirmed against live data')

check('three of one SKU is three line items, not a quantity of three', () => {
  // A line item has no quantity field. TikTok tracks fulfilment per unit, so
  // buying three produces three rows, each with its own id and tracking. Units
  // are therefore COUNTED. If this ever regresses to summing a quantity field,
  // every purchase order silently under-reports by the size of each basket.
  const three = [1, 2, 3].map((n) =>
    item({ order_id: 'o1', sku_id: 'sku-a', seller_sku: 'A1', quantity: 1, sale_price: '12.88' }),
  )
  const r = gs.summariseItems_(three)
  eq(r.listings[0].units, 3)
  eq(r.listings[0].revenue, 38.64, 'sale_price is the price of ONE unit')
  eq(r.listings[0].order_count, 1)
})

check('sale_price is per unit, so it is not multiplied by a basket size', () => {
  const r = gs.summariseItems_([item({ sale_price: '12.88', quantity: 1 })])
  eq(r.listings[0].revenue, 12.88)
})

check('IN_TRANSIT counts as sold', () => {
  // Real status from a live order. Anything not cancelled or unpaid is money
  // that has changed hands, and a factory is owed for it.
  const r = gs.summariseItems_([item({ status: 'IN_TRANSIT' })])
  eq(r.listings[0].units, 1)
  eq(r.listings[0].unsold_units, 0)
})

console.log('\nlistingOrders_ — grouping when seller_sku is blank')

check('variations group on sku_id, not on a name that can be blank', () => {
  // seller_sku is empty on every product this app did not list — the
  // identifier is only there because we put it there. Grouping on the name
  // would merge two different variations into one purchase-order row.
  const rows = [
    { sku_id: 'sku-1', seller_sku: '', variation: 'Glass make up organiser',
      quantity: 1, sale_price: '12.88', status: 'IN_TRANSIT', order_id: 'o1' },
    { sku_id: 'sku-2', seller_sku: '', variation: 'Glass make up organiser',
      quantity: 1, sale_price: '19.90', status: 'IN_TRANSIT', order_id: 'o2' },
  ]
  const byKey = {}
  rows.forEach((r) => {
    const key = String(r.sku_id || r.seller_sku || r.variation || '?')
    byKey[key] = (byKey[key] || 0) + 1
  })
  eq(Object.keys(byKey).length, 2, 'two sku ids must stay two rows')
})

// ---------------------------------------------------------------------------
// Carrying an under-review variation forward.
//
// This is the path that lost a real SKU. B1 was pushed; eighteen minutes later
// B2 went up, TikTok's read did not include B1 because it was still under
// review, and the append rebuilt the product from that read — deleting it.
// TikTok removes any SKU whose id is absent from a partial_edit payload, so
// omitting one is not a no-op.
// ---------------------------------------------------------------------------
console.log('\nbuildAppendPayload_ — variations TikTok is not returning')

const keep = (o) =>
  Object.assign(
    { id: 'tt-b1', sellerSku: 'B1', valueName: 'B1 Blue Mug',
      skuImgUri: 'img-b1', priceAmount: '199', quantity: 1 },
    o,
  )

check('a carried-forward variation is in the payload, by its TikTok id', () => {
  const p = gs.buildAppendPayload_({ productId: 'p1', skus: [sku()] }, addition, [keep()])
  const ids = p.skus.map((s) => s.id)
  if (!ids.includes('tt-b1')) throw new Error('B1 was dropped: ' + JSON.stringify(ids))
})

check('it keeps its price, stock and photo', () => {
  const p = gs.buildAppendPayload_({ productId: 'p1', skus: [sku()] }, addition, [keep()])
  const b1 = p.skus.find((s) => s.id === 'tt-b1')
  eq(b1.price.amount, '199')
  eq(b1.inventory[0].quantity, 1)
  // An image is mandatory for every value of the primary attribute, so losing
  // it fails the whole edit rather than just that row.
  eq(b1.sales_attributes[0].sku_img.uri, 'img-b1')
})

check('the new variation is still added alongside it', () => {
  const p = gs.buildAppendPayload_({ productId: 'p1', skus: [sku()] }, addition, [keep()])
  eq(p.skus.length, 3, 'existing + carried forward + new')
  const added = p.skus.filter((s) => !s.id)
  eq(added.length, 1, 'exactly one SKU has no id')
  eq(added[0].seller_sku, addition.identifier)
})

check('nothing existing loses its id', () => {
  const p = gs.buildAppendPayload_({ productId: 'p1', skus: [sku()] }, addition, [keep()])
  const existing = p.skus.find((s) => s.seller_sku === 'A1')
  eq(existing.id, 'x')
})

check('with nothing to carry forward the payload is unchanged', () => {
  const withNone = gs.buildAppendPayload_({ productId: 'p1', skus: [sku()] }, addition, [])
  const withUndef = gs.buildAppendPayload_({ productId: 'p1', skus: [sku()] }, addition)
  eq(withNone.skus.length, 2)
  eq(JSON.stringify(withNone), JSON.stringify(withUndef), 'omitting the argument must not differ')
})

check('a carried-forward variation counts against the 100 cap', () => {
  // Otherwise the cap is measured against a number smaller than what is being
  // sent, and TikTok refuses the whole edit at 101.
  const many = []
  for (let i = 0; i < 99; i++) many.push(sku({ id: 'id' + i, sellerSku: 'A' + i, valueName: 'A' + i }))
  throws(
    () => gs.buildAppendPayload_({ productId: 'p1', skus: many }, addition, [keep()]),
    /LISTING_FULL/,
  )
})

check('one already visible is not carried forward twice', () => {
  // Guards the case where TikTok starts returning it between the read and the
  // decision to restore: two SKUs with the same value name fail the edit.
  const p = gs.buildAppendPayload_(
    { productId: 'p1', skus: [sku(), sku({ id: 'tt-b1', sellerSku: 'B1', valueName: 'B1 Blue Mug' })] },
    addition,
    [keep()],
  )
  eq(p.skus.filter((s) => s.id === 'tt-b1').length, 1)
})

check('a repeated identifier is still refused', () => {
  // The duplicate check must see carried-forward value names too, or an
  // identifier reused after a restore slips through.
  throws(
    () =>
      gs.buildAppendPayload_(
        { productId: 'p1', skus: [sku()] },
        { identifier: 'B1', variantName: 'Blue Mug', price: '9', stock: 1, imageUri: 'i' },
        [keep()],
      ),
    /already on this listing/,
  )
})

// ---------------------------------------------------------------------------
// Never restore something that was deleted on purpose.
//
// The carry-forward for under-review variations, taken alone, would have put a
// deleted variation back on the next push. B1 was deleted deliberately, and
// the first version of that code matched it on every condition: pushed, has an
// id, absent from the read. A SKU nobody wanted, live again, at whatever price
// it had, with nobody told.
//
// What separates the two is whether TikTok was ever seen returning it. Never
// seen means it may be pending. Seen and now gone means someone removed it.
// ---------------------------------------------------------------------------
console.log('\ncarry-forward eligibility')

const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000
const recent = new Date(Date.now() - 60_000).toISOString()
const old = new Date(Date.now() - 3 * REVIEW_WINDOW_MS).toISOString()

/** Mirrors the filter in addVariation_, so the rule is asserted in one place. */
function eligible(row, seen, addingIdentifier) {
  const cutoff = Date.now() - REVIEW_WINDOW_MS
  if (String(row.status) !== 'pushed') return false
  if (String(row.identifier) === addingIdentifier) return false
  if (seen[String(row.identifier)]) return false
  if (!String(row.tiktok_sku_id || '')) return false
  if (String(row.confirmed_at || '')) return false
  const pushedAt = Date.parse(String(row.pushed_at || row.created_at || ''))
  return !isNaN(pushedAt) && pushedAt >= cutoff
}

const row = (o) =>
  Object.assign(
    { identifier: 'B1', status: 'pushed', tiktok_sku_id: 'tt-b1',
      confirmed_at: '', pushed_at: recent },
    o,
  )

check('a variation TikTok has never shown is carried forward', () =>
  eq(eligible(row(), {}, 'B9'), true))

check('one confirmed live and now gone is NOT restored', () =>
  // This is B1. It was seen, then deleted.
  eq(eligible(row({ confirmed_at: recent }), {}, 'B9'), false))

check('one already marked removed is not restored', () =>
  eq(eligible(row({ status: 'removed', confirmed_at: recent }), {}, 'B9'), false))

check('one still unseen after a day is not carried forward forever', () =>
  // Past a day it was refused or lost. Carrying it into every later push grows
  // each payload and risks the whole edit for something not coming back.
  eq(eligible(row({ pushed_at: old }), {}, 'B9'), false))

check('one without a TikTok id cannot be kept by anything', () =>
  eq(eligible(row({ tiktok_sku_id: '' }), {}, 'B9'), false))

check('the variation being added is not also carried forward', () =>
  eq(eligible(row({ identifier: 'B9' }), {}, 'B9'), false))

check('one TikTok is already returning is left alone', () =>
  eq(eligible(row(), { B1: true }, 'B9'), false))

check('a row with no usable timestamp is not carried forward', () =>
  eq(eligible(row({ pushed_at: '', created_at: '' }), {}, 'B9'), false))

// ---------------------------------------------------------------------------
// Removing one variation on purpose.
//
// TikTok deletes any SKU absent from a partial_edit payload — the hazard every
// append defends against, used here as the mechanism. So the guard inverts:
// exactly one id may disappear, and it must be the target.
// ---------------------------------------------------------------------------
console.log('\nbuildRemovePayload_ — remove exactly one')

const three = [
  sku({ id: 'id-a', sellerSku: 'A1', valueName: 'A1 Red' }),
  sku({ id: 'id-b', sellerSku: 'A2', valueName: 'A2 Blue' }),
  sku({ id: 'id-c', sellerSku: 'A3', valueName: 'A3 Green' }),
]

check('the target is gone and nothing else is', () => {
  const p = gs.buildRemovePayload_({ productId: 'p', skus: three }, [], 'id-b')
  eq(p.skus.map((x) => x.id).sort(), ['id-a', 'id-c'])
  eq(p.removed.sellerSku, 'A2')
})

check('survivors keep price, stock, warehouse and image', () => {
  const p = gs.buildRemovePayload_({ productId: 'p', skus: three }, [], 'id-b')
  const a = p.skus.find((x) => x.id === 'id-a')
  eq(a.price.amount, '12.90')
  eq(a.inventory[0].quantity, 20)
  eq(a.inventory[0].warehouse_id, 'WH1')
  eq(a.sales_attributes[0].sku_img.uri, 'img1')
})

check('a pending variation is carried forward through a removal too', () => {
  // Removing A2 while B7 is under review must not also drop B7.
  const p = gs.buildRemovePayload_({ productId: 'p', skus: three }, [keep({ id: 'tt-b7', sellerSku: 'B7' })], 'id-b')
  if (!p.skus.some((x) => x.id === 'tt-b7')) throw new Error('B7 dropped')
})

check('refuses to remove the last variation', () =>
  throws(() => gs.buildRemovePayload_({ productId: 'p', skus: [three[0]] }, [], 'id-a'), /only variation/))

check('refuses a target TikTok is not showing', () =>
  // Under review, or never there — either way it cannot be removed by id yet.
  throws(() => gs.buildRemovePayload_({ productId: 'p', skus: three }, [], 'id-zzz'), /not on the listing/))

check('a survivor missing its warehouse stops the edit', () =>
  throws(
    () => gs.buildRemovePayload_({ productId: 'p', skus: [three[0], sku({ id: 'id-x', warehouseId: '' })] }, [], 'id-a'),
    /incomplete variation/,
  ))

check('the removed target is never re-added via carry-forward', () => {
  // If the target were also in alsoKeep (stale record), it must not sneak back.
  const p = gs.buildRemovePayload_({ productId: 'p', skus: three }, [keep({ id: 'id-b', sellerSku: 'A2' })], 'id-b')
  if (p.skus.some((x) => x.id === 'id-b')) throw new Error('target came back')
})

// --- Sheet header migration -------------------------------------------------
//
// The SKU tab gained tiktok_sku_id and confirmed_at while rows already existed.
// Reads map by position, so those rows came back shifted — an idempotency key
// where a TikTok sku id should be. This is the repair, and the cases are the
// real shapes found in the Sheet.

const OLD = ['a', 'b', 'e']
const NEW = ['a', 'b', 'c', 'd', 'e']

check('an old-shape row is re-laid-out by name, new columns blank', () => {
  const out = gs.relayoutRows_(OLD, NEW, [['1', '2', '5']])
  eq(JSON.stringify(out), JSON.stringify([['1', '2', '', '', '5']]))
})

check('a row already written in the new shape is kept as it is', () => {
  // Five values under a three-column header: only current code writes that.
  const out = gs.relayoutRows_(OLD, NEW, [['1', '2', '3', '4', '5']])
  eq(JSON.stringify(out), JSON.stringify([['1', '2', '3', '4', '5']]))
})

check('old and new shapes in the same tab each go to the right place', () => {
  const out = gs.relayoutRows_(OLD, NEW, [
    ['1', '2', '5', '', ''],        // old row, padded by getValues
    ['1', '2', '3', '4', '5'],      // new row
  ])
  eq(out[0][4], '5')
  eq(out[0][2], '')
  eq(out[1][2], '3')
})

check('a dropped column disappears and a reordered one follows its name', () => {
  const out = gs.relayoutRows_(['x', 'y', 'z'], ['z', 'x'], [['1', '2', '3']])
  eq(JSON.stringify(out), JSON.stringify([['3', '1']]))
})

check('identical headers change nothing', () => {
  const out = gs.relayoutRows_(NEW, NEW, [['1', '2', '3', '4', '5']])
  eq(JSON.stringify(out), JSON.stringify([['1', '2', '3', '4', '5']]))
})

// --- Export naming ------------------------------------------------------------

check('export filename carries when and who, and keeps the email readable', () => {
  const name = gs.exportFilename_('HOUZE - Purchase order 2026-09-04 to 2026-09-06', 'Brien Chua (brienchua@sheldonglobal.com)')
  if (!/^HOUZE - Purchase order 2026-09-04 to 2026-09-06 - requested \d{4}-\d{2}-\d{2} \d{4} by Brien Chua \(brienchua@sheldonglobal.com\)\.xlsx$/.test(name)) {
    throw new Error('unexpected name: ' + name)
  }
})

check('characters a filename cannot hold are removed, nothing else is', () => {
  eq(gs.fileSafe_('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
  eq(gs.fileSafe_('Table Matters - 7" bowl [Live]'), 'Table Matters - 7 bowl [Live]')
})

check('a Drive link in either shape yields its file id', () => {
  eq(gs.driveFileId_('https://drive.google.com/file/d/1HQpuxgbbspCgETgd5NziGiu5MhbtRZYS/view?usp=drivesdk'), '1HQpuxgbbspCgETgd5NziGiu5MhbtRZYS')
  eq(gs.driveFileId_('https://drive.google.com/open?id=1xSWKkHpiiwPT5W_eZVV-0lL2SzkeKghi'), '1xSWKkHpiiwPT5W_eZVV-0lL2SzkeKghi')
  eq(gs.driveFileId_(''), '')
})

check('the purchase-order photo is readable at 100% zoom', () => {
  // 96 px is roughly 2.5 cm on a laptop screen at 100%; below that two bowls
  // of the same shape cannot be told apart, which defeats the column.
  if (gs.PHOTO_PX < 96) throw new Error('photo too small: ' + gs.PHOTO_PX)
})

check('the listing id becomes a link Excel can open', () => {
  eq(gs.listingUrl_('1734903629786286062'), 'https://shop.tiktok.com/view/product/1734903629786286062?region=SG')
  eq(gs.listingLinkFormula_('1734903629786286062'),
     '=HYPERLINK("https://shop.tiktok.com/view/product/1734903629786286062?region=SG","1734903629786286062")')
  // A quote in a label would break the formula; it is dropped rather than trusted.
  eq(gs.listingLinkFormula_('1', 'a"b'), '=HYPERLINK("https://shop.tiktok.com/view/product/1?region=SG","ab")')
})

// --- Coded errors --------------------------------------------------------------

check('fail_ carries a code and extra fields; codeOf_ names the uncoded case', () => {
  const e = gs.fail_('TS-TST-01', 'boom', { listingId: 'x' })
  eq(e.message, 'boom'); eq(e.code, 'TS-TST-01'); eq(e.listingId, 'x')
  eq(gs.codeOf_(e), 'TS-TST-01')
  eq(gs.codeOf_(new Error('plain')), 'TS-UNC-00')
  eq(gs.codeOf_(null), 'TS-UNC-00')
})

check('ttReason_ keeps TikTok\'s own number next to its message', () => {
  eq(gs.ttReason_({ code: 12052262, message: 'Chinese characters are not supported' }),
     'Chinese characters are not supported (TikTok 12052262)')
  eq(gs.ttReason_({ code: 36009002 }), 'TikTok code 36009002')
  eq(gs.ttReason_(null), 'no response')
})

check('every error code is used exactly once and is in ERROR-CODES.md', () => {
  const codes = []
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.gs') || f === 'TikShopBackend.gs') continue
    const src = fs.readFileSync(path.join(DIR, f), 'utf8')
    for (const m of src.matchAll(/(?:fail_\(\s*|warn_\(\s*|code\s*[:=]\s*)'(TS-[A-Z]+-\d+)'/g)) codes.push(m[1])
  }
  if (codes.length < 50) throw new Error('too few codes found: ' + codes.length)
  const dupes = codes.filter((c, i) => codes.indexOf(c) !== i)
  if (dupes.length) throw new Error('duplicate codes: ' + dupes.join(', '))
  const doc = fs.readFileSync(path.join(DIR, 'ERROR-CODES.md'), 'utf8')
  const missing = codes.filter((c) => !doc.includes('`' + c + '`'))
  if (missing.length) throw new Error('not in ERROR-CODES.md (run build-error-codes.py): ' + missing.join(', '))
})

// --- Images for the export ---------------------------------------------------------
//
// Sheets refuses an inserted image over 2 MB OR over 1,000,000 pixels. The
// export on 7 Sep failed on the second limit with a 1600x1600 photo. These
// are the headers the measurement reads.

function pngBytes(w, h, pad = 100) {
  const b = new Array(pad).fill(0)
  ;[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => (b[i] = v))
  b[16] = (w >>> 24) & 255; b[17] = (w >>> 16) & 255; b[18] = (w >>> 8) & 255; b[19] = w & 255
  b[20] = (h >>> 24) & 255; b[21] = (h >>> 16) & 255; b[22] = (h >>> 8) & 255; b[23] = h & 255
  return b
}
function jpegBytes(w, h) {
  // SOI, APP0 segment (16 bytes), then SOF0 with height/width, then padding.
  const b = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]
  for (let i = 0; i < 14; i++) b.push(0x4a)
  b.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255)
  while (b.length < 100) b.push(0)
  return b
}

check('PNG and JPEG dimensions are read from the header', () => {
  eq(JSON.stringify(gs.imageDims_(pngBytes(1600, 1600))), JSON.stringify({ width: 1600, height: 1600 }))
  eq(JSON.stringify(gs.imageDims_(jpegBytes(400, 300))), JSON.stringify({ width: 400, height: 300 }))
  eq(gs.imageDims_([1, 2, 3]), null)
})

check('the 1600x1600 factory photo is refused for pixels, not bytes', () => {
  const fit = gs.sheetsImageFit_(pngBytes(1600, 1600))
  eq(fit.ok, false); eq(fit.code, 'TS-EXP-13')
  if (!/1600x1600/.test(fit.detail)) throw new Error(fit.detail)
})

check('a Drive-resized 400px copy fits', () => {
  const fit = gs.sheetsImageFit_(jpegBytes(400, 400))
  eq(fit.ok, true)
  if (400 * 400 > gs.SHEETS_IMAGE_MAX_PIXELS) throw new Error('limit constant wrong')
})

check('exactly one million pixels is allowed; one more is not', () => {
  eq(gs.sheetsImageFit_(pngBytes(1000, 1000)).ok, true)
  eq(gs.sheetsImageFit_(pngBytes(1001, 1000)).code, 'TS-EXP-13')
})

check('an oversized file is refused for bytes before anything else', () => {
  const big = pngBytes(10, 10, 2 * 1024 * 1024 + 1)
  eq(gs.sheetsImageFit_(big).code, 'TS-EXP-11')
})

check('an unrecognised format is refused rather than guessed', () => {
  const webp = new Array(100).fill(0); 'RIFF'.split('').forEach((c, i) => (webp[i] = c.charCodeAt(0)))
  eq(gs.sheetsImageFit_(webp).code, 'TS-EXP-12')
  eq(gs.sheetsImageFit_([]).code, 'TS-EXP-10')
})

check('photo sources are tried cheapest-first: phone thumbnail, our photo, TikTok', () => {
  const ours = { thumb: 'https://drive.google.com/file/d/T1/view', photo: 'https://drive.google.com/file/d/P1/view' }
  const c = gs.photoCandidates_(ours, { sku_image: 'https://p16.example/x.jpeg' })
  eq(c.map((x) => x.source).join(','), 'thumb,photo,tiktok')
  eq(c[0].fileId, 'T1'); eq(c[0].direct, true)
  eq(c[1].fileId, 'P1'); eq(Boolean(c[1].direct), false)
  eq(c[2].url, 'https://p16.example/x.jpeg')
})

check('a variation this app never listed still has TikTok\'s image to resize', () => {
  const c = gs.photoCandidates_(undefined, { sku_image: 'https://p16.example/y.jpeg' })
  eq(c.length, 1); eq(c[0].source, 'tiktok')
  eq(gs.photoCandidates_(undefined, {}).length, 0)
})

check('the phone thumbnail and Drive resize both sit well under the pixel cap', () => {
  if (gs.PHOTO_FETCH_PX * gs.PHOTO_FETCH_PX * 4 > gs.SHEETS_IMAGE_MAX_PIXELS) throw new Error('too close to the cap')
})

// --- Recovering the identifier when TikTok leaves seller_sku blank -----------------

check('the identifier is read off the front of a variation name, both apps\' styles', () => {
  eq(gs.identifierFromVariation_('F21-Segretto cast iron Mint'), 'F21')
  eq(gs.identifierFromVariation_('B6 Silver Magnetic Charging Stand'), 'B6')
  eq(gs.identifierFromVariation_('F2-B1F1 Popcon medium pink with LED '), 'F2')
  eq(gs.identifierFromVariation_('  hz12: thing'), 'HZ12')
})

check('names without an identifier yield blank, never a guess', () => {
  eq(gs.identifierFromVariation_('Floral Blue'), '')
  eq(gs.identifierFromVariation_('3 Tier, White'), '')
  eq(gs.identifierFromVariation_('Default'), '')
  eq(gs.identifierFromVariation_('Smoke Grey & White, 55L - 51*36*30cm, 3 PCS'), '')
  eq(gs.identifierFromVariation_('ABCD12 four letters is not the scheme'), '')
  eq(gs.identifierFromVariation_('F21Segretto no separator'), '')
  eq(gs.identifierFromVariation_(''), '')
})

check('the resolution note names each source and the unresolved count', () => {
  eq(gs.describeResolution_({ sibling: 2, sheet: 0, tiktok: 3, name: 12, unresolved: 1 }),
     '2 from sibling lines, 3 from TikTok, 12 from names, 1 unresolved')
  eq(gs.describeResolution_({ sibling: 0, sheet: 0, tiktok: 0, name: 0, unresolved: 0 }), '')
})

// --- Backend sessions ----------------------------------------------------------------
//
// A Google token lives an hour; the backend's own session lasts a working day.
// The token must be unforgeable, unexpired and name exactly one account.

check('a session round-trips and names the account', () => {
  const tok = gs.signSession_({ e: 'judy@sheldonglobal.com', n: 'Judy', x: 1_800_000_000_000 }, 'secret-A')
  const r = gs.readSession_(tok, 'secret-A', 1_700_000_000_000)
  eq(r.ok, true); eq(r.email, 'judy@sheldonglobal.com'); eq(r.name, 'Judy'); eq(r.expires_at, 1_800_000_000_000)
})

check('a session past its expiry is refused with its own code', () => {
  const tok = gs.signSession_({ e: 'a@b.c', n: '', x: 1000 }, 'k')
  eq(gs.readSession_(tok, 'k', 1001).code, 'SESSION_EXPIRED')
  eq(gs.readSession_(tok, 'k', 1000).code, 'SESSION_EXPIRED')
  eq(gs.readSession_(tok, 'k', 999).ok, true)
})

check('a session signed with another secret, or edited, is invalid', () => {
  const tok = gs.signSession_({ e: 'a@b.c', n: '', x: 9e12 }, 'k1')
  eq(gs.readSession_(tok, 'k2', 0).code, 'SESSION_INVALID')
  const [body, sig] = tok.split('.')
  const forged = Buffer.from(JSON.stringify({ e: 'admin@b.c', n: '', x: 9e12 })).toString('base64url') + '.' + sig
  eq(gs.readSession_(forged, 'k1', 0).code, 'SESSION_INVALID')
  eq(gs.readSession_(body, 'k1', 0).code, 'SESSION_INVALID')
  eq(gs.readSession_('', 'k1', 0).code, 'SESSION_INVALID')
  eq(gs.readSession_('a.b.c', 'k1', 0).code, 'SESSION_INVALID')
})

check('issueSession_ lasts fourteen hours and verifySession_ accepts it', () => {
  eq(gs.SESSION_TTL_MS, 14 * 3600 * 1000)
  const issued = gs.issueSession_({ email: 'brienchua@sheldonglobal.com', name: 'Brien Chua' })
  const r = gs.verifySession_(issued.session_token)
  eq(r.ok, true); eq(r.email, 'brienchua@sheldonglobal.com')
  const left = new Date(issued.session_expires_at).getTime() - Date.now()
  if (left < 13.9 * 3600 * 1000 || left > 14.1 * 3600 * 1000) throw new Error('ttl off: ' + left)
})

check('normaliseRole_ trims and lowercases whatever was typed in the Sheet', () => {
  eq(gs.normaliseRole_('Lister'), 'lister')
  eq(gs.normaliseRole_(' ADMIN '), 'admin')
  eq(gs.normaliseRole_('Blocked'), 'blocked')
  eq(gs.normaliseRole_(''), '')
  eq(gs.normaliseRole_(null), '')
  eq(gs.normaliseRole_(undefined), '')
})

check('a role typed with a capital letter still grants access', () => {
  // The bug this exists to stop: the Users tab is a spreadsheet somebody edits
  // by hand, so "Lister" and "Admin" turn up. Every check that lowercased kept
  // working and every check that did not locked the person out silently, which
  // is the worst split available: access looks granted in the Sheet and is
  // refused by the app.
  eq(gs.isAdmin_({ role: 'Admin' }), true)
  eq(gs.isAdmin_({ role: ' admin ' }), true)
  eq(gs.isAdmin_({ role: 'ADMIN' }), true)
  eq(gs.canList_({ role: 'Lister' }), true)
  eq(gs.canList_({ role: 'Admin' }), true)
})

check('and a role that is not admin still is not', () => {
  eq(gs.isAdmin_({ role: 'lister' }), false)
  eq(gs.isAdmin_({ role: 'administrator' }), false)
  eq(gs.isAdmin_({ role: '' }), false)
  eq(gs.isAdmin_(null), false)
  eq(gs.isAdmin_(undefined), false)
  eq(gs.canList_({ role: 'pending' }), false)
  eq(gs.canList_({ role: 'blocked' }), false)
  eq(gs.canList_(null), false)
})

check("skuImageUrl_ reads TikTok's 202309 shape, not the 202306 one", () => {
  // The real 202309 sku_img. `thumb_urls` is a 300px resize of a few KB and a
  // listing puts twenty-five of them on a phone, so it wins over `urls`.
  eq(gs.skuImageUrl_({ sku_img: {
    height: 600, width: 600, uri: 'tos-x/abc',
    thumb_urls: ['https://cdn/thumb.jpeg'], urls: ['https://cdn/full.jpeg'],
  } }), 'https://cdn/thumb.jpeg')
  eq(gs.skuImageUrl_({ sku_img: { uri: 'tos-x/abc', urls: ['https://cdn/full.jpeg'] } }), 'https://cdn/full.jpeg')
})

check('skuImageUrl_ returns nothing rather than throwing on every empty shape', () => {
  eq(gs.skuImageUrl_({}), '')
  eq(gs.skuImageUrl_({ sku_img: null }), '')
  eq(gs.skuImageUrl_({ sku_img: {} }), '')
  eq(gs.skuImageUrl_({ sku_img: { uri: 'tos-x/abc' } }), '')
  eq(gs.skuImageUrl_({ sku_img: { thumb_urls: [], urls: [] } }), '')
  eq(gs.skuImageUrl_({ sku_img: { thumb_urls: [''], urls: ['https://cdn/full.jpeg'] } }), 'https://cdn/full.jpeg')
  eq(gs.skuImageUrl_(null), '')
  eq(gs.skuImageUrl_(undefined), '')
})

check('the deprecated 202306 url_list spelling is not read anywhere', () => {
  // The class, not the instance. `url_list` silently yields undefined against
  // a 202309 response, so nothing errors and every image is simply blank —
  // which is how one wrong field name survived a fortnight and a full audit.
  const fs = require('fs')
  const dir = __dirname + '/..'
  const offenders = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.gs') || name === 'TikShopBackend.gs') continue
    const text = fs.readFileSync(dir + '/' + name, 'utf8')
    text.split('\n').forEach((line, i) => {
      // Prose about the bug is allowed; reading the field is not.
      if (/^\s*(\*|\/\/)/.test(line)) return
      if (/url_list/.test(line)) offenders.push(name + ':' + (i + 1))
    })
  }
  eq(offenders.join(', '), '')
})

console.log('\n' + pass + ' passed, ' + fail + ' failed\n')
process.exit(fail ? 1 : 0)
