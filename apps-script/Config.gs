/**
 * TikShop backend — configuration.
 *
 * Runs as the deploying user, which is what gives it native access to the
 * shared drive and the Sheet without a service account. A service account
 * would have to be added as a member of the shared drive separately; running
 * as the user avoids that entirely.
 *
 * Conventions follow Sheldon Delivery API so the two projects stay legible
 * side by side: {PREFIX}_ Script Properties, a ?action= JSON router, and
 * LockService around anything that writes.
 */

/** Shared drive folder: "TikTok Livestream Buddy". */
var DRIVE_ROOT_ID = '1DMzpmTKGkBmAW2j_yaFJffKXIHZJU_ix';
var EXPORTS_FOLDER_ID = '1Jx5XCZqwnv4JT9_6w3M9eUC42In8mmGq';
var PHOTOS_FOLDER_ID = '1-bLKle65JB9Loqbi8wyF5cd2n8hZQ6AG';
var DATA_SHEET_ID = '1GRYYUP7NdgCwTIgt3UHiPh4K-cerNvo-PHQZfGUs2Jg';

var TT_HOST = 'https://open-api.tiktokglobalshop.com';
var TT_AUTH_HOST = 'https://auth.tiktok-shops.com';

/**
 * The three shops. Prefixes match Sheldon Delivery API's Script Properties, so
 * if the same app registrations are reused the credentials are already there.
 */
var SHOPS = [
  { id: 'HZ', brand: 'HOUZE',            handle: '@houze.com.sg',    entity: 'Sheldon Global Pte Ltd' },
  { id: 'TM', brand: 'Table Matters',    handle: '@tablematterssg',  entity: 'Audrey Global Pte Ltd' },
  // Painting Matters' legal entity is not recorded in the vault yet. Left
  // blank rather than guessed — a wrong entity is corrosive once exports
  // become purchase orders.
  { id: 'PM', brand: 'Painting Matters', handle: '@paintingmatters', entity: '' }
];

/** Singapore listing constraints, enforced before anything reaches TikTok. */
var TITLE_MIN = 25;
var TITLE_MAX = 255;
var CURRENCY = 'SGD';
var WEIGHT_UNIT = 'KILOGRAM';
var DIMENSION_UNIT = 'CENTIMETER';
var CATEGORY_VERSION = 'v2';

/** Fixed shipping declaration. Not shown in the form; see the decision note. */
var DEFAULT_WEIGHT_KG = '1';
var DEFAULT_DIMS = { length: '10', width: '10', height: '10' };

/**
 * A livestream is ONE TikTok product, and each SKU called out on air is a
 * variation of it.
 *
 * TikTok allows variation images on exactly one sales-attribute type per
 * product, and requires an image for every value of it — so one attribute with
 * one value per SKU is the shape that works, and it is what the buyer sees as
 * a gallery of photos to tap.
 */
var VARIANT_ATTRIBUTE_NAME = 'Design';   // max 20 chars, English only
var VALUE_NAME_MAX = 50;                 // sales_attributes.value_name

/**
 * Variations per product. Singapore gets 100 — "Max SKUs for BR, EU, JP, MX,
 * UK, US: 300. Max SKUs for other regions: 100" — so a 200-SKU factory run
 * needs a continuation listing, and finding that out at SKU 101 mid-broadcast
 * would be the worst possible moment.
 */
var MAX_SKUS_PER_PRODUCT = 100;

/** Sheet tab names. */
var TAB_LISTINGS = 'Listings';
var TAB_SKUS = 'SKUs';
var TAB_LOG = 'Log';
var TAB_USERS = 'Users';

/**
 * Who owns the allowlist. Seeded as admin on first run so there is always one
 * account that can approve others.
 */
var OWNER_EMAIL = 'brienchua@sheldonglobal.com';

/** Roles, most to least privileged. */
var ROLE_ADMIN = 'admin';    // can list, export, and approve people
var ROLE_LISTER = 'lister';  // can list and export
var ROLE_PENDING = 'pending';// signed in, waiting for approval, can do nothing
var ROLE_BLOCKED = 'blocked';

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k) || ''; }
function setProps_(o) { props_().setProperties(o, false); }

function shopById_(id) {
  for (var i = 0; i < SHOPS.length; i++) if (SHOPS[i].id === id) return SHOPS[i];
  return null;
}

/**
 * One-click setup check.
 *
 * Run this from the Apps Script editor after pasting the code and filling in
 * the properties. It reports everything the app needs and says which pieces
 * are missing, so the setup is verified in one run rather than by working
 * through a checklist and hoping.
 *
 * Deliberately reports rather than throws: the first missing property should
 * not hide the other eight. And it never prints a secret — only whether one is
 * present — because the execution log is a place things get pasted from.
 */
