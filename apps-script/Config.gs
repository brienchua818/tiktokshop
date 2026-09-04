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
