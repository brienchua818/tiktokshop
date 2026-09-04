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
const FILES = ['Config.gs', 'Lock.gs', 'Product.gs']

const src = FILES.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n')

// Apps Script globals. Stubbed only as far as the loaded functions touch them;
// a test that needs more should stub more rather than reach for the real thing.
const lockState = { held: false, refused: false, acquisitions: 0 }
const sandbox = `
  var SpreadsheetApp = { flush: function () {} };
  var PropertiesService = { getScriptProperties: function () {
    return { getProperty: function () { return '' }, setProperties: function () {} }
  } };
  var Utilities = {
    getUuid: function () { return 'uuid' },
    newBlob: function () { return {} },
    base64Decode: function () { return [] }
  };
  var DriveApp = {}, UrlFetchApp = {}, Session = {};
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
    withScriptLock_, withScriptLockOptional_, holdsScriptLock_,
    MAX_SKUS_PER_PRODUCT, VALUE_NAME_MAX, VARIANT_ATTRIBUTE_NAME
  };
`

// Written to a temp file rather than eval'd, so a syntax error reports a real
// line number in a real file.
const loaded = path.join(os.tmpdir(), 'tikshop-gs-loaded.cjs')
fs.writeFileSync(loaded, 'const LOCK_STATE = global.__LOCK_STATE__;\n' + sandbox)
global.__LOCK_STATE__ = lockState
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

console.log('\n' + pass + ' passed, ' + fail + ' failed\n')
process.exit(fail ? 1 : 0)