function checkSetup() {
  var lines = [];
  var problems = 0;

  function ok(label) { lines.push('  OK    ' + label); }
  function bad(label) { lines.push('  MISS  ' + label); problems++; }
  function note(label) { lines.push('        ' + label); }

  lines.push('SHEET');
  try {
    var ss = ss_();
    lines.push('  OK    ' + ss.getName());
    [TAB_LISTINGS, TAB_SKUS, TAB_LOG, TAB_USERS].forEach(function (tab) {
      ss.getSheetByName(tab) ? ok('tab ' + tab) : bad('tab ' + tab + ' — run setupSheets()');
    });
  } catch (e) {
    bad('cannot open the data sheet: ' + e.message);
    note('check DRIVE_ROOT_ID / DATA_SHEET_ID in Config.gs, and that you have access');
  }

  lines.push('');
  lines.push('PEOPLE');
  try {
    var users = readAll_(TAB_USERS);
    var owner = users.filter(function (u) {
      return String(u.email).toLowerCase() === OWNER_EMAIL.toLowerCase();
    })[0];
    if (owner && String(owner.role).toLowerCase() === ROLE_ADMIN) {
      ok(OWNER_EMAIL + ' is admin');
    } else {
      bad(OWNER_EMAIL + ' is not admin — run setupSheets()');
    }
    var listers = users.filter(function (u) {
      var r = String(u.role).toLowerCase();
      return r === ROLE_ADMIN || r === ROLE_LISTER;
    }).length;
    note(listers + ' account(s) can list, ' + users.length + ' signed in so far');
  } catch (e) {
    bad('cannot read the Users tab: ' + e.message);
  }

  lines.push('');
  lines.push('GOOGLE SIGN-IN');
  prop_('GOOGLE_CLIENT_ID')
    ? ok('GOOGLE_CLIENT_ID set')
    : bad('GOOGLE_CLIENT_ID — nobody can sign in without it');

  SHOPS.forEach(function (shop) {
    lines.push('');
    lines.push(shop.brand + '  (' + shop.id + ')');

    var missingCreds = false;
    ['APP_KEY', 'APP_SECRET', 'SERVICE_ID'].forEach(function (k) {
      if (prop_(shop.id + '_' + k)) {
        ok(shop.id + '_' + k + ' set');
      } else {
        bad(shop.id + '_' + k);
        missingCreds = true;
      }
    });
    if (missingCreds) {
      note('from Partner Center, on this shop\'s own custom app');
      return;
    }

    // Tokens, and how long they have left. A shop whose refresh token has
    // lapsed can only be recovered by authorising again, so the warning has to
    // come before it happens rather than after. TikTok gives both expiries as
    // absolute epoch SECONDS, not durations.
    var expiry = Number(prop_(shop.id + '_REFRESH_EXPIRES') || 0);
    if (!prop_(shop.id + '_ACCESS_TOKEN')) {
      bad('not authorised — run ttAuthorizeUrl(\'' + shop.id + '\')');
      return;
    }
    ok('authorised');
    if (expiry) {
      var days = Math.floor((expiry * 1000 - Date.now()) / 86400000);
      days > 14 ? note('re-authorisation due in ' + days + ' days')
                : bad('re-authorise within ' + days + ' days');
    }

    // Also worth surfacing: the shop_cipher, which nearly every call needs.
    prop_(shop.id + '_SHOP_CIPHER')
      ? ok('shop_cipher stored')
      : bad('no shop_cipher — re-run ttAuthorizeUrl(\'' + shop.id + '\')');

    // The two calls that actually have to work before a livestream.
    try {
      var shops = ttAuthorizedShops_(shop.id, ttToken_(shop.id));
      shops.code === 0 ? ok('TikTok answers') : bad('TikTok: ' + shops.message);
    } catch (e) {
      bad('TikTok call failed: ' + e.message);
      return;
    }
    try {
      ttWarehouseId_(shop.id);
      ok('sales warehouse found');
    } catch (e) {
      // Not the same as the RETURN warehouse, which has no API at all — but a
      // missing sales warehouse fails every listing, so it is worth catching here.
      bad(e.message);
    }
  });

  lines.push('');
  lines.push('NOT CHECKABLE FROM HERE');
  note('Return warehouse per shop — Seller Center only, no API. Error 12052535');
  note('ANTHROPIC_API_KEY / GEMINI_API_KEY — those live on Netlify, not here');

  lines.push('');
  lines.push(problems === 0
    ? 'READY. Nothing missing.'
    : problems + ' thing(s) to fix. Each is marked MISS above.');

  var report = lines.join('\n');
  Logger.log(report);
  return report;
}
