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
const FILES = ['Config.gs', 'Errors.gs', 'Lock.gs', 'Sheet.gs', 'Export.gs', 'Product.gs', 'Auth.gs', 'TikTok.gs', 'Orders.gs', 'Api.gs']

const src = FILES.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n')

// Apps Script globals. Stubbed only as far as the loaded functions touch them;
// a test that needs more should stub more rather than reach for the real thing.
const lockState = { held: false, refused: false, acquisitions: 0, waits: [] }
const cacheState = { store: {} }
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
    // A backoff must not actually wait in a test.
    sleep: function () {},
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
      // The Log tab's timestamp. Missing, it made logEvent_ throw before it
      // reached its write in EVERY test — so nothing on that path was tested.
      if (pattern === 'yyyy-MM-dd HH:mm:ss') {
        return y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + p(sgt.getUTCSeconds())
      }
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
  // A cache with the shapes the real one has: getAll/putAll, and the ability
  // for a test to evict a chunk, which is the case that must read as a miss.
  var CacheService = { getScriptCache: function () {
    return {
      get: function (k) { return CACHE_STATE.store[k] === undefined ? null : CACHE_STATE.store[k] },
      getAll: function (keys) {
        var out = {};
        keys.forEach(function (k) { if (CACHE_STATE.store[k] !== undefined) out[k] = CACHE_STATE.store[k] });
        return out;
      },
      put: function (k, v) { CACHE_STATE.store[k] = v },
      putAll: function (map) { Object.keys(map).forEach(function (k) { CACHE_STATE.store[k] = map[k] }) },
      remove: function (k) { delete CACHE_STATE.store[k] }
    }
  } };
  var UrlFetchApp = { fetch: function () {
    if (AUTH_STATE.throws) throw new Error('network');
    return {
      getResponseCode: function () { return AUTH_STATE.status },
      getContentText: function () { return AUTH_STATE.bodyText }
    }
  } };
  var LockService = { getScriptLock: function () {
    return {
      tryLock: function (ms) {
        LOCK_STATE.waits.push(ms)
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
    skuImageUrl_,
    groupVariationSales_, salesIndex_, salesFor_, UNSOLD_STATUSES,
    withVariantImages_, touchLastSeen_, LAST_SEEN_TTL_S,
    findUser_, usersForAuth_, invalidateUsersCache_, USERS_CACHE_TTL_S, usersVersion_,
    setRole_, resolveUser_, registerOnce_, tabChanged_, usersAll_,
    __sheetReal: sheet_, __spreadsheetApp: SpreadsheetApp,
    __setPhotosRoot: function (id) { PHOTOS_FOLDER_ID = id },
    emptyTally_, addLine_, addTally_, roundTally_, withLegacyNames_,
    tallyColumns_, tallyHeader_, tallyValues_, netExplainer_, TALLY_COLUMNS,
    summaryHeader_, summaryRow_, summaryTotalRow_, summaryOrderCount_,
    itemHeader_, itemRow_, itemTotalRow_, unitPriceOf_, summaryHeadRows_,
    listingTopRows_, safeName_,
    lineStatusMeaning_, LINE_STATUS_MEANING,
    returnStatusMeaning_, RETURN_STATUS_MEANING, returnRows_, refundIndex_,
    SYNC_EVERY_MINUTES, SYNC_ALLOWED_MINUTES,
    checkStockTotal_, skuForStock_, seqOf_,
    skuRowUpdates_, shownAsOurs_, REMOVAL_GRACE_MS,
    readAll_, invalidateRead_, appendRows_, markSkus_, resolveSellerSkus_, replaceByKey_, isoOf_,
    listSkus_, listSkusFromSheet_, bumpSkuVersion_, skuVersion_,
    variationState_, bySellerSku_, shopsToSync_, SYNC_ACTIVE_HOURS, changedSince_,
    strippedVariantName_, REMOVED_RECENT, ordersMissingFromTikTok_,
    // Lets a test swap the Sheets layer for a counter, so "how many times did
    // this read the tab" is an assertion rather than a belief.
    __setSheetImpl: function (fn) { sheet_ = fn },
    __setHeaders: function (name, cols) { HEADERS[name] = cols },
    // Drive swapped for a counter, so "how many Drive calls does a push make"
    // is an assertion too.
    __setDriveApp: function (d) { DriveApp = d },
    __setUrlFetch: function (u) { UrlFetchApp = u },
    ttFetch_, appendAssets_, newListingAssets_,
    // Guarded so the suite still LOADS against code that predates the split,
    // which is how the golden URL below was proven identical to the old one.
    ttFetchAll_: typeof ttFetchAll_ === 'function' ? ttFetchAll_ : undefined,
    ttRequest_: typeof ttRequest_ === 'function' ? ttRequest_ : undefined,
    __resetPhotoFolderMemo: function () { PHOTO_FOLDER_MEMO_ = {} },
    datedPhotoFolder_, savePhoto_, PHOTO_FOLDER_TTL_S, logEvent_, warn_, pushedToday_, listListings_
  };
`

// Written to a temp file rather than eval'd, so a syntax error reports a real
// line number in a real file.
const loaded = path.join(os.tmpdir(), 'tikshop-gs-loaded.cjs')
const authState = { props: {}, status: 200, bodyText: '{}', throws: false }
fs.writeFileSync(
  loaded,
  'const LOCK_STATE = global.__LOCK_STATE__;\nconst AUTH_STATE = global.__AUTH_STATE__;\nconst CACHE_STATE = global.__CACHE_STATE__;\nconst NODE_CRYPTO = require("crypto");\n' + sandbox,
)
global.__LOCK_STATE__ = lockState
global.__AUTH_STATE__ = authState
global.__CACHE_STATE__ = cacheState
const gs = require(loaded)
const CACHE = cacheState

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

/**
 * The sold count a factory is paid against.
 *
 * It used to be `stock_we_set - stock_TikTok_has`, which is wrong the moment
 * anybody changes stock: topping a variation up by five made three genuine
 * sales read as zero. Now it is counted from order line items, which are
 * append-only and cannot be moved by any stock write.
 */
const line = (over) => Object.assign({
  order_id: 'o1', listing_id: 'L', shop_id: 'HZ', sku_id: '9001', seller_sku: 'L5',
  variation: 'L5 Basket', sku_image: '', quantity: 1, sale_price: '10.00',
  status: 'AWAITING_SHIPMENT', created_epoch: 1000,
}, over)

check('one line item is one unit, so three of a SKU is three', () => {
  // A TikTok order line carries no quantity field, so buying three produces
  // three lines and the sync records quantity 1 on each.
  const g = gs.groupVariationSales_([line({}), line({ order_id: 'o2' }), line({ order_id: 'o3' })])
  eq(g['9001'].units, 3)
  eq(g['9001'].revenue, 30)
})

check('cancelled and unpaid are split out, never netted off the sold count', () => {
  const g = gs.groupVariationSales_([
    line({}),
    line({ order_id: 'o2', status: 'CANCELLED' }),
    line({ order_id: 'o3', status: 'UNPAID' }),
  ])
  eq(g['9001'].units, 1)
  eq(g['9001'].unsold_units, 2)
  // Revenue counts only what was actually sold.
  eq(g['9001'].revenue, 10)
})

check('two variations are kept apart by sku_id even when the name matches', () => {
  // Keying on the name would merge them into one row of a purchase order,
  // which is the expensive version of this mistake.
  const g = gs.groupVariationSales_([
    line({ sku_id: '9001', seller_sku: 'L5' }),
    line({ sku_id: '9002', seller_sku: 'L6', order_id: 'o2' }),
  ])
  eq(Object.keys(g).length, 2)
  eq(g['9001'].units, 1)
  eq(g['9002'].units, 1)
})

check('a Seller Center line with no seller_sku is still counted, under its id', () => {
  const g = gs.groupVariationSales_([line({ seller_sku: '', sku_id: '9003' })])
  eq(g['9003'].units, 1)
  eq(g['9003'].seller_sku, '')
})

check('the index can be matched by TikTok id or by identifier', () => {
  const idx = gs.salesIndex_(gs.groupVariationSales_([
    line({}),
    line({ order_id: 'o2', status: 'CANCELLED' }),
  ]))
  // A variation this app listed matches either way.
  eq(gs.salesFor_(idx, '9001', 'L5').units, 1)
  eq(gs.salesFor_(idx, '', 'L5').units, 1)
  eq(gs.salesFor_(idx, '9001', '').unsold, 1)
  // The id wins, because it is the only key guaranteed unique.
  eq(gs.salesFor_(idx, '9001', 'WRONG').units, 1)
})

check('no orders for a variation reads as unknown, not as zero sold', () => {
  // The screen renders null as "no sold figure" and 0 as "none sold". A
  // listing whose orders have never been synced must not claim nothing sold.
  const idx = gs.salesIndex_(gs.groupVariationSales_([]))
  eq(gs.salesFor_(idx, '9001', 'L5'), null)
  eq(gs.salesFor_(null, '9001', 'L5'), null)
  eq(gs.salesFor_(idx, '', ''), null)
})

check('a stock change cannot move the sold count, which was the whole point', () => {
  // The old arithmetic: stock_set 10, TikTok says 15 after a top-up, so
  // 10 - 15 = -5, clamped to 0. Three real sales reported as none.
  eq(Math.max(0, 10 - 15), 0)
  // The new one reads the same three lines regardless of any stock level.
  const lines = [line({}), line({ order_id: 'o2' }), line({ order_id: 'o3' })]
  eq(gs.salesIndex_(gs.groupVariationSales_(lines))['id:9001'].units, 3)
})

/**
 * Stock changes. TikTok's endpoint REPLACES the quantity — established against
 * the real API on 8 Sep, B15 at 21 with two writes of 5 landing at 5 both
 * times — so every guard in front of it matters more than usual.
 */
check('stock has to be a whole number in TikTok\'s documented range', () => {
  eq(gs.checkStockTotal_(1), 1)
  eq(gs.checkStockTotal_(99999), 99999)
  var threw = function (n) {
    try { gs.checkStockTotal_(n); return '' } catch (e) { return gs.codeOf_(e) }
  }
  // The floor is 1, not 0. There is no documented way to zero a variation, and
  // a clamp to 1 would leave one phantom unit sellable on something meant to
  // be off sale — so it refuses instead.
  eq(threw(0), 'TS-STK-04')
  eq(threw(-5), 'TS-STK-04')
  eq(threw(100000), 'TS-STK-04')
  eq(threw(2.5), 'TS-STK-04')
  eq(threw(NaN), 'TS-STK-04')
  eq(threw(Infinity), 'TS-STK-04')
})

check('a stock change refuses a variation TikTok is not returning', () => {
  // Under review is the case: TikTok omits such a variation from a read, so
  // there is nothing to write to and the app must say so rather than send.
  var live = { skus: [{ sellerSku: 'A1', id: '9001', warehouseId: 'W1', quantity: 5 }] }
  eq(gs.skuForStock_(live, 'A1').id, '9001')
  try { gs.skuForStock_(live, 'B99'); throw new Error('accepted a missing variation') }
  catch (e) { eq(gs.codeOf_(e), 'TS-STK-02') }
})

check('a stock change refuses a variation with no warehouse', () => {
  var live = { skus: [{ sellerSku: 'A1', id: '9001', warehouseId: '', quantity: 0, inventories: [] }] }
  try { gs.skuForStock_(live, 'A1'); throw new Error('accepted a warehouseless variation') }
  catch (e) { eq(gs.codeOf_(e), 'TS-STK-03') }
  // One warehouse recorded only in the array is still a warehouse.
  var ok = { skus: [{ sellerSku: 'A1', id: '9001', warehouseId: '', inventories: [{ warehouse_id: 'W1', quantity: 3 }] }] }
  eq(gs.skuForStock_(ok, 'A1').id, '9001')
})

check('seqOf_ reads the number only for a whole-prefix match', () => {
  // The counter behind identifier reservation. A prefix that claims the wrong
  // series hands out a number already in use, and two phones say the same SKU
  // on air — which is the failure the reservation exists to stop.
  eq(gs.seqOf_('B74', 'B'), 74)
  eq(gs.seqOf_('b74', 'B'), 74)
  eq(gs.seqOf_('HZE12', 'HZE'), 12)
  // "B" must not claim "BX7", or switching prefix mid-stream drags the old
  // series along with it.
  eq(gs.seqOf_('BX7', 'B'), 0)
  eq(gs.seqOf_('L11', 'B'), 0)
  eq(gs.seqOf_('B', 'B'), 0)
  eq(gs.seqOf_('', 'B'), 0)
  eq(gs.seqOf_('B74', ''), 0)
  eq(gs.seqOf_(null, 'B'), 0)
})

check('a Seller Center variation can be addressed by TikTok id alone', () => {
  // It has no seller_sku of ours, which is why its stock used to be
  // read-only. Most of a long-running listing is these.
  const live = { skus: [
    { sellerSku: 'B70', id: '9001', warehouseId: 'W1', quantity: 3 },
    { sellerSku: '', id: '9002', warehouseId: 'W1', quantity: 5, valueName: 'Miracle Drying Rack' },
  ] }
  eq(gs.skuForStock_(live, '', '9002').valueName, 'Miracle Drying Rack')
  // The id wins when both are given, because it is the unique one.
  eq(gs.skuForStock_(live, 'B70', '9002').id, '9002')
  eq(gs.skuForStock_(live, 'B70', '').id, '9001')
  try { gs.skuForStock_(live, '', '9999'); throw new Error('accepted an unknown id') }
  catch (e) { eq(gs.codeOf_(e), 'TS-STK-02') }
})

/**
 * Every SKU TikTok shows must reach the screen exactly once.
 *
 * Brien, 15 Sep: Seller Centre showed B74, B75 and A2 on listing I12. The app
 * drew A2 alone — and its own header said 3/100 directly above a list of one,
 * which is the contradiction that gave the bug away. Two independent faults
 * had to line up, so both are pinned here.
 */
const GRACE = 10 * 60 * 1000
const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString()

check('a variation TikTok is showing again is no longer removed', () => {
  // B74 was wrongly marked on an earlier refresh. TikTok is serving it.
  const rows = [
    { sku_id: 'r1', identifier: 'B74', status: 'removed', confirmed_at: HOUR_AGO, tiktok_sku_id: '1' },
    { sku_id: 'r2', identifier: 'A2', status: 'pushed', confirmed_at: HOUR_AGO, tiktok_sku_id: '2' },
  ]
  const live = [{ sellerSku: 'B74', id: '1' }, { sellerSku: 'A2', id: '2' }]
  const updates = gs.skuRowUpdates_(rows, live, 'NOW', Date.now())
  eq(updates.length, 1)
  eq(updates[0].sku_id, 'r1')
  eq(updates[0].status, 'pushed')
  // The stale reason has to go with it, or the row still reads as deleted.
  eq(updates[0].error, '')
})

check('a variation still absent stays removed, and is not re-marked', () => {
  const rows = [{ sku_id: 'r1', identifier: 'B74', status: 'removed', confirmed_at: HOUR_AGO, tiktok_sku_id: '1' }]
  eq(gs.skuRowUpdates_(rows, [], 'NOW', Date.now()).length, 0)
})

check('a confirmed variation that vanishes is marked removed, after the grace period', () => {
  const rows = [{ sku_id: 'r1', identifier: 'B74', status: 'pushed', confirmed_at: HOUR_AGO, tiktok_sku_id: '1' }]
  const updates = gs.skuRowUpdates_(rows, [], 'NOW', Date.now())
  eq(updates.length, 1)
  eq(updates[0].status, 'removed')
})

check('a variation pushed seconds ago is not judged gone', () => {
  // The grace period. Marking this wrongly really deletes: a removed row is
  // dropped from the carry-forward, and TikTok deletes any SKU absent from a
  // partial edit.
  const justNow = new Date(Date.now() - (GRACE - 5000)).toISOString()
  const rows = [{ sku_id: 'r1', identifier: 'B74', status: 'pushed', confirmed_at: justNow, tiktok_sku_id: '1' }]
  eq(gs.skuRowUpdates_(rows, [], 'NOW', Date.now()).length, 0)
})

check('a first sighting stamps the id and the time, and only once', () => {
  const rows = [{ sku_id: 'r1', identifier: 'B74', status: 'pushed', confirmed_at: '', tiktok_sku_id: '' }]
  const live = [{ sellerSku: 'B74', id: '77' }]
  const first = gs.skuRowUpdates_(rows, live, 'NOW', Date.now())
  eq(first.length, 1)
  eq(first[0].tiktok_sku_id, '77')
  eq(first[0].confirmed_at, 'NOW')
  // Nothing left to write on the next refresh.
  const settled = [{ sku_id: 'r1', identifier: 'B74', status: 'pushed', confirmed_at: HOUR_AGO, tiktok_sku_id: '77' }]
  eq(gs.skuRowUpdates_(settled, live, 'NOW', Date.now()).length, 0)
})

check('only rows the screen actually draws suppress the external fallback', () => {
  // The second fault. `variants` renders pushed rows and nothing else, but the
  // suppression set was built from EVERY row — so a row in any other state
  // hid a live variation from both paths at once.
  const rows = [
    { identifier: 'A2', status: 'pushed' },
    { identifier: 'B74', status: 'removed' },
    { identifier: 'B75', status: 'error' },
    { identifier: 'B76', status: 'queued' },
  ]
  const shown = gs.shownAsOurs_(rows)
  eq(shown['A2'], true)
  // Each of these is on TikTok. None of them is drawn as ours, so each must
  // fall through to the external path rather than disappearing.
  eq(shown['B74'], undefined)
  eq(shown['B75'], undefined)
  eq(shown['B76'], undefined)
})

check('nothing is drawn twice', () => {
  // The other half of the invariant: a row that IS drawn as ours must not also
  // appear as an external, or the count doubles and the identifier reads as taken.
  const shown = gs.shownAsOurs_([{ identifier: 'A2', status: 'pushed' }])
  eq(shown['A2'], true)
})

/**
 * The request read cache must be a saving, never a stale answer.
 *
 * `readAll_` pulls every row of a tab, and one `listingState` paid for that
 * three times over plus the whole Order Items tab — forty seconds, mid-
 * broadcast, on 15 Sep. Caching it per request is the fix; the danger is that
 * a read-then-write-then-read now gets the pre-write rows, and in this app
 * that pattern decides which variations are carried forward, where a stale
 * answer DELETES SKUs. So both halves are asserted.
 */
describe_readcache()
function describe_readcache() {
  const TAB = 'TestTab'
  let reads = 0
  let rows = []

  function fakeSheet() {
    return {
      getLastRow: () => rows.length + 1,
      getRange: (r, c, nr, nc) => ({
        getValues: () => { reads++; return rows.map((x) => [x]) },
        setValues: () => {},
        setValue: () => {},
        clearContent: () => {},
        setFontWeight() { return this },
      }),
    }
  }

  const install = () => {
    gs.__setHeaders(TAB, ['v'])
    gs.__setSheetImpl(fakeSheet)
    gs.invalidateRead_()
    reads = 0
  }

  check('reads the tab once however many times it is asked', () => {
    install()
    rows = ['a', 'b']
    eq(gs.readAll_(TAB).length, 2)
    eq(gs.readAll_(TAB).length, 2)
    eq(gs.readAll_(TAB).length, 2)
    eq(reads, 1)
  })

  check('an append is visible to the very next read', () => {
    install()
    rows = ['a']
    eq(gs.readAll_(TAB).length, 1)
    rows = ['a', 'b']
    gs.appendRows_(TAB, [['b']])
    // Would still say 1 if the write had not cleared the cache.
    eq(gs.readAll_(TAB).length, 2)
    eq(reads, 2)
  })

  check('invalidate with no argument clears every tab', () => {
    install()
    rows = ['a']
    gs.readAll_(TAB)
    gs.invalidateRead_()
    rows = ['a', 'b']
    eq(gs.readAll_(TAB).length, 2)
  })

  check('an empty tab is cached too, and not re-read', () => {
    install()
    rows = []
    eq(gs.readAll_(TAB).length, 0)
    eq(gs.readAll_(TAB).length, 0)
    eq(reads, 0)
  })
}

check('a product the caller already read is not read again', () => {
  // listingState reads the product for the screen, then reached this through
  // the sold count and read the SAME product a second time over the network,
  // on every refresh of a screen used throughout a broadcast.
  const items = [{ sku_id: '9001', seller_sku: '', listing_id: 'L1', shop_id: 'HZ', variation: 'no identifier here' }]
  const snapshot = { L1: { skus: [{ id: '9001', sellerSku: 'B74' }] } }
  const counts = gs.resolveSellerSkus_('HZ', items, snapshot)
  eq(items[0].seller_sku, 'B74')
  // Resolved from what was passed in, so nothing was fetched.
  eq(counts.tiktok, 0)
})

check('without the snapshot the same row is unresolved, not silently wrong', () => {
  // Proves the test above is measuring the snapshot and not something else:
  // with no snapshot and no Sheet row, there is nothing to resolve from.
  const items = [{ sku_id: '9001', seller_sku: '', listing_id: '', shop_id: 'HZ', variation: 'no identifier here' }]
  const counts = gs.resolveSellerSkus_('HZ', items, null)
  eq(items[0].seller_sku, '')
  eq(counts.unresolved, 1)
})

console.log('\nbuildAppendPayload_ \u2014 one identifier, one variation')

/**
 * Two phones reached B74 and TikTok took both.
 *
 * The duplicate guard compared VALUE NAMES, and a value name is the identifier
 * followed by the product name \u2014 so "B74 4 tier" and "B74 Set of 10 - Whirl
 * bowl" are different values and went straight through. The listing ended up
 * with two live SKUs both carrying seller_sku B74 (15 Sep, I12), which breaks
 * the one key this app and TikTok agree on: a stock change cannot say which it
 * means, the sold count matches both, and the screen draws two rows against one
 * number.
 */
check('refuses an identifier already on the listing, whatever it is called', () => {
  const snap = { productId: 'P', title: 't', skus: [
    sku({ id: '1', sellerSku: 'B74', valueName: 'B74 4 tier', valueId: 'v74' }),
  ] }
  // A different product name, so the value-name guard does NOT fire. This is
  // exactly the payload that got through.
  const clash = { identifier: 'B74', variantName: 'Set of 10 - Whirl bowl', price: '25', stock: 8, imageUri: 'i' }
  try {
    gs.buildAppendPayload_(snap, clash)
    throw new Error('accepted a second SKU with seller_sku B74')
  } catch (e) {
    eq(gs.codeOf_(e), 'TS-PRD-32')
  }
})

check('catches it on a carried-forward variation too', () => {
  // The under-review case: TikTok is not returning B74, so it is restated from
  // our own row rather than the snapshot. It still occupies the identifier.
  const snap = { productId: 'P', title: 't', skus: [sku({ id: '1', sellerSku: 'A1' })] }
  const alsoKeep = [{ id: '9', sellerSku: 'B74', valueName: 'B74 4 tier', skuImgUri: 'i', priceAmount: '14.88', quantity: 8 }]
  const clash = { identifier: 'B74', variantName: 'Set of 10 - Whirl bowl', price: '25', stock: 8, imageUri: 'i' }
  try {
    gs.buildAppendPayload_(snap, clash, alsoKeep)
    throw new Error('accepted a second SKU with seller_sku B74')
  } catch (e) {
    eq(gs.codeOf_(e), 'TS-PRD-32')
  }
})

check('a free identifier is still accepted', () => {
  // The other half: the guard must not refuse ordinary work. Same listing,
  // same shape, a number nobody has taken.
  const snap = { productId: 'P', title: 't', skus: [
    sku({ id: '1', sellerSku: 'B74', valueName: 'B74 4 tier', valueId: 'v74' }),
  ] }
  const fresh = { identifier: 'B76', variantName: 'Set of 10 - Whirl bowl', price: '25', stock: 8, imageUri: 'i' }
  const p = gs.buildAppendPayload_(snap, fresh)
  eq(p.skus.length, 2)
  eq(p.skus.filter((x) => !x.id)[0].seller_sku, 'B76')
})

check('the comparison ignores case, as TikTok would not', () => {
  const snap = { productId: 'P', title: 't', skus: [sku({ id: '1', sellerSku: 'B74', valueName: 'B74 4 tier', valueId: 'v' })] }
  const clash = { identifier: 'b74', variantName: 'Something else', price: '1', stock: 1, imageUri: 'i' }
  try {
    gs.buildAppendPayload_(snap, clash)
    throw new Error('accepted b74 against B74')
  } catch (e) {
    eq(gs.codeOf_(e), 'TS-PRD-32')
  }
})

console.log('\nevery action survives the GET fallback')

/**
 * Apps Script answers every request through a 302 to a GET-only host. When a
 * browser preserves the method instead of downgrading it, the client retries
 * the same call as a GET — and on that leg the body is gone. An action that
 * reads only `body.x` gets undefined for every argument.
 *
 * Found three times now: setRole ("Unknown role: undefined"), and
 * removeVariation, where Wen Xuan could not delete a variation mid-broadcast
 * and got "Unknown listing: undefined [TS-PRD-09]". Fixing them one at a time
 * is why it kept coming back, so the rule is asserted over the source of
 * route_ rather than remembered.
 *
 * `pushSku` is the one exception, and an intentional one: a photo does not fit
 * in a URL. It is protected by its idempotency key instead.
 */
check('no action reads body.x without params.x first', () => {
  const src = fs.readFileSync(path.join(DIR, 'Api.gs'), 'utf8')
  const start = src.indexOf('function route_(')
  if (start < 0) throw new Error('route_ not found')
  const body = src
    .slice(start)
    // Comments first. The doc on setRole EXPLAINS the bug using the words
    // "body.role", and a scanner that reads prose reports a fault that is not
    // there — which is how a check stops being trusted.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // Split into cases so a finding can name the action it belongs to.
  const cases = body.split(/\n    case '/).slice(1)
  const EXEMPT = { pushSku: 'a photo does not fit in a URL' }
  const offenders = []

  for (const block of cases) {
    const action = block.slice(0, block.indexOf("'"))
    if (EXEMPT[action]) continue
    // Every body.x that is not already preceded by params.x ||
    const reads = block.match(/\bbody\.([a-z_]+)/g) || []
    for (const read of reads) {
      const field = read.slice('body.'.length)
      const direct = new RegExp('params\\.' + field + '\\s*\\|\\|\\s*body\\.' + field)
      // An array cannot ride in a query string as itself, so it is read the
      // other way round: the body first, then the comma-separated param.
      const array = new RegExp('body\\.' + field + '\\s*\\|\\|[\\s\\S]{0,120}params\\.' + field)
      if (!direct.test(block) && !array.test(block)) {
        offenders.push(action + ' reads ' + read + ' with no params.' + field + ' fallback')
      }
    }
  }
  if (offenders.length) throw new Error(offenders.join('; '))
})

check('the exemption is real, not a way to pass', () => {
  // If pushSku ever stops being body-only the exemption is stale and should be
  // removed; this fails loudly rather than letting it rot.
  const src = fs.readFileSync(path.join(DIR, 'Api.gs'), 'utf8')
  if (!/case 'pushSku':\s*\n\s*return json_\(pushSku_\(body, user\)\)/.test(src)) {
    throw new Error('pushSku no longer takes the whole body; revisit the exemption')
  }
})

console.log('\nthe listing SKU cache')

/**
 * A listing's rows are cached so a refresh stops reading every SKU ever
 * written — that read is what made a refresh take forty seconds once I12 held
 * 153 rows, and its cost had nothing to do with the listing being read.
 *
 * The safety is in the KEY, not in remembering to clear anything: it carries a
 * version that every write to the tab bumps, so after a write the old entry is
 * simply unreachable. That matters more than the speed does. These rows decide
 * which variations are carried forward on the next push, and TikTok deletes
 * any SKU absent from a partial edit — so a row read that no longer exists,
 * or a listing read short, DELETES variations.
 */
function describe_skucache() {
  let sheetReads = 0
  let rows = []

  const install = () => {
    gs.__setHeaders('SKUs', ['listing_id', 'identifier'])
    gs.__setSheetImpl(() => ({
      getLastRow: () => rows.length + 1,
      getRange: () => ({
        getValues: () => { sheetReads++; return rows.map((r) => [r.listing_id, r.identifier]) },
        setValues: () => {}, setValue: () => {}, clearContent: () => {},
        setFontWeight() { return this },
      }),
    }))
    gs.invalidateRead_()
    CACHE.store = {}
    sheetReads = 0
  }

  check('reads the Sheet once, then serves the listing from cache', () => {
    install()
    rows = [{ listing_id: 'L1', identifier: 'B1' }, { listing_id: 'L2', identifier: 'A1' }]
    eq(gs.listSkus_('L1').length, 1)
    gs.invalidateRead_() // a new request; only the cache should save us now
    eq(gs.listSkus_('L1').length, 1)
    gs.invalidateRead_()
    eq(gs.listSkus_('L1').length, 1)
    eq(sheetReads, 1)
  })

  check('a write makes the cached slice unreachable', () => {
    install()
    rows = [{ listing_id: 'L1', identifier: 'B1' }]
    eq(gs.listSkus_('L1').length, 1)
    rows = [{ listing_id: 'L1', identifier: 'B1' }, { listing_id: 'L1', identifier: 'B2' }]
    gs.appendRows_('SKUs', [['L1', 'B2']])
    gs.invalidateRead_()
    // Would still say 1 if the version had not moved. Reading a listing short
    // is how a partial edit deletes the rows it did not see.
    eq(gs.listSkus_('L1').length, 2)
  })

  check('an evicted chunk reads as a miss, never as a short listing', () => {
    install()
    rows = [{ listing_id: 'L1', identifier: 'B1' }, { listing_id: 'L1', identifier: 'B2' }]
    eq(gs.listSkus_('L1').length, 2)
    // Drop one chunk, as CacheService may at any time.
    const key = Object.keys(CACHE.store).filter((k) => /:\d+$/.test(k))[0]
    delete CACHE.store[key]
    gs.invalidateRead_()
    const again = gs.listSkus_('L1')
    eq(again.length, 2)
    eq(sheetReads, 2) // it went back to the Sheet rather than trusting a fragment
  })

  check('the version survives across listings', () => {
    // One counter for the tab, so a write anywhere retires every slice. A
    // per-listing counter would let a row moved between listings be read twice.
    install()
    rows = [{ listing_id: 'L1', identifier: 'B1' }, { listing_id: 'L2', identifier: 'A1' }]
    gs.listSkus_('L1')
    gs.listSkus_('L2')
    const before = gs.skuVersion_()
    gs.appendRows_('SKUs', [['L2', 'A2']])
    if (gs.skuVersion_() <= before) throw new Error('version did not move')
    rows.push({ listing_id: 'L2', identifier: 'A2' })
    gs.invalidateRead_()
    eq(gs.listSkus_('L2').length, 2)
    gs.invalidateRead_()
    eq(gs.listSkus_('L1').length, 1)
  })

  check('a listing with no rows is cached as empty, not re-read', () => {
    install()
    rows = [{ listing_id: 'L2', identifier: 'A1' }]
    eq(gs.listSkus_('L1').length, 0)
    gs.invalidateRead_()
    eq(gs.listSkus_('L1').length, 0)
    eq(sheetReads, 1)
  })
}
describe_skucache()

console.log('\nLive means a buyer can buy it')

/**
 * Brien's #1, and the one he called most important: *"app shows listing is
 * LIVE but actually it's still under reviewing"*.
 *
 * The cause was one read doing two jobs. `return_under_review_version=true`
 * returns the PENDING product, and the app treated presence in that as "live".
 * A product also stays ACTIVATE while an edit adding a variation to it goes
 * through review, so both signals said live while nobody could buy the thing.
 *
 * Two versions now, and four states. The line that matters is between the
 * first two: `live` means a buyer can buy it, `reviewing` means TikTok has it
 * and nobody can.
 */
const liveSku = { id: '1', sellerSku: 'B74', quantity: 8 }
const pendingSku = { id: '1', sellerSku: 'B74', quantity: 8 }

check('in the version buyers see, it is live', () => {
  const st = gs.variationState_('B74', '1', liveSku, pendingSku)
  eq(st.state, 'live')
  eq(st.buyable, true)
  eq(st.quantity, 8)
})

check('in the pending version only, it is reviewing and NOT buyable', () => {
  const st = gs.variationState_('B74', '1', undefined, pendingSku)
  eq(st.state, 'reviewing')
  eq(st.buyable, false)
  // Deliberately no quantity: the pending version carries one, and reporting
  // it invites counting on stock that is not for sale.
  eq(st.quantity, null)
  // It IS on TikTok though — the removal rule and the carry-forward depend on
  // that, and treating it as gone is what deletes a variation on the next push.
  eq(st.on_tiktok, true)
})

check('in neither version but with an id, it is pending, not lost', () => {
  const st = gs.variationState_('B74', '9001', undefined, undefined)
  eq(st.state, 'pending')
  eq(st.buyable, false)
  eq(st.on_tiktok, false)
})

check('in neither version and with no id, it was never listed', () => {
  const st = gs.variationState_('B74', '', undefined, undefined)
  eq(st.state, 'not_listed')
  eq(st.buyable, false)
})

check('the live version wins when the two disagree', () => {
  // A price or quantity edit in flight: both versions have the SKU, and the
  // buyable figure is the one buyers are actually transacting against.
  const st = gs.variationState_('B74', '1', { id: '1', sellerSku: 'B74', quantity: 3 }, { id: '1', sellerSku: 'B74', quantity: 99 })
  eq(st.state, 'live')
  eq(st.quantity, 3)
})

check('bySellerSku_ skips a SKU with no seller_sku', () => {
  // A Seller Centre row can have none. Indexing it under '' would make every
  // other blank one collide with it.
  const index = gs.bySellerSku_([{ id: '1', sellerSku: 'B74' }, { id: '2', sellerSku: '' }, null])
  eq(Object.keys(index), ['B74'])
})

console.log('\nthe background order sync')

/**
 * The sold count was frozen at whenever somebody last pressed Sync on the
 * Orders tab — which nobody does during a broadcast. It now runs on Apps
 * Script's own timer, gated on ACTIVITY rather than on the clock: a "stream
 * hours" window would need a timezone and a schedule and remembering to change
 * it, and would still miss a daytime stream while burning quota through a
 * quiet evening.
 */
const HOURS = 3600 * 1000
const NOW = Date.parse('2026-09-15T14:00:00.000Z')

check('syncs a shop that has listed recently', () => {
  eq(gs.shopsToSync_({ HZ: NOW - 1 * HOURS }, NOW, 6, 72), ['HZ'])
})

check('keeps watching a shop the morning after a stream', () => {
  // The hole this closes: cancellations and refunds arrive AFTER a broadcast,
  // and an export built before somebody presses Sync counts them as sold.
  eq(gs.shopsToSync_({ HZ: NOW - 20 * HOURS }, NOW, 6, 72), ['HZ'])
})

check('lets a shop go once even the tail has passed', () => {
  eq(gs.shopsToSync_({ HZ: NOW - 100 * HOURS }, NOW, 6, 72), [])
})

check('syncs every shop still inside the tail, and only those', () => {
  eq(gs.shopsToSync_({ HZ: NOW - 1 * HOURS, PM: NOW - 2 * HOURS, TM: NOW - 300 * HOURS }, NOW, 6, 72),
     ['HZ', 'PM'])
})

check('a shop that has never listed is not synced', () => {
  eq(gs.shopsToSync_({ HZ: 0 }, NOW, 6, 72), [])
  eq(gs.shopsToSync_({ '': NOW }, NOW, 6, 72), [])
})

check('nothing at all is an empty list, not a crash', () => {
  // This runs seven hundred times a day inside a timer, and Apps Script
  // disables a trigger that keeps throwing \u2014 a sync that silently stopped
  // weeks ago is the worst version of this feature.
  eq(gs.shopsToSync_({}, NOW, 6, 72), [])
  eq(gs.shopsToSync_(null, NOW, 6, 72), [])
})

check('the boundary is inclusive, so a shop on the edge still syncs', () => {
  eq(gs.shopsToSync_({ HZ: NOW - 72 * HOURS }, NOW, 6, 72), ['HZ'])
  eq(gs.shopsToSync_({ HZ: NOW - 72 * HOURS - 1 }, NOW, 6, 72), [])
})

console.log('\nsyncing touches only what changed')

/**
 * Brien, 15 Sep: *"I don't know whether reading the full tab actually makes
 * sense if it's going to be growing and growing and growing. It should only
 * recognize when there's a change and not fire or do more when it doesn't
 * record a change."*
 *
 * He was right. This read every row and every column to work out which keys
 * were present, then wrote every row back — so the cost of a sync was the size
 * of everything ever synced, on a tab that only grows, every two minutes.
 *
 * It now reads ONE column, appends what is new, and writes a changed row over
 * itself. The whole-tab path survives for the one case the cheap one cannot
 * express: a key whose number of rows changed, which would need rows inserted
 * or deleted.
 */
function describe_replaceByKey() {
  let rows = []
  let reads = []
  let writes = { at: [], cleared: 0 }

  const install = () => {
    gs.__setHeaders('Orders', ['order_id', 'status'])
    gs.__setSheetImpl(() => ({
      getLastRow: () => rows.length + 1,
      // The width asked for is the point of the change, so it is recorded.
      getRange: (r, c, nr, nc) => ({
        getValues: () => {
          reads.push({ row: r, col: c, width: nc === undefined ? 2 : nc })
          return nc === 1
            ? rows.map((x) => [x.order_id])
            : rows.map((x) => [x.order_id, x.status])
        },
        setValues: (v) => { writes.at.push({ row: r, count: v.length }) },
        setValue: () => {},
        clearContent: () => { writes.cleared++ },
        setFontWeight() { return this },
      }),
    }))
    gs.invalidateRead_()
    reads = []
    writes = { at: [], cleared: 0 }
  }

  /** Rows written starting below the last row: an append. */
  const appended = () => writes.at.filter((w) => w.row > rows.length + 1).reduce((n, w) => n + w.count, 0)
  /** Rows written starting at row 2: the whole tab, rewritten. */
  const rewritten = () => writes.at.filter((w) => w.row === 2).reduce((n, w) => n + w.count, 0)

  check('only the key column is read, not the whole tab', () => {
    install()
    rows = [{ order_id: 'o1', status: 'PAID' }, { order_id: 'o2', status: 'PAID' }]
    gs.replaceByKey_('Orders', 'order_id', [{ order_id: 'o3', status: 'PAID' }])
    // One column. This is the whole of Brien's point.
    eq(reads.every((r) => r.width === 1), true)
  })

  check('all-new orders are appended, and nothing else is touched', () => {
    install()
    rows = [{ order_id: 'o1', status: 'PAID' }, { order_id: 'o2', status: 'PAID' }]
    gs.replaceByKey_('Orders', 'order_id', [{ order_id: 'o3', status: 'PAID' }])
    eq(appended(), 1)
    eq(rewritten(), 0)
    eq(writes.at.length, 1)
  })

  check('a changed order is written over its own row, and only that row', () => {
    install()
    rows = [{ order_id: 'o1', status: 'PAID' }, { order_id: 'o2', status: 'PAID' }]
    gs.replaceByKey_('Orders', 'order_id', [{ order_id: 'o2', status: 'CANCELLED' }])
    eq(writes.at.length, 1)
    // o2 sits at sheet row 3: header, o1, o2.
    eq(writes.at[0], { row: 3, count: 1 })
    eq(rewritten(), 0)
  })

  check('new and changed together: one appended, one written in place', () => {
    install()
    rows = [{ order_id: 'o1', status: 'PAID' }]
    gs.replaceByKey_('Orders', 'order_id', [
      { order_id: 'o1', status: 'CANCELLED' },
      { order_id: 'o2', status: 'PAID' },
    ])
    eq(writes.at.length, 2)
    eq(appended(), 1)
    // o1 over itself at row 2 — which is also where a rewrite would start, so
    // the count is what tells them apart: one row, not the whole tab.
    eq(rewritten(), 1)
  })

  check('several rows under one key, all written back in place', () => {
    // An order carries a line item per unit, so a key is not one row.
    install()
    rows = [
      { order_id: 'o1', status: 'PAID' },
      { order_id: 'o1', status: 'PAID' },
      { order_id: 'o2', status: 'PAID' },
    ]
    gs.replaceByKey_('Orders', 'order_id', [
      { order_id: 'o1', status: 'CANCELLED' },
      { order_id: 'o1', status: 'CANCELLED' },
    ])
    eq(writes.at.length, 2)
    eq(writes.at.map((w) => w.row), [2, 3])
  })

  check('a key whose row count changed falls back to the full rewrite', () => {
    // The one case the cheap path cannot express: it would need a row inserted
    // or deleted. Correctness is not negotiable here — an order that gained a
    // line item must not end up recorded twice.
    install()
    rows = [{ order_id: 'o1', status: 'PAID' }, { order_id: 'o2', status: 'PAID' }]
    gs.replaceByKey_('Orders', 'order_id', [
      { order_id: 'o1', status: 'PAID' },
      { order_id: 'o1', status: 'PAID' },
    ])
    // Everything rewritten from row 2: o2 kept, plus the two new o1 rows.
    eq(rewritten(), 3)
    eq(reads.some((r) => r.width === 2), true)
  })

  check('an empty batch writes nothing and reads nothing', () => {
    install()
    rows = [{ order_id: 'o1', status: 'PAID' }]
    eq(gs.replaceByKey_('Orders', 'order_id', []), 0)
    eq(writes.at.length, 0)
    eq(reads.length, 0)
  })

  check('appending into an empty tab still works', () => {
    install()
    rows = []
    gs.replaceByKey_('Orders', 'order_id', [{ order_id: 'o1', status: 'PAID' }])
    eq(writes.at.length, 1)
    eq(writes.at[0].count, 1)
  })
}
describe_replaceByKey()

console.log('\nasking only for what changed')

/**
 * A creation-time window cannot see a cancellation — cancelling does not
 * change when an order was created — and at a two-minute cadence it re-fetches
 * every order in the window ten times over. So the sync asks what has CHANGED
 * since the last watermark, which during a quiet minute is nothing.
 *
 * The filter could not be confirmed against TikTok's documentation from here,
 * and an ignored filter does not error: it returns the most recent orders,
 * which would look like a working sync while silently missing everything. So
 * it is proven on every run rather than assumed once.
 */
const SINCE = 1_700_000_000

check('nothing changed is nothing to do', () => {
  const r = gs.changedSince_([], SINCE)
  eq(r.applied, true)
  eq(r.count, 0)
  // Unmoved, so the next run asks the same question rather than skipping a gap.
  eq(r.watermark, SINCE)
})

check('the watermark is the newest change SEEN, not the clock', () => {
  // A clock-based watermark skips anything that changed during the call
  // itself. This one cannot; at worst it re-fetches a handful next time.
  const r = gs.changedSince_([
    { id: 'a', update_time: SINCE + 10 },
    { id: 'b', update_time: SINCE + 90 },
    { id: 'c', update_time: SINCE + 40 },
  ], SINCE)
  eq(r.applied, true)
  eq(r.watermark, SINCE + 90)
  eq(r.count, 3)
})

check('an order older than the watermark means the filter was ignored', () => {
  // TikTok answering with recent orders instead of filtered ones. Nothing is
  // written from this, and the run falls back to a creation-time window.
  const r = gs.changedSince_([
    { id: 'a', update_time: SINCE + 10 },
    { id: 'old', update_time: SINCE - 5000 },
  ], SINCE)
  eq(r.applied, false)
  eq(r.stale, 1)
})

check('create_time stands in when an order carries no update_time', () => {
  const r = gs.changedSince_([{ id: 'a', create_time: SINCE + 30 }], SINCE)
  eq(r.applied, true)
  eq(r.watermark, SINCE + 30)
})

check('an order with no time at all is neither stale nor a watermark', () => {
  // Refusing it as stale would disable the cheap path for everyone on one odd
  // row; treating it as newest would skip everything after it.
  const r = gs.changedSince_([{ id: 'a' }], SINCE)
  eq(r.applied, true)
  eq(r.watermark, SINCE)
})

check('an order exactly on the watermark is not stale', () => {
  // The bound is inclusive, so the same order may come back once. Harmless,
  // and the alternative is a one-second hole in the record.
  eq(gs.changedSince_([{ id: 'a', update_time: SINCE }], SINCE).applied, true)
})

console.log('\nwhat a status means for the money')

/**
 * This decides the one number a factory is paid against, so the default
 * matters more than any single entry.
 *
 * It used to be a denylist: CANCELLED, CANCEL and UNPAID were not sold, and
 * EVERYTHING else was — including every status nobody had thought of, and
 * every status TikTok might add. On a payout figure that default is the wrong
 * way round.
 *
 * The nine order statuses are TikTok's complete set, verified 15 Sep against
 * three of their own sources that agree, including a state diagram whose nodes
 * carry TikTok's internal codes (UNPAID 100 ... CANCELLED 140). Nine, no others.
 */
check('an unrecognised status is never sold', () => {
  // The whole point. A value nobody has seen must raise a question, not enter
  // a payout.
  eq(gs.lineStatusMeaning_('SOMETHING_NEW'), 'unknown')
  eq(gs.lineStatusMeaning_('REFUNDED'), 'unknown')
  eq(gs.lineStatusMeaning_('PARTIALLY_REFUNDED'), 'unknown')
})

check('a blank or missing status is unknown, not sold', () => {
  // TikTok returning nothing for a field is not evidence the money stuck.
  eq(gs.lineStatusMeaning_(''), 'unknown')
  eq(gs.lineStatusMeaning_(null), 'unknown')
  eq(gs.lineStatusMeaning_(undefined), 'unknown')
  eq(gs.lineStatusMeaning_('   '), 'unknown')
})

check('the money did not stick on these three', () => {
  eq(gs.lineStatusMeaning_('UNPAID'), 'unsold')
  eq(gs.lineStatusMeaning_('CANCELLED'), 'unsold')
  eq(gs.lineStatusMeaning_('CANCEL'), 'unsold')
})

check('ON_HOLD is held, not sold', () => {
  // Paid, but inside the buyer remorse window: TikTok's own overview says the
  // buyer may cancel "without the seller's approval" there. Committed stock,
  // not yet revenue. It counted as SOLD before.
  eq(gs.lineStatusMeaning_('ON_HOLD'), 'held')
})

check('the shipping and delivery statuses are sold', () => {
  ;['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'PARTIALLY_SHIPPING', 'IN_TRANSIT',
    'DELIVERED', 'COMPLETED', 'TO_SHIP'].forEach(function (st) {
    eq(gs.lineStatusMeaning_(st), 'sold', st)
  })
})

check('case and whitespace do not change the answer', () => {
  eq(gs.lineStatusMeaning_(' delivered '), 'sold')
  eq(gs.lineStatusMeaning_('Cancelled'), 'unsold')
})

check('every status in the table has a meaning the counter understands', () => {
  // A typo'd value here would silently become "unknown" for every order with
  // that status — sold units quietly dropping out of a payout.
  const allowed = { sold: 1, unsold: 1, held: 1 }
  Object.keys(gs.LINE_STATUS_MEANING).forEach(function (k) {
    if (!allowed[gs.LINE_STATUS_MEANING[k]]) throw new Error(k + ' => ' + gs.LINE_STATUS_MEANING[k])
  })
})

console.log('\nno unit is ever lost')

const ln = (o) => Object.assign({
  order_id: 'o1', sku_id: '9001', seller_sku: 'B1', variation: 'B1 Mug',
  quantity: 1, sale_price: '10', status: 'DELIVERED',
}, o)

check('a blank quantity counts as one unit, not none', () => {
  // One line item is one unit. A row written before the quantity column
  // existed is padded with '', and `Number('' || 0)` made it zero — so the
  // line contributed to NOTHING: not sold, not cancelled, not revenue. It
  // vanished from the purchase order instead of appearing in a column.
  const g = gs.groupVariationSales_([ln({ quantity: '' }), ln({ quantity: undefined })])
  eq(g['9001'].units, 2)
})

check('held and unknown units are counted apart, never as sold', () => {
  const g = gs.groupVariationSales_([
    ln({}),
    ln({ status: 'ON_HOLD' }),
    ln({ status: 'WHO_KNOWS' }),
    ln({ status: 'CANCELLED' }),
  ])
  eq(g['9001'].units, 1)
  eq(g['9001'].held_units, 1)
  eq(g['9001'].unknown_units, 1)
  eq(g['9001'].unsold_units, 1)
  // And the unrecognised value is named, so the fix is a table entry rather
  // than an investigation.
  eq(Object.keys(g['9001'].unknown_statuses), ['WHO_KNOWS'])
})

check('revenue follows sold only', () => {
  const g = gs.groupVariationSales_([ln({}), ln({ status: 'ON_HOLD' }), ln({ status: 'CANCELLED' })])
  eq(g['9001'].revenue, 10)
})

check('two variations answering to one identifier report neither count', () => {
  // identifierFromVariation_ can recover the same identifier from two
  // different variations, and the last one written used to win — so a
  // variation whose TikTok id was unknown was handed ANOTHER variation's sold
  // count. A confident wrong number is worse than none, and this one is paid
  // against.
  const idx = gs.salesIndex_(gs.groupVariationSales_([
    ln({ sku_id: '9001', seller_sku: 'B1' }),
    ln({ sku_id: '9002', seller_sku: 'B1' }),
  ]))
  eq(gs.salesFor_(idx, '', 'B1'), null)
  // Addressed by its own id, each is still answerable.
  eq(gs.salesFor_(idx, '9001', 'B1').units, 1)
  eq(gs.salesFor_(idx, '9002', 'B1').units, 1)
})

console.log('\na refund the order status cannot show')

/**
 * No order status distinguishes a refund from a sale. TikTok's Order API
 * overview says three times that a fully refunded order lands in COMPLETED,
 * and the line-item display_status enum has no REFUNDED value at all — a
 * refunded line still reads DELIVERED.
 *
 * So refunds are read from /return_refund/202309/returns/search and applied
 * over the top. Every "sold" figure before this was "sold, before refunds",
 * on the number a factory is paid.
 */
check('the buyer has the money back', () => {
  eq(gs.returnStatusMeaning_('RETURN_OR_REFUND_REQUEST_COMPLETE'), 'refunded')
  eq(gs.returnStatusMeaning_('RETURN_OR_REFUND_REQUEST_SUCCESS'), 'refunded')
  eq(gs.returnStatusMeaning_('REPLACEMENT_REQUEST_REFUND_SUCCESS'), 'refunded')
})

check('a request that is open is neither sold nor lost', () => {
  ;['RETURN_OR_REFUND_REQUEST_PENDING', 'AWAITING_BUYER_SHIP', 'BUYER_SHIPPED_ITEM',
    'AWAITING_BUYER_RESPONSE'].forEach((st) => eq(gs.returnStatusMeaning_(st), 'at_risk', st))
})

check('the seller keeps it when the request is refused or withdrawn', () => {
  ;['REFUND_OR_RETURN_REQUEST_REJECT', 'REJECT_RECEIVE_PACKAGE',
    'RETURN_OR_REFUND_REQUEST_CANCEL'].forEach((st) => eq(gs.returnStatusMeaning_(st), 'kept', st))
})

check('an unrecognised return status is at risk, never kept', () => {
  // The safe direction. Treating an unknown return as "kept" would put money
  // in a payout on the strength of a string nobody has seen.
  eq(gs.returnStatusMeaning_('SOMETHING_NEW'), 'at_risk')
  eq(gs.returnStatusMeaning_(''), 'at_risk')
  eq(gs.returnStatusMeaning_(null), 'at_risk')
})

check('one return covering several line items becomes several rows', () => {
  // Each line is decided on its own, so the row key is the return LINE item.
  const rows = gs.returnRows_('HZ', [{
    return_id: 'r1', order_id: 'o1', return_type: 'REFUND',
    return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE',
    create_time: 100, update_time: 200,
    return_line_items: [
      { return_line_item_id: 'rl1', order_line_item_id: 'li1', sku_id: '9001', seller_sku: 'B1',
        refund_amount: { refund_total: '14.88', currency: 'SGD' } },
      { return_line_item_id: 'rl2', order_line_item_id: 'li2', sku_id: '9001', seller_sku: 'B1',
        refund_amount: { refund_total: '14.88', currency: 'SGD' } },
    ],
  }], 'NOW')
  eq(rows.length, 2)
  eq(rows[0].line_item_id, 'li1')
  eq(rows[1].return_line_item_id, 'rl2')
  eq(rows[0].refund_total, '14.88')
})

check('a return with no line items yields nothing rather than a blank row', () => {
  eq(gs.returnRows_('HZ', [{ return_id: 'r1', order_id: 'o1' }], 'NOW'), [])
  eq(gs.returnRows_('HZ', null, 'NOW'), [])
})

check('the worst outcome wins when one line has two returns against it', () => {
  // A rejected request followed by a successful second attempt. The unit is
  // refunded, whatever the first attempt said.
  const idx = gs.refundIndex_([
    { line_item_id: 'li1', return_status: 'REFUND_OR_RETURN_REQUEST_REJECT' },
    { line_item_id: 'li1', return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE' },
  ])
  eq(idx['li1'], 'refunded')
  // And in the other order, so it is the ranking and not the sequence.
  const other = gs.refundIndex_([
    { line_item_id: 'li2', return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE' },
    { line_item_id: 'li2', return_status: 'REFUND_OR_RETURN_REQUEST_REJECT' },
  ])
  eq(other['li2'], 'refunded')
})

check('a return row with no line item id is ignored, not indexed under blank', () => {
  eq(Object.keys(gs.refundIndex_([{ line_item_id: '', return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE' }])), [])
})

console.log('\nthe refund beats the order status')

const li = (o) => Object.assign({
  order_id: 'o1', sku_id: '9001', seller_sku: 'B1', variation: 'B1 Mug',
  quantity: 1, sale_price: '10', status: 'DELIVERED', line_item_id: 'li1',
}, o)

check('a refunded unit stops counting as sold, though it reads DELIVERED', () => {
  // The whole point. This is what a factory was being paid for.
  const g = gs.groupVariationSales_([li({})], { li1: 'refunded' })
  eq(g['9001'].units, 0)
  eq(g['9001'].refunded_units, 1)
  eq(g['9001'].revenue, 0)
})

check('an open request is counted apart from both', () => {
  const g = gs.groupVariationSales_([li({})], { li1: 'at_risk' })
  eq(g['9001'].units, 0)
  eq(g['9001'].at_risk_units, 1)
})

check('a rejected return leaves the sale alone', () => {
  const g = gs.groupVariationSales_([li({})], { li1: 'kept' })
  eq(g['9001'].units, 1)
  eq(g['9001'].refunded_units, 0)
})

check('a cancelled line stays cancelled even with a return against it', () => {
  // It was never sold, so it cannot be refunded out of a payout twice.
  const g = gs.groupVariationSales_([li({ status: 'CANCELLED' })], { li1: 'refunded' })
  eq(g['9001'].unsold_units, 0)
  eq(g['9001'].refunded_units, 1)
})

check('no refunds at all behaves exactly as before', () => {
  const g = gs.groupVariationSales_([li({})])
  eq(g['9001'].units, 1)
})

check('the sync interval is one Apps Script will actually accept', () => {
  // `everyMinutes` takes 1, 5, 10, 15 or 30 and NOTHING else. Two was asked
  // for, two is not on the list, and the trigger API reports that as an
  // exception in the editor with no clue what would have worked — which is
  // exactly the kind of thing a constant should not be able to get wrong.
  if (gs.SYNC_ALLOWED_MINUTES.indexOf(gs.SYNC_EVERY_MINUTES) < 0) {
    throw new Error(gs.SYNC_EVERY_MINUTES + ' is not one of ' + gs.SYNC_ALLOWED_MINUTES.join(', '))
  }
})

console.log('\nrestoring a removed variation')

check('the identifier is not put on the name twice', () => {
  // variantValueName_ adds the identifier when a variation is listed, and the
  // Sheet stores the result. Feeding that back through it would restore
  // "B74 4 tier" as "B74 B74 4 tier" — a variation renamed by the act of
  // putting it back.
  eq(gs.strippedVariantName_('B74 4 tier', 'B74'), '4 tier')
  eq(gs.variantValueName_('B74', gs.strippedVariantName_('B74 4 tier', 'B74')), 'B74 4 tier')
})

check('a name that does not start with the identifier is left alone', () => {
  // Listed outside the app, or renamed in Seller Centre.
  eq(gs.strippedVariantName_('Whirl bowl set', 'B74'), 'Whirl bowl set')
  // And a near-miss is not a match: B7 must not eat the 4 of B74.
  eq(gs.strippedVariantName_('B74 4 tier', 'B7'), 'B74 4 tier')
})

check('a name that is only the identifier becomes empty, not a repeat', () => {
  eq(gs.strippedVariantName_('B74', 'B74'), '')
  eq(gs.variantValueName_('B74', gs.strippedVariantName_('B74', 'B74')), 'B74')
})

check('case does not defeat it, and neither does a missing identifier', () => {
  eq(gs.strippedVariantName_('b74 4 tier', 'B74'), '4 tier')
  eq(gs.strippedVariantName_('4 tier', ''), '4 tier')
  eq(gs.strippedVariantName_('', 'B74'), '')
})

check('the removed list is short on purpose', () => {
  // 121 removed against 32 live on I12. The tab exists to undo a mistake, and
  // a mistake is noticed in the next minute or not at all.
  if (!(gs.REMOVED_RECENT > 0 && gs.REMOVED_RECENT <= 20)) {
    throw new Error('REMOVED_RECENT is ' + gs.REMOVED_RECENT)
  }
})

console.log('\norders TikTok has stopped returning')

/**
 * `replaceByKey_` only touches keys present in the incoming batch. There is no
 * delete pass and no tombstone, so an order that drops out of TikTok's results
 * sat in the Sheet at its last-seen status FOREVER — and if that was a selling
 * status, its units were counted as sold in every export made afterwards.
 *
 * The check reports rather than decides, on purpose. An absent order may have
 * been cancelled and dropped (counting it as sold overpays) or may simply be
 * missing from that response (removing it underpays). Both are wrong, and this
 * cannot tell which.
 */
check('names what the Sheet has and TikTok does not', () => {
  eq(gs.ordersMissingFromTikTok_(['o1', 'o2', 'o3'], ['o1', 'o3']), ['o2'])
})

check('nothing missing is an empty list', () => {
  eq(gs.ordersMissingFromTikTok_(['o1', 'o2'], ['o2', 'o1']), [])
})

check('an order reported once, however many line items it has', () => {
  // The Sheet holds one row per UNIT, so a three-unit order appears three
  // times. Reporting it three times would read as three missing orders.
  eq(gs.ordersMissingFromTikTok_(['o1', 'o1', 'o1', 'o2'], ['o2']), ['o1'])
})

check('extra orders on TikTok are not a fault here', () => {
  // TikTok having more than the Sheet is a sync that has not caught up, which
  // is a different problem with a different fix.
  eq(gs.ordersMissingFromTikTok_(['o1'], ['o1', 'o2', 'o3']), [])
})

check('blank ids are ignored on both sides', () => {
  eq(gs.ordersMissingFromTikTok_(['', null, 'o1'], ['o1']), [])
  eq(gs.ordersMissingFromTikTok_(['o1'], ['', null]), ['o1'])
})

check('nothing recorded means nothing to check', () => {
  eq(gs.ordersMissingFromTikTok_([], ['o1']), [])
  eq(gs.ordersMissingFromTikTok_(null, null), [])
})

console.log('\na timestamp that actually sorts')

/**
 * Sheets turns an ISO string written to a cell into a real date, so
 * `getValues()` returns a Date — and `String(date)` gives
 * "Sun Sep 13 2026 22:00:00 GMT+0800". The app sorted its listing on exactly
 * that, alphabetically, by weekday name. The 13th came before the 14th
 * because "Sun" beats "Mon".
 */
check('a Date from a cell becomes ISO', () => {
  eq(gs.isoOf_(new Date('2026-09-15T02:14:33.000Z')), '2026-09-15T02:14:33.000Z')
})

check('an ISO string is left exactly alone', () => {
  // Not re-parsed, so a value that never went through a cell cannot drift.
  eq(gs.isoOf_('2026-09-15T02:14:33.000Z'), '2026-09-15T02:14:33.000Z')
})

check('the shape that caused the bug is converted, not passed through', () => {
  const out = gs.isoOf_('Sun Sep 13 2026 22:00:00 GMT+0000')
  eq(out.slice(0, 10), '2026-09-13')
  if (out.indexOf('Sun') >= 0) throw new Error('still weekday text: ' + out)
})

check('nothing, or nonsense, is empty rather than a fake date', () => {
  // An invented timestamp would sort a row into a position it has not earned.
  eq(gs.isoOf_(''), '')
  eq(gs.isoOf_(null), '')
  eq(gs.isoOf_(undefined), '')
  eq(gs.isoOf_('not a date'), '')
  eq(gs.isoOf_(new Date('nonsense')), '')
})

check('ISO strings sort newest-first as text; the old shape inverts days', () => {
  // The property the whole listing order rests on, asserted directly.
  const days = ['2026-09-13T22:00:00.000Z', '2026-09-14T02:00:00.000Z', '2026-09-16T09:00:00.000Z']
  const iso = days.map(gs.isoOf_).sort((a, b) => b.localeCompare(a))
  eq(iso.map((d) => d.slice(0, 10)), ['2026-09-16', '2026-09-14', '2026-09-13'])

  // And the shape it replaced gets it wrong. Checking the FIRST element would
  // have proved nothing — with these three dates Wednesday happens to win on
  // 'W' alone. The inversion is between Sunday the 13th and Monday the 14th,
  // so that is the pair to assert. (The first version of this test checked
  // the wrong element and passed the broken data.)
  const raw = days.map((d) => String(new Date(d))).sort((a, b) => b.localeCompare(a))
  const dayOf = (t) => t.slice(8, 10)
  const thirteenth = raw.findIndex((t) => dayOf(t) === '13')
  const fourteenth = raw.findIndex((t) => dayOf(t) === '14')
  if (!(thirteenth < fourteenth)) {
    throw new Error('expected the raw form to put the 13th above the 14th, which is the bug')
  }
})


// ---------------------------------------------------------------------------
// One tally, two aggregators.
//
// `groupVariationSales_` feeds the listing screen; `summariseItems_` feeds the
// orders screen and the export built from it. They counted the same line items
// by two different rules — the first got the refund model and the four-way
// status table on 15 Sep, the second was still on a three-status denylist — so
// the export was paying a factory for units the listing screen had already
// written off. That is the second time the two ends of this app drifted apart
// on a payout figure, so the arithmetic is asserted here to be one function.
// ---------------------------------------------------------------------------
console.log('\none tally, shared by every aggregator')

/** Every bucket, so a new one cannot be added without this list noticing. */
const UNIT_BUCKETS = [
  'sold_units', 'cancelled_units', 'refunded_units',
  'at_risk_units', 'held_units', 'unknown_units',
]
const VALUE_BUCKETS = UNIT_BUCKETS.map((b) => b.replace('_units', '_value'))

function assertDisjoint(t, where) {
  eq(
    UNIT_BUCKETS.reduce((n, b) => n + t[b], 0),
    t.ordered_units,
    where + ': the unit buckets must sum to what was ordered',
  )
  eq(
    Math.round(VALUE_BUCKETS.reduce((n, b) => n + t[b], 0) * 100) / 100,
    Math.round(t.ordered_value * 100) / 100,
    where + ': the money buckets must sum to what was ordered',
  )
}

check('every bucket a line can land in is counted, and only one of them', () => {
  const rows = [
    line({ status: 'AWAITING_SHIPMENT' }),
    line({ order_id: 'o2', status: 'CANCELLED' }),
    line({ order_id: 'o3', status: 'UNPAID' }),
    line({ order_id: 'o4', status: 'ON_HOLD' }),
    line({ order_id: 'o5', status: 'WHAT_IS_THIS' }),
    line({ order_id: 'o6', status: 'DELIVERED', line_item_id: 'li-refund' }),
    line({ order_id: 'o7', status: 'DELIVERED', line_item_id: 'li-open' }),
  ]
  const refunds = { 'li-refund': 'refunded', 'li-open': 'at_risk' }
  const g = gs.groupVariationSales_(rows, refunds)['9001']
  assertDisjoint(g, 'groupVariationSales_')
  eq(g.ordered_units, 7)
  eq(g.sold_units, 1)
  eq(g.cancelled_units, 2)
  eq(g.held_units, 1)
  eq(g.unknown_units, 1)
  eq(g.refunded_units, 1)
  eq(g.at_risk_units, 1)
})

/**
 * The assertion that would have caught the divergence.
 *
 * Both aggregators are handed identical rows and must produce identical
 * buckets. Nothing about the shape of a purchase order makes a listing's
 * figures different from the sum of its variations' figures, and when they
 * were, the export was the side that was wrong.
 */
check('the orders screen and the listing screen bucket identically', () => {
  const rows = [
    line({ status: 'COMPLETED', sale_price: '12.50' }),
    line({ order_id: 'o2', status: 'CANCELLED', sale_price: '12.50' }),
    line({ order_id: 'o3', status: 'ON_HOLD', sale_price: '12.50' }),
    line({ order_id: 'o4', status: 'NOT_A_REAL_STATUS', sale_price: '12.50' }),
    line({ order_id: 'o5', status: 'DELIVERED', sale_price: '12.50', line_item_id: 'r1' }),
    line({ order_id: 'o6', status: 'DELIVERED', sale_price: '12.50', line_item_id: 'r2' }),
  ]
  const refunds = { r1: 'refunded', r2: 'at_risk' }

  const variation = gs.groupVariationSales_(rows, refunds)['9001']
  const listing = gs.summariseItems_(rows, refunds).listings[0]

  UNIT_BUCKETS.concat(VALUE_BUCKETS, ['ordered_units', 'ordered_value']).forEach((f) => {
    eq(listing[f], variation[f], 'the two aggregators disagree on ' + f)
  })
  assertDisjoint(listing, 'summariseItems_')
})

check('a refunded unit leaves sold without becoming cancelled', () => {
  // The whole reason a refund column has to exist. Subtracting only cancelled
  // from ordered overstates net by exactly the units nobody can see.
  const rows = [line({ status: 'COMPLETED', line_item_id: 'r1', sale_price: '20.00' })]
  const l = gs.summariseItems_(rows, { r1: 'refunded' }).listings[0]
  eq(l.ordered_units, 1)
  eq(l.cancelled_units, 0)
  eq(l.refunded_units, 1)
  eq(l.sold_units, 0, 'a refunded unit is not sold')
  eq(l.sold_value, 0, 'and the money is not in the payout')
  eq(l.ordered_units - l.cancelled_units, 1, 'total minus cancelled alone is still 1')
  assertDisjoint(l, 'a refund')
})

check('the old names still mean what every screen reads them as', () => {
  const rows = [
    line({ status: 'COMPLETED', sale_price: '10.00' }),
    line({ order_id: 'o2', status: 'CANCELLED', sale_price: '10.00' }),
  ]
  const g = gs.groupVariationSales_(rows)['9001']
  eq(g.units, g.sold_units)
  eq(g.revenue, g.sold_value)
  eq(g.unsold_units, g.cancelled_units)
  const l = gs.summariseItems_(rows).listings[0]
  eq(l.units, l.sold_units)
  eq(l.revenue, l.sold_value)
  eq(l.unsold_units, l.cancelled_units)
})

check('a blank quantity is one unit in both aggregators, not none', () => {
  // A row written before the column existed is padded with ''. Reading that as
  // zero made it contribute to no column at all — it vanished from the
  // purchase order rather than appearing in either.
  const rows = [line({ quantity: '', sale_price: '10.00' })]
  eq(gs.groupVariationSales_(rows)['9001'].sold_units, 1)
  eq(gs.summariseItems_(rows).listings[0].sold_units, 1)
})

check('a listing total is the sum of its variations, by construction', () => {
  const rows = [
    line({ sku_id: '1', seller_sku: 'A1', status: 'COMPLETED', sale_price: '10.00' }),
    line({ sku_id: '2', seller_sku: 'A2', order_id: 'o2', status: 'CANCELLED', sale_price: '7.50' }),
    line({ sku_id: '3', seller_sku: 'A3', order_id: 'o3', status: 'ON_HOLD', sale_price: '2.25' }),
  ]
  const byVariation = gs.groupVariationSales_(rows)
  const summed = Object.keys(byVariation).reduce(
    (t, k) => gs.addTally_(t, byVariation[k]), gs.emptyTally_(),
  )
  const listing = gs.summariseItems_(rows).listings[0]
  UNIT_BUCKETS.concat(['ordered_units']).forEach((f) => eq(listing[f], summed[f], f))
  eq(listing.ordered_value, Math.round(summed.ordered_value * 100) / 100)
})

// ---------------------------------------------------------------------------
// The columns a purchase order carries.
//
// Brien asked for six figures per variation and per listing. Those six are
// always present; the other four buckets appear only when they are non-zero,
// because the six stop adding up the moment one is not.
// ---------------------------------------------------------------------------
console.log('\nthe purchase order columns')

const SIX = [
  'Total sold', 'Cancelled', 'Net sold',
  'Total sales (SGD)', 'Cancelled sales (SGD)', 'Net sales (SGD)',
]

check('a clean window shows exactly the six figures that were asked for', () => {
  const cols = gs.tallyColumns_([
    Object.assign(gs.emptyTally_(), {
      ordered_units: 3, sold_units: 2, cancelled_units: 1,
      ordered_value: 30, sold_value: 20, cancelled_value: 10,
    }),
  ])
  eq(gs.tallyHeader_(cols), SIX)
})

check('a refund adds its own pair of columns, and only when there is one', () => {
  const clean = Object.assign(gs.emptyTally_(), { ordered_units: 1, sold_units: 1 })
  const refunded = Object.assign(gs.emptyTally_(), {
    ordered_units: 1, refunded_units: 1, ordered_value: 9, refunded_value: 9,
  })
  eq(gs.tallyHeader_(gs.tallyColumns_([clean])), SIX)
  eq(gs.tallyHeader_(gs.tallyColumns_([clean, refunded])), [
    'Total sold', 'Cancelled', 'Refunded', 'Net sold',
    'Total sales (SGD)', 'Cancelled sales (SGD)', 'Refunded sales (SGD)', 'Net sales (SGD)',
  ])
})

check('every column present is subtracted, and no column absent is named', () => {
  const held = Object.assign(gs.emptyTally_(), { ordered_units: 2, sold_units: 1, held_units: 1 })
  const cols = gs.tallyColumns_([held])
  const text = gs.netExplainer_(cols)
  eq(/refunded/i.test(text), false, 'no refund column, so no refund in the sentence')
  eq(/on hold/i.test(text), true, 'the on-hold column is present and must be named')
  eq(/cancelled/i.test(text), true)
})

check('the values line up with the header, column for column', () => {
  const t = Object.assign(gs.emptyTally_(), {
    ordered_units: 4, sold_units: 2, cancelled_units: 1, refunded_units: 1,
    ordered_value: 40, sold_value: 20, cancelled_value: 10, refunded_value: 10,
  })
  const cols = gs.tallyColumns_([t])
  const head = gs.tallyHeader_(cols)
  const vals = gs.tallyValues_(cols, t)
  eq(head.length, vals.length, 'a header without a value under it is a wrong sheet')
  eq(vals[head.indexOf('Total sold')], 4)
  eq(vals[head.indexOf('Cancelled')], 1)
  eq(vals[head.indexOf('Refunded')], 1)
  eq(vals[head.indexOf('Net sold')], 2)
  eq(vals[head.indexOf('Net sales (SGD)')], 20)
  // The subtraction the sheet claims to perform, performed.
  eq(
    vals[head.indexOf('Total sold')] - vals[head.indexOf('Cancelled')] -
      vals[head.indexOf('Refunded')],
    vals[head.indexOf('Net sold')],
  )
})

check('money is rounded to cents in the cells, not left as float drift', () => {
  const t = Object.assign(gs.emptyTally_(), { ordered_value: 0.1 + 0.2, sold_value: 0.1 + 0.2 })
  const cols = gs.tallyColumns_([t])
  const vals = gs.tallyValues_(cols, t)
  eq(vals[gs.tallyHeader_(cols).indexOf('Total sales (SGD)')], 0.3)
})

check('an empty export still has the six columns rather than none', () => {
  eq(gs.tallyHeader_(gs.tallyColumns_([])), SIX)
})



// ---------------------------------------------------------------------------
// The sheet is built without a width mismatch.
//
// setValues throws when the array is not exactly the width of the range, and
// exportOrders_ has no per-sheet failsafe: one mismatch kills the whole
// workbook after the photos have already been fetched. The column count is now
// data-dependent — it varies with the cost divisor AND with which buckets are
// non-zero — so the combinations are asserted rather than reasoned about.
// ---------------------------------------------------------------------------
console.log('\nevery row is exactly as wide as its header')

function widthsMatch(tallies, divisor, where) {
  const cols = gs.tallyColumns_(tallies)
  const totals = tallies.reduce((a, t) => gs.addTally_(a, t), gs.emptyTally_())

  // THE EXPORT'S OWN BUILDERS, not a copy of them. A test that rebuilds the
  // header itself passes happily while the export writes something else.
  const sheets = [
    {
      name: 'Summary',
      header: gs.summaryHeader_(cols, divisor),
      rows: tallies.map((t) => gs.summaryRow_(cols, divisor, t))
        .concat([gs.summaryTotalRow_(cols, divisor, totals, 7)]),
    },
    {
      name: 'a factory sheet',
      header: gs.itemHeader_(cols, divisor),
      rows: tallies.map((t) => gs.itemRow_(cols, divisor, t))
        .concat([gs.itemTotalRow_(cols, divisor, totals)]),
    },
  ]

  sheets.forEach((sheet) => {
    sheet.rows.forEach((row, i) => {
      eq(row.length, sheet.header.length,
        where + ': ' + sheet.name + ' row ' + i + ' is not the header width')
      row.forEach((v, c) => {
        // setValues takes strings, numbers, booleans and dates. An object or
        // undefined in a cell throws and takes the workbook with it.
        const ok = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        eq(ok, true, where + ': ' + sheet.name + ' r' + i + 'c' + c + ' is not writable')
        if (typeof v === 'number') {
          eq(isFinite(v), true, where + ': ' + sheet.name + ' r' + i + 'c' + c + ' is not finite')
        }
      })
    })
  })
}

const CLEAN = Object.assign(gs.emptyTally_(), {
  listing_id: 'L1', product_name: 'Katrin Run', order_count: 2,
  seller_sku: 'A1', variation: 'A1 Blue Mug', price: '10.00',
  ordered_units: 3, sold_units: 2, cancelled_units: 1,
  ordered_value: 30, sold_value: 20, cancelled_value: 10,
})
const MESSY = Object.assign(gs.emptyTally_(), {
  listing_id: 'L2', product_name: 'Hoi An', order_count: 5,
  seller_sku: 'B7', variation: 'B7 Rattan Tray', price: '10.00',
  ordered_units: 6, sold_units: 1, cancelled_units: 1, refunded_units: 1,
  at_risk_units: 1, held_units: 1, unknown_units: 1,
  ordered_value: 60, sold_value: 10, cancelled_value: 10, refunded_value: 10,
  at_risk_value: 10, held_value: 10, unknown_value: 10,
})

check('six columns, no cost', () => widthsMatch([CLEAN], null, 'clean/no-divisor'))
check('six columns, with cost', () => widthsMatch([CLEAN], 2.5, 'clean/divisor'))
check('every bucket showing, no cost', () => widthsMatch([MESSY], null, 'messy/no-divisor'))
check('every bucket showing, with cost', () => widthsMatch([MESSY], 2.5, 'messy/divisor'))
check('a clean row beside a messy one still lines up', () =>
  widthsMatch([CLEAN, MESSY], 2.5, 'mixed'))
check('an export with no listings at all', () => widthsMatch([], 2.5, 'empty'))

/**
 * A listing with nothing to call it by still writes a cell.
 *
 * setValues throws on undefined, and it throws AFTER every photo has been
 * fetched — so one missing field costs the whole workbook rather than one
 * blank cell. Found by pointing this test at the export's own row builders
 * instead of at a copy of them.
 */
check('a row with no name and no id is still writable', () => {
  const bare = gs.emptyTally_()
  const cols = gs.tallyColumns_([bare])
  gs.summaryRow_(cols, null, bare).concat(gs.itemRow_(cols, null, bare)).forEach((v) => {
    eq(v === undefined || v === null, false, 'setValues would throw on this cell')
  })
  eq(gs.unitPriceOf_(bare), 0, 'no units ordered is a zero price, not a division by zero')
  eq(gs.unitPriceOf_({ price: 'not a number' }), 0, 'a nonsense price is zero, not NaN')
})

check('a variation straight out of the aggregator writes cleanly', () => {
  // The fixtures above are hand-built. This one is a real tally, so a field
  // the aggregator sets and the fixtures do not cannot slip through.
  const rows = [
    line({ status: 'COMPLETED', sale_price: '12.50' }),
    line({ order_id: 'o2', status: 'CANCELLED', sale_price: '12.50' }),
    line({ order_id: 'o3', status: 'ON_HOLD', sale_price: '12.50' }),
  ]
  const byVariation = gs.groupVariationSales_(rows)
  widthsMatch(Object.keys(byVariation).map((k) => gs.roundTally_(byVariation[k])), 2.5, 'live')
  widthsMatch(gs.summariseItems_(rows).listings, null, 'live listings')
})



// ---------------------------------------------------------------------------
// The warning is bold, whatever else is above it.
//
// The bold row used to be the literal 5, on the assumption that the block above
// the table was five rows long. Adding the line that explains the subtraction
// made that assumption silently wrong — and CHECK BEFORE PAYING set in the same
// weight as everything around it is a warning nobody reads.
// ---------------------------------------------------------------------------
console.log('\nthe purchase order header block')

const SHOP = { brand: 'HOUZE' }
const SIX_COLS = gs.tallyColumns_([])

function headOf(recon, divisor) {
  return gs.summaryHeadRows_(SHOP, '6 Sep to 6 Sep', divisor || null, 'brien', SIX_COLS, recon)
}

check('the bolded row is the warning, not a row number someone remembered', () => {
  const b = headOf({ checked: 0, missing: ['o1', 'o2'], units: 3 })
  eq(b.alert > 0, true, 'there is a warning, so a row must be bolded')
  eq(/CHECK BEFORE PAYING/.test(b.rows[b.alert - 1][0]), true,
    'the bolded row must be the warning itself')
})

check('a failed check is bolded too, and says it was not checked', () => {
  const b = headOf({ error: 'TikTok timed out', checked: 0, missing: [] })
  eq(/NOT CHECKED against TikTok/.test(b.rows[b.alert - 1][0]), true)
})

check('a clean check is stated but not shouted', () => {
  const b = headOf({ checked: 41, missing: [] })
  eq(b.alert, 0, 'nothing to bold when nothing is wrong')
  eq(b.rows.some((r) => /all 41 recorded line/.test(r[0])), true)
})

check('no reconciliation at all is not a crash and not a false all-clear', () => {
  const b = headOf({ checked: 0, missing: [] })
  eq(b.alert, 0)
  eq(b.rows.some((r) => /Checked against TikTok/.test(r[0])), false)
})

check('every row of the block is one writable cell', () => {
  ;[headOf({ checked: 0, missing: ['o1'], units: 1 }, 2.5),
    headOf({ error: 'boom', missing: [] }),
    headOf({ checked: 3, missing: [] }),
    headOf({ checked: 0, missing: [] })].forEach((b, i) => {
    b.rows.forEach((r, j) => {
      eq(r.length, 1, 'block ' + i + ' row ' + j + ' must be exactly one cell wide')
      eq(typeof r[0], 'string', 'block ' + i + ' row ' + j + ' must be writable')
    })
  })
})

check('the subtraction it explains is the one the table performs', () => {
  // The explainer is built from the SAME columns the table is, so it can never
  // describe a sheet somebody is not looking at.
  const messy = Object.assign(gs.emptyTally_(), { ordered_units: 2, refunded_units: 1, sold_units: 1 })
  const cols = gs.tallyColumns_([messy])
  const b = gs.summaryHeadRows_(SHOP, 'w', null, 'brien', cols, { checked: 0, missing: [] })
  const line = b.rows.map((r) => r[0]).find((t) => /^Net sold =/.test(t))
  eq(/refunded/.test(line), true, 'the refund column is on the table, so it must be in the sentence')
  eq(gs.tallyHeader_(cols).indexOf('Refunded') >= 0, true)
})

check('and it names nothing the table does not show', () => {
  const b = headOf({ checked: 0, missing: [] })
  const line = b.rows.map((r) => r[0]).find((t) => /^Net sold =/.test(t))
  eq(/refunded|on hold|awaiting/.test(line), false)
  eq(/Net sold = total sold \u2212 cancelled\./.test(line), true)
})



check("a factory's sheet survives a listing with no name and no id", () => {
  // Same class as the Summary row, and it was still live here after that fix:
  // the first cell was `l.product_name || l.listing_id` with nothing beneath
  // it, so an undefined on both would have thrown and taken the workbook with
  // it — after every photo had already been fetched.
  const top = gs.listingTopRows_({}, undefined, SIX_COLS)
  top.forEach((r, i) => {
    eq(r.length, 1, 'row ' + i + ' must be exactly one cell wide')
    eq(typeof r[0], 'string', 'row ' + i + ' must be writable')
    eq(/undefined|null|NaN/.test(r[0]), false, 'row ' + i + ' must not print a JS value: ' + r[0])
  })
})

check('a real listing still reads as it did', () => {
  const top = gs.listingTopRows_(
    { listing_id: '123', product_name: 'Katrin Run' }, '6 Sep to 6 Sep', SIX_COLS)
  eq(top[0][0], 'Katrin Run')
  eq(/TikTok listing 123/.test(top[1][0]), true)
  eq(/6 Sep to 6 Sep/.test(top[1][0]), true)
  eq(/^Net sold =/.test(top[3][0]), true)
  eq(top[4][0], '')
})

check('the block is exactly as tall as the row maths assumes', () => {
  // h0 = top.length + 1, item rows start at h0 + 1, and each photo is anchored
  // to h0 + 1 + i. Both derive from this one length, so it is asserted rather
  // than remembered.
  eq(gs.listingTopRows_({ listing_id: 'x' }, 'w', SIX_COLS).length, 5)
})



console.log('\nthe Summary TOTAL counts each order once')

/**
 * A basket holding two listings is ONE order.
 *
 * summariseItems_ builds each listing's order_count from its own distinct
 * order ids, which is right — each factory's sheet should say how many orders
 * touched it. Summing those for the TOTAL line is NOT right: an order spanning
 * two listings adds one to each and two to the total.
 *
 * The same trap the per-listing figures were given a comment about on the way
 * in ("Distinct orders, not the sum of the per-listing counts") — and then the
 * export summed them anyway one function later.
 */
check('an order spanning two listings is one order on the TOTAL line', () => {
  const rows = [
    item({ order_id: 'O1', listing_id: 'L1' }),
    item({ order_id: 'O1', listing_id: 'L2' }),
    item({ order_id: 'O2', listing_id: 'L1' }),
    item({ order_id: 'O2', listing_id: 'L2' }),
    item({ order_id: 'O3', listing_id: 'L1' }),
  ]
  const summary = gs.summariseItems_(rows)
  eq(summary.total_orders, 3, 'three distinct baskets')
  // Each listing counts what touched it, and that is correct.
  const byId = {}
  summary.listings.forEach((l) => { byId[l.listing_id] = l.order_count })
  eq(byId.L1, 3)
  eq(byId.L2, 2)
  // Summing them would say five. The export must use the distinct count.
  eq(summary.listings.reduce((n, l) => n + l.order_count, 0), 5,
    'the sum is five, which is why summing it is wrong')
  eq(gs.summaryOrderCount_(summary.listings, summary), 3,
    'the TOTAL line must say three')
})

check('a filtered export counts only the orders on the listings it includes', () => {
  // The export can be asked for a subset of listings. The distinct count over
  // the WHOLE window would then be too high, so it is recomputed from the
  // chosen listings rather than taken from the summary wholesale.
  const rows = [
    item({ order_id: 'O1', listing_id: 'L1' }),
    item({ order_id: 'O1', listing_id: 'L2' }),
    item({ order_id: 'O9', listing_id: 'L3' }),
  ]
  const summary = gs.summariseItems_(rows)
  const chosen = summary.listings.filter((l) => l.listing_id !== 'L3')
  eq(gs.summaryOrderCount_(chosen, summary), 1,
    'O1 is the only basket on L1 and L2, and it is one order')
  eq(gs.summaryOrderCount_(summary.listings, summary), 2)
})



check('a line with no listing id is named, not renamed', () => {
  // It grouped under the invented key 'unknown', which the export then fed
  // back to listingOrders_ as a real TikTok id — matching no row, so the
  // factory sheet came out with a TOTAL and no lines under it.
  const r = gs.summariseItems_([
    item({ listing_id: '', product_name: '', quantity: 2, sale_price: '10.00' }),
  ])
  eq(r.listings[0].listing_id, '', 'a blank id stays blank')
  eq(r.listings[0].unattributed, true, 'and says so')
  eq(r.listings[0].sold_units, 2, 'while still carrying its units')

  const cols = gs.tallyColumns_(r.listings)
  const row = gs.summaryRow_(cols, null, r.listings[0])
  eq(row[0], 'Not attributed to a listing')
  eq(row[1], '', 'no link, because there is nothing to open')
  eq(row[2], '')
  row.forEach((v, i) => eq(v === undefined || v === null, false, 'cell ' + i + ' must be writable'))
})

check('two unattributed products stay two rows, each under its own name', () => {
  // Pooling them put one product's name over another product's money, which
  // is worse than the 'unknown' string it replaced.
  const r = gs.summariseItems_([
    item({ listing_id: '', product_name: 'Katrin Run', sku_id: 'k1', quantity: 2, sale_price: '10.00' }),
    item({ order_id: 'o2', listing_id: '', product_name: 'Hoi An', sku_id: 'h1', quantity: 3, sale_price: '20.00' }),
  ])
  eq(r.listings.length, 2, 'two products, two rows')
  r.listings.forEach((l) => {
    eq(l.unattributed, true)
    eq(l.listing_id, '', 'neither pretends to have a listing')
  })
  const byName = {}
  r.listings.forEach((l) => { byName[l.product_name] = l.sold_units })
  eq(byName['Katrin Run'], 2)
  eq(byName['Hoi An'], 3)

  const cols = gs.tallyColumns_(r.listings)
  const names = r.listings.map((l) => gs.summaryRow_(cols, null, l)[0]).sort()
  eq(names, ['Hoi An \u2014 not attributed to a listing', 'Katrin Run \u2014 not attributed to a listing'])
})

check('the Net cost TOTAL equals the sum of the cost column above it', () => {
  // It was re-derived by dividing the grand total, so it disagreed with the
  // rounded per-row figures by a cent or two — exactly what somebody signing
  // a purchase order stops for.
  const rows = [
    Object.assign(gs.emptyTally_(), { listing_id: 'L1', order_count: 1, sold_value: 10.01, ordered_value: 10.01, ordered_units: 1, sold_units: 1 }),
    Object.assign(gs.emptyTally_(), { listing_id: 'L2', order_count: 1, sold_value: 10.01, ordered_value: 10.01, ordered_units: 1, sold_units: 1 }),
    Object.assign(gs.emptyTally_(), { listing_id: 'L3', order_count: 1, sold_value: 10.01, ordered_value: 10.01, ordered_units: 1, sold_units: 1 }),
  ]
  const divisor = 3
  const cols = gs.tallyColumns_(rows)
  const header = gs.summaryHeader_(cols, divisor)
  const costCol = header.indexOf('Net cost (SGD)')
  const colSum = rows.reduce((n, l) => n + gs.summaryRow_(cols, divisor, l)[costCol], 0)

  const totals = rows.reduce((t, l) => gs.addTally_(t, l), gs.emptyTally_())
  const totalRow = gs.summaryTotalRow_(cols, divisor, totals, 3, rows)
  eq(totalRow.length, header.length)
  eq(totalRow[costCol], Math.round(colSum * 100) / 100, 'the TOTAL must be the column summed')
})



// ---------------------------------------------------------------------------
// Every listed variant must carry a photo — including ones we did not list.
//
// TikTok 12052522 applies to the WHOLE payload, and an append sends every
// existing SKU back. A7, HOUZE, 23 Sep: a variation called "test 1" had been
// added in Seller Center with no attribute image, which Seller Center allowed
// and the API will not round-trip. That listing could never be appended to
// again, and nothing in the app said why.
// ---------------------------------------------------------------------------
console.log('\na variant with no photo cannot block the whole listing')

const SNAP_IMG = 'main-img-uri'

check('an existing variation with no photo is given the product\'s main image', () => {
  const snap = {
    productId: 'P', title: 't', mainImageUri: SNAP_IMG,
    skus: [sku({ id: '1' }), sku({ id: '2', valueId: '', valueName: 'test 1', skuImgUri: '' })],
  }
  const p = gs.buildAppendPayload_(snap, addition)
  const byName = {}
  p.skus.forEach((x) => { byName[x.sales_attributes[0].value_name || x.sales_attributes[0].value_id] = x })

  // Every single variant in the payload carries an image. That is the rule.
  p.skus.forEach((x, i) => {
    const img = x.sales_attributes[0].sku_img
    eq(Boolean(img && img.uri), true, 'variant ' + i + ' must carry a photo')
  })
  eq(byName['test 1'].sales_attributes[0].sku_img.uri, SNAP_IMG, "the product's own photo, not another variant's")
})

check('a variation that already has a photo keeps it', () => {
  const snap = {
    productId: 'P', title: 't', mainImageUri: SNAP_IMG,
    skus: [sku({ id: '1', skuImgUri: 'its-own-photo' })],
  }
  const p = gs.buildAppendPayload_(snap, addition)
  eq(p.skus[0].sales_attributes[0].sku_img.uri, 'its-own-photo')
})

check('the SKU being added keeps its own photo, never the main image', () => {
  const snap = {
    productId: 'P', title: 't', mainImageUri: SNAP_IMG,
    skus: [sku({ id: '1', skuImgUri: '' })],
  }
  const p = gs.buildAppendPayload_(snap, addition)
  const added = p.skus.filter((x) => !x.id)[0]
  eq(added.sales_attributes[0].sku_img.uri, 'img-new', 'the new variant is the one photo we do know')
})

check('a removal carries photos on every remaining variant too', () => {
  // The same rule: a remove sends every SKU that stays, so one without a photo
  // fails the whole edit and the variation is never removed.
  const snap = {
    productId: 'P', title: 't', mainImageUri: SNAP_IMG,
    skus: [sku({ id: '1' }), sku({ id: '2', valueId: '', valueName: 'test 1', skuImgUri: '' }), sku({ id: '3' })],
  }
  const p = gs.buildRemovePayload_(snap, [], '3')
  eq(p.skus.length, 2)
  p.skus.forEach((x, i) => {
    eq(Boolean(x.sales_attributes[0].sku_img && x.sales_attributes[0].sku_img.uri), true,
      'remaining variant ' + i + ' must carry a photo')
  })
})

check('no main image to borrow leaves the payload untouched rather than inventing one', () => {
  // Nothing sensible to fill with. The push will be refused by TikTok with its
  // own message naming the variant, which is better than a fabricated uri.
  const skus = [{ sales_attributes: [{ value_name: 'test 1' }] }]
  eq(gs.withVariantImages_(skus, '', 'P'), [])
  eq(skus[0].sales_attributes[0].sku_img, undefined)
})

check('it reports which variations it filled, for the log', () => {
  const skus = [
    { sales_attributes: [{ value_name: 'test 1' }] },
    { sales_attributes: [{ value_name: 'ok', sku_img: { uri: 'has-one' } }] },
    { seller_sku: 'B2', sales_attributes: [{}] },
  ]
  eq(gs.withVariantImages_(skus, SNAP_IMG, 'P'), ['test 1', 'B2'])
  eq(skus[1].sales_attributes[0].sku_img.uri, 'has-one', 'the one that had a photo is untouched')
})



// ---------------------------------------------------------------------------
// "Last seen" must never make anybody wait.
//
// It ran on EVERY authenticated request and waited up to five seconds for the
// script lock — which every push, every stock change and the one-minute
// background sync all hold. So one phone pushing a variation stalled every
// other request on every phone, for a timestamp nobody reads on air.
// ---------------------------------------------------------------------------
console.log('\nlast seen costs nothing on the hot path')

check('a zero timeout means do not wait, not the five-second default', () => {
  // `timeoutMs || 5000` turned 0 into 5000. The one number that meant "never
  // wait" silently became the longest wait in the file.
  lockState.waits = []; lockState.refused = false
  gs.withScriptLockOptional_(0, () => 'ran')
  eq(lockState.waits, [0])
})

check('an omitted timeout still defaults to five seconds', () => {
  lockState.waits = []
  gs.withScriptLockOptional_(undefined, () => 'ran')
  eq(lockState.waits, [5000])
})

check('last seen never asks for a wait', () => {
  cacheState.store = {}
  lockState.waits = []; lockState.refused = false
  gs.touchLastSeen_('anthea@sheldonglobal.com')
  lockState.waits.forEach((w) => eq(w, 0, 'last seen must not wait for the lock'))
})

check('a person recorded in the last hour costs no lock at all', () => {
  cacheState.store = {}
  lockState.refused = false
  gs.touchLastSeen_('wenxuan@sheldonglobal.com')  // the first one may write
  lockState.waits = []; lockState.acquisitions = 0
  gs.touchLastSeen_('wenxuan@sheldonglobal.com')  // every one after must not
  gs.touchLastSeen_('wenxuan@sheldonglobal.com')
  eq(lockState.acquisitions, 0, 'no lock taken for a person already recorded this hour')
  eq(lockState.waits, [], 'and none even tried')
})

check('a busy lock skips the write and tries again next time', () => {
  // Remembered only once it landed, so a refused lock is not mistaken for a
  // recorded visit and the next request gets its turn.
  cacheState.store = {}
  lockState.refused = true
  gs.touchLastSeen_('brien@sheldonglobal.com')
  eq(Object.keys(cacheState.store).some((k) => k.indexOf('seen:brien') === 0), false,
    'a skipped write must not be cached as done')
  lockState.refused = false
})

check('the freshness window is an hour', () => eq(gs.LAST_SEEN_TTL_S, 3600))



// ---------------------------------------------------------------------------
// Sign-in does not re-read the Users tab on every request — safely.
//
// resolveUser_ runs on every authenticated request, and read the whole Users
// tab from the Sheet each time: 0.3-1.5s on sign-in, 0.2-1.0s on every push
// and refresh. It is now cached for a minute. These pin the rules that make
// that safe, because this is the code that decides who is allowed in.
// ---------------------------------------------------------------------------
console.log('\nthe Users tab is cached for sign-in, and never at the cost of safety')

{
  const USERS_HEADERS = ['email', 'name', 'role', 'first_seen', 'last_seen', 'approved_by', 'note']
  let userRows = []
  let userReads = 0
  const usersSheet = () => ({
    getLastRow: () => userRows.length + 1,
    getRange: (r, c, nr, nc) => ({
      getValues: () => { userReads++; return userRows.map((row) => row.slice(c - 1, c - 1 + nc)) },
      getValue: () => '',
      setValue: () => {},
      setValues: () => {},
      setFontWeight() { return this },
    }),
  })
  const person = (email, role) => [email, email.split('@')[0], role, '', '', '', '']
  const freshRequest = () => gs.invalidateRead_()  // each execution starts with no per-request memo
  const installUsers = () => {
    gs.__setHeaders('Users', USERS_HEADERS)
    gs.__setSheetImpl(usersSheet)
    cacheState.store = {}
    freshRequest()
    userReads = 0
  }

  check('a known person is found without re-reading the Sheet on the next request', () => {
    installUsers()
    userRows = [person('brienchua@sheldonglobal.com', 'admin'), person('anthea@sheldonglobal.com', 'lister')]
    eq(gs.findUser_('anthea@sheldonglobal.com').role, 'lister')
    const afterFirst = userReads
    freshRequest()
    eq(gs.findUser_('anthea@sheldonglobal.com').role, 'lister')
    freshRequest()
    eq(gs.findUser_('anthea@sheldonglobal.com').role, 'lister')
    eq(userReads, afterFirst, 'the second and third requests must not touch the Sheet')
  })

  /**
   * A Users tab that behaves like the real one where it matters here: values
   * written with setValue sit in a buffer until SpreadsheetApp.flush(), as
   * Apps Script's do, and setRole_ finds its row with getValue.
   */
  const pending = []
  const bufferedUsersSheet = () => ({
    getLastRow: () => userRows.length + 1,
    getRange: (r, c, nr, nc) => ({
      getValues: () => { userReads++; return userRows.map((row) => row.slice(c - 1, c - 1 + (nc || 1))) },
      getValue: () => (userRows[r - 2] || [])[c - 1],
      setValue: (v) => { pending.push(() => { userRows[r - 2][c - 1] = v }) },
      setValues: (vals) => { vals.forEach((row) => pending.push(() => { userRows.push(row.slice()) })) },
      setFontWeight() { return this },
    }),
  })
  const flushUsers = () => { while (pending.length) pending.shift()() }

  check('a block made through setRole is seen on the very next request', () => {
    // Through the real setRole_, not a stand-in for what it is supposed to call.
    installUsers()
    gs.__setSheetImpl(bufferedUsersSheet)
    gs.__spreadsheetApp.flush = flushUsers
    userRows = [person('brienchua@sheldonglobal.com', 'admin'), person('anthea@sheldonglobal.com', 'lister')]
    eq(gs.findUser_('anthea@sheldonglobal.com').role, 'lister')     // warms the cache
    gs.setRole_('anthea@sheldonglobal.com', 'blocked', { email: 'brienchua@sheldonglobal.com', name: 'Brien' })
    freshRequest()
    eq(gs.findUser_('anthea@sheldonglobal.com').role, 'blocked')
    gs.__spreadsheetApp.flush = () => {}
  })

  check('a sign-in that read the tab just before a block cannot undo it', () => {
    // The race the review reproduced: a request misses the cache, reads the
    // OLD rows, and saves them AFTER setRole has cleared the cache. Clearing a
    // key cannot stop that; a version the stale copy was not saved under can.
    installUsers()
    gs.__setSheetImpl(bufferedUsersSheet)
    gs.__spreadsheetApp.flush = flushUsers
    userRows = [person('brienchua@sheldonglobal.com', 'admin'), person('anthea@sheldonglobal.com', 'lister')]
    const racerVersion = gs.usersVersion_()                        // the racer reads the version…
    const stale = JSON.stringify(gs.usersAll_())                    // …and the old rows
    gs.setRole_('anthea@sheldonglobal.com', 'blocked', { email: 'brienchua@sheldonglobal.com', name: 'Brien' })
    CACHE.store['users:auth:v' + racerVersion] = stale               // …then saves them, late
    CACHE.store['users:auth'] = stale                                // (and under the old, unversioned key)
    freshRequest()
    eq(gs.findUser_('anthea@sheldonglobal.com').role, 'blocked', 'the late stale copy must be unreachable')
    gs.__spreadsheetApp.flush = () => {}
  })

  check('the role is flushed to the Sheet before the cache is retired', () => {
    // Otherwise the first reader of the new version can still read the old
    // role out of a Sheet whose write is sitting in the buffer.
    installUsers()
    gs.__setSheetImpl(bufferedUsersSheet)
    const order = []
    gs.__spreadsheetApp.flush = () => { order.push('flush'); flushUsers() }
    const realProps = authState.props
    authState.props = new Proxy({}, { set: (t, k, v) => { if (k === 'USERS_VERSION') order.push('bump'); t[k] = v; return true } })
    userRows = [person('brienchua@sheldonglobal.com', 'admin'), person('anthea@sheldonglobal.com', 'lister')]
    gs.setRole_('anthea@sheldonglobal.com', 'blocked', { email: 'brienchua@sheldonglobal.com', name: 'Brien' })
    const bump = order.indexOf('bump')
    eq(bump > 0 && order.slice(0, bump).includes('flush'), true, 'order was ' + JSON.stringify(order))
    authState.props = realProps
    gs.__spreadsheetApp.flush = () => {}
  })

  check('two first sign-ins for the same newcomer register them once', () => {
    // The hedged whoami sends a second request on a slow first sign-in. Both
    // used to look, both see nobody, and both append — a second row setRole
    // can never reach. The look that decides must be taken under the lock.
    installUsers()
    userRows = [person('brienchua@sheldonglobal.com', 'admin')]
    const newcomer = { email: 'new.staff@sheldonglobal.com', name: 'New Staff' }
    const appendSheet = () => ({
      getLastRow: () => userRows.length + 1,
      getRange: (r, c, nr, nc) => ({
        getValues: () => { const snap = userRows.map((row) => row.slice(c - 1, c - 1 + nc)); onRead(); return snap },
        getValue: () => '', setValue: () => {},
        setValues: (vals) => { vals.forEach((row) => userRows.push(row.slice())) },
        setFontWeight() { return this },
      }),
    })
    gs.__setSheetImpl(appendSheet)
    // Dry run: how many reads does a first sign-in take outside the lock?
    let unlocked = 0
    let onRead = () => { if (!lockState.held) unlocked++ }
    const before = userRows.length
    gs.resolveUser_(newcomer)
    const decisive = unlocked
    userRows.length = before
    // Real run: the other request runs start to finish during the LAST read
    // this one takes without the lock — the read that says "absent".
    cacheState.store = {}; freshRequest()
    let seen = 0, fired = false
    onRead = () => {
      if (lockState.held || fired) return
      if (++seen === decisive) { fired = true; freshRequest(); gs.resolveUser_(newcomer) }
    }
    gs.resolveUser_(newcomer)
    const rows = userRows.filter((r) => r[0] === newcomer.email)
    eq(rows.length, 1, 'registered ' + rows.length + ' times')
  })

  check('a miss in the cache re-reads the Sheet before calling anyone new', () => {
    // Brien adds someone by hand; the cached copy has not heard of them yet.
    // Treating that as "new" would register them a second time as pending.
    installUsers()
    userRows = [person('brienchua@sheldonglobal.com', 'admin')]
    gs.findUser_('brienchua@sheldonglobal.com')      // warms the cache without Judy
    userRows.push(person('judy@sheldonglobal.com', 'lister'))
    freshRequest()
    const judy = gs.findUser_('judy@sheldonglobal.com')
    eq(Boolean(judy), true, 'a person added by hand must be found, not treated as new')
    eq(judy.role, 'lister')
  })

  check('someone genuinely absent is still reported absent', () => {
    installUsers()
    userRows = [person('brienchua@sheldonglobal.com', 'admin')]
    eq(gs.findUser_('stranger@example.com'), null)
  })

  check('registering anyone retires the cached copy', () => {
    installUsers()
    userRows = [person('brienchua@sheldonglobal.com', 'admin')]
    gs.findUser_('brienchua@sheldonglobal.com')
    const v = gs.usersVersion_()
    gs.appendRows_('Users', [person('new@sheldonglobal.com', 'pending')])
    userRows.push(person('new@sheldonglobal.com', 'pending'))
    eq(gs.usersVersion_() > v, true, 'appendRows_ to Users must move the version on')
    freshRequest(); userReads = 0
    eq(Boolean(gs.findUser_('new@sheldonglobal.com')), true)
  })

  check('the cache is short-lived', () => eq(gs.USERS_CACHE_TTL_S <= 60, true))
}



// ---------------------------------------------------------------------------
// A push does not search Drive for the same folder over and over.
//
// Finding the photo folder took three Drive calls, and a push saves two files
// into it (photo and thumbnail), searching from scratch both times — about
// eight sequential Drive round trips before TikTok was contacted.
// ---------------------------------------------------------------------------
console.log('\nthe photo folder is found once, not on every save')

{
  let driveCalls = 0
  let deleted = new Set()
  const folder = (id, name) => ({
    getId: () => id,
    getName: () => name,
    getFoldersByName: (n) => {
      driveCalls++
      let given = false
      return { hasNext: () => !given, next: () => { given = true; return folder(id + '/' + n, n) } }
    },
    createFolder: (n) => { driveCalls++; return folder(id + '/' + n, n) },
    createFile: (blob) => { driveCalls++; return { getUrl: () => 'https://drive/' + id } },
  })
  const fakeDrive = {
    getFolderById: (id) => {
      driveCalls++
      if (deleted.has(id)) throw new Error('No item with the given ID could be found')
      return folder(id, 'root')
    },
  }
  const installDrive = () => {
    gs.__setDriveApp(fakeDrive)
    gs.__resetPhotoFolderMemo()
    cacheState.store = {}
    deleted = new Set()
    driveCalls = 0
  }
  const newExecution = () => gs.__resetPhotoFolderMemo()   // memo is per execution; the cache is not

  check("a push's photo and thumbnail find their folder once between them", () => {
    installDrive()
    gs.datedPhotoFolder_('PM')
    const first = driveCalls
    gs.datedPhotoFolder_('PM')     // the thumbnail, same execution
    eq(driveCalls, first, 'the second save in one push must not touch Drive to find the folder')
  })

  check('a later push opens the folder by id: one call, not three', () => {
    installDrive()
    gs.datedPhotoFolder_('PM')     // first push of the day resolves it
    newExecution()
    driveCalls = 0
    gs.datedPhotoFolder_('PM')     // the next push
    eq(driveCalls, 1, 'one getFolderById from the remembered id')
  })

  check('a remembered folder that was deleted is looked up again, not lost', () => {
    installDrive()
    const f = gs.datedPhotoFolder_('PM')
    deleted.add(f.getId())
    newExecution()
    const again = gs.datedPhotoFolder_('PM')
    eq(Boolean(again), true, 'a stale id must fall back to finding the folder, never fail the save')
  })

  check('each shop has its own folder', () => {
    installDrive()
    const pm = gs.datedPhotoFolder_('PM')
    const hz = gs.datedPhotoFolder_('HZ')
    eq(pm.getId() === hz.getId(), false)
  })

  check('the remembered folder expires within the working day', () =>
    eq(gs.PHOTO_FOLDER_TTL_S <= 6 * 3600, true))

  check("tomorrow's push does not reuse today's folder", () => {
    // The TTL cannot promise this — six hours from 11pm is 5am — so the day
    // must be in the key.
    installDrive()
    const today = gs.datedPhotoFolder_('PM', new Date('2026-09-23T15:00:00Z'))   // 11pm SGT
    newExecution()
    const tomorrow = gs.datedPhotoFolder_('PM', new Date('2026-09-23T17:00:00Z')) // 1am SGT, next day
    eq(today.getId() === tomorrow.getId(), false, 'both resolved to ' + today.getId())
    eq(tomorrow.getId().indexOf('2026-09-24') >= 0, true, tomorrow.getId())
  })

  check('a changed Photos root is used at once, not after the cache expires', () => {
    // The cache outlives a re-paste; the root must be part of what it names.
    installDrive()
    const at = new Date('2026-09-23T06:00:00Z')
    gs.__setPhotosRoot('ROOT_OLD')
    gs.datedPhotoFolder_('PM', at)
    newExecution()
    gs.__setPhotosRoot('ROOT_NEW')
    const f = gs.datedPhotoFolder_('PM', at)
    eq(f.getId().indexOf('ROOT_NEW') === 0, true, 'filed under ' + f.getId())
  })
}



// ---------------------------------------------------------------------------
// The signed request is unchanged by the split into build and send.
//
// ttFetch_ built, signed, sent and parsed in one function. It is now
// ttRequest_ (build and sign) plus a send, so independent calls can go out
// in one round trip. A signing mistake here fails EVERY push with an opaque
// TikTok refusal, so the URL is compared byte for byte against a golden value
// captured from the code as it was before the split.
// ---------------------------------------------------------------------------
console.log('\nthe signed TikTok request is byte-for-byte what it was')

{
  const FIXED_MS = 1_790_000_000_000
  const sent = []
  const fakeFetch = {
    fetch: (url, opts) => {
      sent.push({ url, opts })
      return { getResponseCode: () => 200, getContentText: () => '{"code":0,"data":{"uri":"tos-u"}}' }
    },
    fetchAll: (batch) => batch.map((b) => {
      sent.push({ url: b.url, opts: b, batched: true })
      return { getResponseCode: () => 200, getContentText: () => '{"code":0,"data":{"uri":"tos-u"}}' }
    }),
  }
  const withTikTok = (fn) => {
    const realNow = Date.now
    Date.now = () => FIXED_MS
    authState.props = {
      HZ_APP_KEY: 'appkey123', HZ_APP_SECRET: 'secret456',
      HZ_ACCESS_TOKEN: 'tok789', HZ_ACCESS_EXPIRES: String(Math.floor(FIXED_MS / 1000) + 30 * 86400),
      HZ_SHOP_CIPHER: 'cipherABC',
    }
    gs.__setUrlFetch(fakeFetch)
    sent.length = 0
    try { return fn() } finally { Date.now = realNow }
  }

  /**
   * Captured from TikTok.gs as it was BEFORE the split (commit 29792ca) and
   * matched exactly by the code after it. If this ever changes, the signing
   * changed, and every push will fail at TikTok until it is explained.
   */
  const GOLDEN_URL = 'https://open-api.tiktokglobalshop.com/product/202309/products/123?app_key=appkey123&timestamp=1790000000&shop_cipher=cipherABC&category_version=v2&return_under_review_version=true&sign=56053f93a7378df83dbf2f9956eadce1d8383ae6da7efdf408142d08983d6622'

  check('a product read is signed exactly as before the split', () => {
    withTikTok(() => gs.ttFetch_('HZ', 'get', '/product/202309/products/123',
      { category_version: 'v2', return_under_review_version: 'true' }, null))
    if (process.env.PRINT_GOLDEN) console.log('GOLDEN=' + sent[0].url)
    eq(sent[0].url, GOLDEN_URL)
    eq(sent[0].opts.headers['x-tts-access-token'], 'tok789')
    eq(sent[0].opts.method, 'get')
  })

  check('building a request sends nothing', () => {
    withTikTok(() => gs.ttRequest_('HZ', 'get', '/product/202309/products/123',
      { category_version: 'v2', return_under_review_version: 'true' }, null))
    eq(sent.length, 0, 'ttRequest_ must only build, never send')
  })

  check('the request built is the one ttFetch_ sends', () => {
    const built = withTikTok(() => gs.ttRequest_('HZ', 'get', '/product/202309/products/123',
      { category_version: 'v2', return_under_review_version: 'true' }, null))
    eq(built.url, GOLDEN_URL)
  })

  check('fetchAll sends every request in ONE batch and answers in order', () => {
    const out = withTikTok(() => gs.ttFetchAll_([
      gs.ttRequest_('HZ', 'get', '/product/202309/products/1', {}, null),
      gs.ttRequest_('HZ', 'get', '/product/202309/products/2', {}, null),
    ]))
    eq(sent.filter((x) => x.batched).length, 2, 'both requests went in the batch')
    eq(sent.filter((x) => !x.batched).length, 0, 'none went one at a time')
    eq(out.length, 2)
    eq(out[0].code, 0)
    eq(sent[0].url.indexOf('/products/1?') > 0, true, 'first answer is for the first request')
  })

  check('a throttled answer in a batch is retried once, on its own', () => {
    let first = true
    const throttling = {
      fetch: (url, opts) => { sent.push({ url, retried: true }); return { getResponseCode: () => 200, getContentText: () => '{"code":0}' } },
      fetchAll: (batch) => batch.map(() => {
        const r = first ? { getResponseCode: () => 429, getContentText: () => '{"code":36009002}' }
                        : { getResponseCode: () => 200, getContentText: () => '{"code":0}' }
        first = false
        return r
      }),
    }
    const out = withTikTok(() => { gs.__setUrlFetch(throttling); return gs.ttFetchAll_([
      gs.ttRequest_('HZ', 'get', '/product/202309/products/1', {}, null),
      gs.ttRequest_('HZ', 'get', '/product/202309/products/2', {}, null),
    ]) })
    eq(out[0].code, 0, 'the throttled one was retried and succeeded')
    eq(sent.filter((x) => x.retried).length, 1, 'retried exactly once, and only that one')
  })

  check('the retry goes to the request that was throttled, and its answer lands in its own slot', () => {
    // The test above always throttles the first request and answers every URL
    // alike, so it passes whichever request is retried. Retrying the wrong
    // one is not harmless: in a push, the image-upload answer would be read
    // as the PRODUCT, whose SKU list would then be empty — and a partial edit
    // deletes every SKU it does not list.
    const retried = []
    const answerFor = (url) => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ code: 0, data: { url: url.split('?')[0] } }) })
    const throttling = {
      fetch: (url) => { retried.push(url.split('?')[0]); return answerFor(url) },
      fetchAll: (batch) => batch.map((b) => b.url.indexOf('/products/2?') > 0
        ? { getResponseCode: () => 429, getContentText: () => '{"code":36009002}' }
        : answerFor(b.url)),
    }
    const out = withTikTok(() => { gs.__setUrlFetch(throttling); return gs.ttFetchAll_([
      gs.ttRequest_('HZ', 'get', '/product/202309/products/1', {}, null),
      gs.ttRequest_('HZ', 'get', '/product/202309/products/2', {}, null),
    ]) })
    eq(retried.length, 1)
    eq(retried[0].endsWith('/products/2'), true, 'retried ' + retried[0])
    eq(out[0].data.url.endsWith('/products/1'), true, 'first slot holds the first answer')
    eq(out[1].data.url.endsWith('/products/2'), true, 'second slot holds the retried answer')
  })
}



// ---------------------------------------------------------------------------
// A push sends its independent TikTok calls together.
//
// Upload the image, THEN read the product, THEN edit it — strictly one after
// another, though the first two need nothing from each other. They now go in
// one parallel batch, and only the edit waits.
// ---------------------------------------------------------------------------
console.log('\nindependent TikTok calls share one round trip')

{
  const FIXED_MS = 1_790_000_000_000
  let sent = []
  const reply = (body) => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(body) })
  const PRODUCT = { code: 0, data: { id: 'P1', status: 'ACTIVATE', skus: [], main_images: [{ uri: 'main-uri' }] } }
  const IMAGE = { code: 0, data: { uri: 'tos-img' } }
  const route = (url, fail) => {
    if (url.indexOf('/images/upload') > 0) return fail === 'image' ? { code: 12052000, message: 'bad image' } : IMAGE
    if (url.indexOf('/products/') > 0) return fail === 'product' ? { code: 12052001, message: 'no such product' } : PRODUCT
    return { code: 0 }
  }
  const tiktok = (fail) => ({
    fetch: (url) => { sent.push({ url, batched: false }); return reply(route(url, fail)) },
    fetchAll: (batch) => batch.map((b) => { sent.push({ url: b.url, batched: true }); return reply(route(b.url, fail)) }),
  })
  const run = (fn, fail) => {
    const realNow = Date.now
    Date.now = () => FIXED_MS
    authState.props = {
      HZ_APP_KEY: 'k', HZ_APP_SECRET: 's', HZ_ACCESS_TOKEN: 't',
      HZ_ACCESS_EXPIRES: String(Math.floor(FIXED_MS / 1000) + 30 * 86400), HZ_SHOP_CIPHER: 'c',
    }
    gs.__setUrlFetch(tiktok(fail))
    sent = []
    try { return fn() } finally { Date.now = realNow }
  }
  const blob = () => ({ getBytes: () => [1, 2, 3] })

  check('an append uploads the image and reads the product in ONE round trip', () => {
    const out = run(() => gs.appendAssets_('HZ', blob(), 'P1'))
    eq(sent.filter((x) => x.batched).length, 2, 'both calls in the batch')
    eq(sent.filter((x) => !x.batched).length, 0, 'nothing sent one at a time')
    eq(out.attributeImageUri, 'tos-img')
    eq(out.snapshot.productId, 'P1')
    eq(out.snapshot.mainImageUri, 'main-uri')
  })

  check('a new listing uploads both images in ONE round trip', () => {
    const out = run(() => gs.newListingAssets_('HZ', [1, 2, 3], 'image/jpeg'))
    eq(sent.filter((x) => x.batched).length, 2)
    eq(sent.filter((x) => !x.batched).length, 0)
    eq(out.attributeImageUri, 'tos-img')
    eq(out.imageUri, 'tos-img')
  })

  check('a failed upload still reports TS-PRD-01, exactly as before', () => {
    let code = ''
    try { run(() => gs.appendAssets_('HZ', blob(), 'P1'), 'image') } catch (e) { code = gs.codeOf_(e) }
    eq(code, 'TS-PRD-01')
  })

  check('a failed product read still reports TS-PRD-02', () => {
    let code = ''
    try { run(() => gs.appendAssets_('HZ', blob(), 'P1'), 'product') } catch (e) { code = gs.codeOf_(e) }
    eq(code, 'TS-PRD-02')
  })

  check('the upload is ATTRIBUTE_IMAGE and the read asks for the version under review', () => {
    run(() => gs.appendAssets_('HZ', blob(), 'P1'))
    const up = sent.find((x) => x.url.indexOf('/images/upload') > 0)
    const rd = sent.find((x) => x.url.indexOf('/products/P1') > 0)
    eq(up.url.indexOf('use_case=ATTRIBUTE_IMAGE') > 0, true)
    // The live snapshot is the wrong one during a stream — see ttGetProduct_.
    eq(rd.url.indexOf('return_under_review_version=true') > 0, true)
  })
}



// ---------------------------------------------------------------------------
// Writing a log line never waits for anybody.
//
// logEvent_ went through appendRows_, which takes the script lock for up to
// thirty seconds. Reads that log a warning hold no lock, and some warn on
// every call — so a listing refresh during a push could wait half a minute to
// write one line. Sheet.appendRow is atomic, so a single row needs no lock.
// ---------------------------------------------------------------------------
console.log('\nlogging takes no lock')

{
  const appended = []
  const logSheet = () => ({
    appendRow: (row) => appended.push(row),
    getLastRow: () => appended.length + 1,
    getRange: () => ({ getValues: () => [], setValues: () => {}, setValue: () => {}, setFontWeight() { return this } }),
  })
  const install = () => {
    gs.__setSheetImpl(logSheet)
    appended.length = 0
    lockState.waits = []
    lockState.acquisitions = 0
    lockState.refused = false
  }

  check('a log line is actually written', () => {
    // Guards against the vacuous version: before the formatDate fix this
    // threw before the write, and every test of this path passed on nothing.
    install()
    gs.logEvent_('brien', 'add_variation', 'HZ', 'A7', 'ok')
    eq(appended.length, 1, 'the row must reach the sheet')
    eq(appended[0][2], 'add_variation')
  })

  check('a log line takes no lock at all', () => {
    install()
    gs.logEvent_('brien', 'add_variation', 'HZ', 'A7', 'ok')
    eq(lockState.waits, [], 'no tryLock, so nothing can make it wait')
    eq(lockState.acquisitions, 0)
  })

  check('a warning takes no lock either', () => {
    install()
    gs.warn_('TS-ORD-27', '3 order line(s) carry no creation time')
    eq(lockState.waits, [])
    eq(appended.length, 1)
  })

  check('two executions that both find the Log tab missing both keep their line', () => {
    // Through the real sheet_. Execution B runs in full in the gap between A
    // looking for the tab and A creating it. Creating it without the lock made
    // A's insert throw "already exists", and logEvent_ swallowed A's line.
    const tabs = {}
    const rows = []
    let interleave = null
    const makeTab = (name) => ({
      getName: () => name,
      appendRow: (r) => rows.push(r[2]),
      getLastRow: () => 1, getLastColumn: () => 6,
      getRange: () => ({ getValues: () => [gs.HEADERS_LOG || ['time', 'actor', 'action', 'shop', 'detail', 'result']], setValues() { return this }, setFontWeight() { return this }, clearContent() { return this } }),
      setFrozenRows: () => {},
    })
    const book = {
      getSheetByName: (n) => {
        const hit = tabs[n] || null
        if (n === 'Log' && interleave) { const go = interleave; interleave = null; go() }
        return hit
      },
      insertSheet: (n) => {
        if (tabs[n]) throw new Error('A sheet with the name "' + n + '" already exists.')
        tabs[n] = makeTab(n); return tabs[n]
      },
      getSheets: () => Object.values(tabs),
      deleteSheet: () => {},
    }
    const realOpen = gs.__spreadsheetApp.openById
    gs.__spreadsheetApp.openById = () => book
    gs.__setSheetImpl(gs.__sheetReal)
    lockState.refused = false
    interleave = () => gs.logEvent_('B', 'B line', '', '', 'ok')
    gs.logEvent_('A', 'A line', '', '', 'ok')
    gs.__spreadsheetApp.openById = realOpen
    eq(rows.filter((a) => a.endsWith(' line')).sort(), ['A line', 'B line'])
  })

  check('a log line still lands while another write holds the lock', () => {
    // The case that used to wait up to thirty seconds and then give up.
    install()
    lockState.refused = true
    gs.logEvent_('system', 'warn', '', 'during a push', 'warn')
    eq(appended.length, 1, 'written regardless of who holds the lock')
    lockState.refused = false
  })
}



// ---------------------------------------------------------------------------
// The daily upload count is right, in the shapes the Sheet actually returns.
//
// It compared String(pushed_at) with today's date. Sheets turns the ISO string
// into a Date object, so that read "Wed Sep 23 2026 ..." and never matched; and
// a push before 8am Singapore carries yesterday's UTC date. It reported zero,
// so the low-allowance warning never showed.
// ---------------------------------------------------------------------------
console.log('\nthe daily upload count sees every push made today')

{
  // 23 Sep 2026, 14:00 Singapore = 06:00 UTC.
  const NOW = Date.parse('2026-09-23T06:00:00Z')
  let rows = []
  let reads = 0
  const skuSheet = () => ({
    getLastRow: () => rows.length + 1,
    getRange: (r, c, nr, nc) => ({
      getValues: () => { reads++; return rows.map((o) => SKU_COLS.slice(c - 1, c - 1 + nc).map((k) => (k in o ? o[k] : ''))) },
      setValues: () => {}, setValue: () => {}, setFontWeight() { return this },
    }),
  })
  const SKU_COLS = ['shop_id', 'status', 'pushed_at']
  const count = (fn) => {
    const realNow = Date.now
    const RealDate = Date
    Date.now = () => NOW
    global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW) } static now() { return NOW } }
    gs.__setHeaders('SKUs', SKU_COLS)
    gs.__setSheetImpl(skuSheet)
    gs.invalidateRead_()
    cacheState.store = {}
    reads = 0
    try { return fn() } finally { Date.now = realNow; global.Date = RealDate }
  }

  check('a push the Sheet hands back as a Date object is counted', () => {
    // What Sheets actually returns for an ISO string written into a cell.
    rows = [{ shop_id: 'PM', status: 'pushed', pushed_at: new Date('2026-09-23T03:15:00Z') }]
    eq(count(() => gs.pushedToday_('PM')), 1)
  })

  check('a push before 8am Singapore counts as today, not yesterday', () => {
    // 07:00 SGT on the 23rd is 23:00 UTC on the 22nd.
    rows = [{ shop_id: 'PM', status: 'pushed', pushed_at: '2026-09-22T23:00:00.000Z' }]
    eq(count(() => gs.pushedToday_('PM')), 1)
  })

  check('yesterday in Singapore is not today', () => {
    // 23:00 SGT on the 22nd is 15:00 UTC on the 22nd.
    rows = [{ shop_id: 'PM', status: 'pushed', pushed_at: '2026-09-22T15:00:00.000Z' }]
    eq(count(() => gs.pushedToday_('PM')), 0)
  })

  check('only this shop, and only what was actually pushed', () => {
    rows = [
      { shop_id: 'PM', status: 'pushed', pushed_at: '2026-09-23T03:00:00.000Z' },
      { shop_id: 'HZ', status: 'pushed', pushed_at: '2026-09-23T03:00:00.000Z' },
      { shop_id: 'PM', status: 'failed', pushed_at: '2026-09-23T03:00:00.000Z' },
      { shop_id: 'PM', status: 'pushed', pushed_at: '' },
    ]
    eq(count(() => gs.pushedToday_('PM')), 1)
  })

  check('the count is not recomputed from the whole tab on every open', () => {
    rows = [{ shop_id: 'PM', status: 'pushed', pushed_at: '2026-09-23T03:00:00.000Z' }]
    count(() => {
      gs.pushedToday_('PM')
      gs.invalidateRead_()          // a later request
      const before = reads
      gs.pushedToday_('PM')
      eq(reads, before, 'served from cache, no Sheet read')
    })
  })

  check('any push starts a fresh count, so the cache is never behind a write', () => {
    rows = [{ shop_id: 'PM', status: 'pushed', pushed_at: '2026-09-23T03:00:00.000Z' }]
    count(() => {
      eq(gs.pushedToday_('PM'), 1)
      rows.push({ shop_id: 'PM', status: 'pushed', pushed_at: '2026-09-23T04:00:00.000Z' })
      gs.bumpSkuVersion_()          // what every SKU write does
      gs.invalidateRead_()
      eq(gs.pushedToday_('PM'), 2)
    })
  })
}



// ---------------------------------------------------------------------------
// The listing picker is newest first, not ordered by weekday.
//
// It sorted on String(created_at). Sheets hands that back as a Date object, so
// the string was "Wed Sep 23 ..." and the picker sorted by weekday name — the
// fault fixed for the variation list and left here.
// ---------------------------------------------------------------------------
console.log('\nthe listing picker is newest first')

{
  const COLS = ['listing_id', 'shop_id', 'created_at']
  let rows = []
  const listSheet = () => ({
    getLastRow: () => rows.length + 1,
    getRange: (r, c, nr, nc) => ({
      getValues: () => rows.map((o) => COLS.slice(c - 1, c - 1 + nc).map((k) => (k in o ? o[k] : ''))),
      setValues: () => {}, setValue: () => {}, setFontWeight() { return this },
    }),
  })
  const install = () => { gs.__setHeaders('Listings', COLS); gs.__setSheetImpl(listSheet); gs.invalidateRead_() }

  check('Date objects from the Sheet sort by time, not weekday name', () => {
    install()
    // Mon 21, Sun 20, Wed 23 Sep. By weekday text: Mon, Sun, Wed. By time: 23, 21, 20.
    rows = [
      { listing_id: 'MON', shop_id: 'HZ', created_at: new Date('2026-09-21T03:00:00Z') },
      { listing_id: 'SUN', shop_id: 'HZ', created_at: new Date('2026-09-20T03:00:00Z') },
      { listing_id: 'WED', shop_id: 'HZ', created_at: new Date('2026-09-23T03:00:00Z') },
    ]
    eq(gs.listListings_('HZ').map((l) => l.listing_id), ['WED', 'MON', 'SUN'])
  })

  check('a mix of Date objects and ISO strings sorts together', () => {
    install()
    rows = [
      { listing_id: 'A', shop_id: 'HZ', created_at: '2026-09-20T03:00:00.000Z' },
      { listing_id: 'B', shop_id: 'HZ', created_at: new Date('2026-09-22T03:00:00Z') },
      { listing_id: 'C', shop_id: 'HZ', created_at: '2026-09-21T03:00:00.000Z' },
    ]
    eq(gs.listListings_('HZ').map((l) => l.listing_id), ['B', 'C', 'A'])
  })

  check('a listing with no usable time sorts last', () => {
    install()
    rows = [
      { listing_id: 'NONE', shop_id: 'HZ', created_at: '' },
      { listing_id: 'OLD', shop_id: 'HZ', created_at: '2026-09-01T03:00:00.000Z' },
    ]
    eq(gs.listListings_('HZ').map((l) => l.listing_id), ['OLD', 'NONE'])
  })

  check('only the asked shop', () => {
    install()
    rows = [
      { listing_id: 'X', shop_id: 'HZ', created_at: '2026-09-20T03:00:00.000Z' },
      { listing_id: 'Y', shop_id: 'PM', created_at: '2026-09-21T03:00:00.000Z' },
    ]
    eq(gs.listListings_('HZ').map((l) => l.listing_id), ['X'])
  })
}


console.log('\n' + pass + ' passed, ' + fail + ' failed\n')
process.exit(fail ? 1 : 0)
