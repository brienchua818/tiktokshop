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
// `authorizeFn` names the toolbar function that starts this shop's consent
// flow. It is here rather than built from the id because checkSetup has to
// print a name a person can actually pick from the Run dropdown — and the one
// it used to print, ttAuthorizeUrl('HZ'), cannot be run that way at all, since
// the editor has no way to pass an argument.
/**
 * The Google client this backend accepts sign-ins for.
 *
 * Hardcoded, and not a secret: the same string ships inside the app's public
 * JavaScript, because that is where the browser gets it from to start a
 * sign-in at all. Putting it here changes nothing an attacker can do — the
 * check that matters is still that a token's `aud` equals this value.
 *
 * It was a Script Property alone, which was the wrong shape. A value the
 * backend cannot work without, that is not secret and does not vary, should
 * not be something a person has to type into a settings page — the only thing
 * that achieves is a deployment that is silently unable to sign anyone in. The
 * property still wins when set, so a second deployment against a different
 * client stays a one-line change.
 */
var DEFAULT_GOOGLE_CLIENT_ID =
  '418799041411-i6rin2ejph0qu3l9ekjbgl0ksgbnpr1b.apps.googleusercontent.com';

/** The client id in force: the property if set, otherwise the constant. */
function googleClientId_() {
  return prop_('GOOGLE_CLIENT_ID') || DEFAULT_GOOGLE_CLIENT_ID;
}

var SHOPS = [
  { id: 'HZ', brand: 'HOUZE',            handle: '@houze.com.sg',    entity: 'Sheldon Global Pte Ltd', authorizeFn: 'authorizeHOUZE' },
  { id: 'TM', brand: 'Table Matters',    handle: '@tablematterssg',  entity: 'Audrey Global Pte Ltd',  authorizeFn: 'authorizeTableMatters' },
  // Painting Matters' legal entity is not recorded in the vault yet. Left
  // blank rather than guessed — a wrong entity is corrosive once exports
  // become purchase orders.
  { id: 'PM', brand: 'Painting Matters', handle: '@paintingmatters', entity: '', authorizeFn: 'authorizePaintingMatters' }
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
/**
 * How long a variation can plausibly still be under review.
 *
 * A review runs minutes, not hours. Past this a variation TikTok has never
 * shown was refused or lost, and carrying it forward into every later push
 * would grow each payload and risk the whole edit for something that is not
 * coming back.
 */
var REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a variation must have been missing before it counts as deleted.
 *
 * Getting this wrong deletes: a row marked removed is dropped from the
 * carry-forward, and TikTok deletes any SKU absent from a partial edit. Ten
 * minutes is far longer than any read lag and far shorter than a stream, so a
 * deliberate removal still leaves the list within a refresh or two.
 */
var REMOVAL_GRACE_MS = 10 * 60 * 1000;

/**
 * How many removals the app shows. The rest live in the Sheet.
 *
 * Ten because the tab exists to undo a mistake, and a mistake is noticed in
 * the next minute or not at all. A listing reused across streams accumulates
 * removals for ever; I12 had 121 against 32 live.
 */
var REMOVED_RECENT = 10;

var TAB_ORDERS = 'Orders';
var TAB_ORDER_ITEMS = 'Order Items';
var TAB_RETURNS = 'Returns';
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
/**
 * Read a script property.
 *
 * Trimmed, because these are pasted by hand out of consoles that helpfully
 * append a newline. An untrimmed client id compares unequal to the same id
 * inside a token, and the only symptom is that sign-in silently fails — which
 * is exactly the kind of fault that costs an evening.
 */
function prop_(k) { return String(props_().getProperty(k) || '').trim(); }
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

  // First, because every other line is only meaningful once you know WHICH
  // paste produced them. An unstamped build is one generated before the stamp
  // existed, which is itself the answer to "is this current".
  lines.push('BUILD');
  if (typeof BACKEND_BUILD === 'string' && BACKEND_BUILD) {
    ok(BACKEND_BUILD);
    note('compare this against the commit you were told to paste');
  } else {
    bad('this paste predates the build stamp, so its version cannot be told');
    note('paste the current TikShopBackend.gs into Code.gs and redeploy');
  }

  lines.push('');
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

  // The single most misconfigured value in this whole setup, and the one with
  // the least helpful failure: TikTok redirects to whatever Partner Center has
  // registered, and if that is a deployment id which no longer exists, Google
  // answers with "Sorry, unable to open the file at present" — a Drive error
  // page that says nothing about TikTok, Apps Script or deployments. Printing
  // the live URL turns that into a two-string comparison.
  lines.push('');
  lines.push('CALLBACK URL — must match Partner Center exactly, for every shop');
  try {
    var execUrl = ScriptApp.getService().getUrl();
    if (execUrl && execUrl.slice(-4) === '/dev') {
      /**
       * Run from the editor, this returns the /dev URL, not the /exec one.
       *
       * And they are NOT the same string with a different ending: /dev carries
       * the script id, /exec carries the DEPLOYMENT id, so neither can be
       * derived from the other. Telling somebody "must match Partner Center
       * exactly" while printing /dev is how the redirect gets set to a URL
       * that only works while the developer is signed in — which is the
       * /dev-vs-/exec failure already recorded in this project's history, and
       * it fails with a Google Drive error mentioning nothing relevant.
       *
       * So this refuses to pretend, rather than printing a plausible URL that
       * is the wrong one.
       */
      bad('this is the /dev URL, which is NOT what Partner Center needs');
      note('  ' + execUrl);
      note('  You ran checkSetup from the editor, so Apps Script returned the head');
      note('  URL. Partner Center needs the /exec one, and it carries a different');
      note('  id, so it cannot be worked out from this.');
      note('  Get it from Deploy > Manage deployments > the active deployment.');
    } else if (execUrl) {
      ok(execUrl);
      note('  Partner Center > your app > Redirect URL. One character off and');
      note('  authorising fails with a Google Drive error that mentions none of this.');
      note('  It changes ONLY if you make a new DEPLOYMENT; a new version keeps it.');
    } else {
      bad('no deployment URL — deploy this project as a web app first');
    }
  } catch (e) {
    bad('could not read the deployment URL: ' + e.message);
  }

  lines.push('');
  lines.push('GOOGLE SIGN-IN');
  // Presence is not the useful question — a client id that is present but
  // wrong refuses every sign-in just as completely as one that is missing,
  // and looks fine in a list of properties. So print it and check its shape.
  // It is not a secret: it ships inside the app's public JavaScript.
  var override = prop_('GOOGLE_CLIENT_ID');
  var clientId = googleClientId_();
  if (!clientId) {
    bad('no Google client id at all — sign-in cannot work');
  } else if (!override) {
    ok('GOOGLE_CLIENT_ID = ' + clientId);
    note('  built in, no Script Property needed');
    note('  set a GOOGLE_CLIENT_ID property only to point at a different client');
  } else if (clientId.indexOf('.apps.googleusercontent.com') === -1) {
    bad('GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com: ' + clientId);
    note('  that is probably the client SECRET or a project number, not the client ID');
  } else {
    ok('GOOGLE_CLIENT_ID = ' + clientId);
    note('  this must match VITE_GOOGLE_CLIENT_ID in Netlify exactly');
  }

  SHOPS.forEach(function (shop) {
    lines.push('');
    lines.push(shop.brand + '  (' + shop.id + ')');

    var creds = ['APP_KEY', 'APP_SECRET', 'SERVICE_ID'];
    var present = creds.filter(function (k) { return Boolean(prop_(shop.id + '_' + k)); });

    // A shop with nothing entered has not been started; a shop with some of
    // three has been started and got stuck. Those are different situations and
    // the second is the alarming one, so they do not read the same. Counting a
    // deliberately deferred shop as three separate faults buries the ones that
    // actually block a livestream.
    if (present.length === 0) {
      note('not set up yet — nothing entered for this shop');
      note('  skip this if you are not using it yet; otherwise Partner Center, ' +
           'on this shop\'s own custom app');
      return;
    }

    creds.forEach(function (k) {
      prop_(shop.id + '_' + k)
        ? ok(shop.id + '_' + k + ' set')
        : bad(shop.id + '_' + k + ' — the other ' + (present.length) + ' are set, so this one is a gap');
    });
    if (present.length < creds.length) {
      note('from Partner Center, on this shop\'s own custom app');
      return;
    }

    // Tokens, and how long they have left. A shop whose refresh token has
    // lapsed can only be recovered by authorising again, so the warning has to
    // come before it happens rather than after. TikTok gives both expiries as
    // absolute epoch SECONDS, not durations.
    var expiry = Number(prop_(shop.id + '_REFRESH_EXPIRES') || 0);
    if (!prop_(shop.id + '_ACCESS_TOKEN')) {
      bad('not authorised — run ' + shop.authorizeFn + ' from the function dropdown');
      return;
    }
    ok('authorised');
    if (expiry) {
      var days = Math.floor((expiry * 1000 - Date.now()) / 86400000);
      if (days > 3650) {
        // TikTok returns a far-future epoch for a refresh token it does not
        // intend to expire. "36125 days" is arithmetically right and reads as
        // a bug, so it is said in words.
        note('refresh token does not expire (TikTok returns a far-future date)');
      } else if (days > 14) {
        note('re-authorisation due in ' + days + ' days');
      } else {
        bad('re-authorise within ' + days + ' days');
      }
    }

    // Also worth surfacing: the shop_cipher, which nearly every call needs.
    prop_(shop.id + '_SHOP_CIPHER')
      ? ok('shop_cipher stored')
      : bad('no shop_cipher — re-run ' + shop.authorizeFn);

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

/**
 * Time every step a shop's FIRST push has to do, with nothing hidden.
 *
 * Anthea, 16 Sep, Painting Matters, first ever use of that shop in this app:
 * a pushSku came back as a 404 from the content host, which means the
 * execution produced NO REPLY. That is not an exception — `handle_` catches
 * every one of those and answers with a code — so it is a run that never
 * finished: the six-minute limit, a kill, or a quota refusal.
 *
 * A first push on a shop that has never been used does strictly more work
 * than any later one, and all of it is invisible from a phone:
 *
 *   - the access token may need refreshing (a network round trip)
 *   - `{P}_WAREHOUSE_ID` is not cached, so it costs a logistics call
 *   - `{P}_SHOP_CIPHER` may be unset, and nothing works without it
 *   - the shop's Drive photo folder does not exist yet and gets created
 *
 * Run this in the editor and read the timings. Two things come of it:
 * anything broken names itself HERE, with a stack, instead of vanishing into
 * a reply the browser never received; and everything cacheable is cached, so
 * the next real push from the phone is the cheap path rather than the
 * expensive one.
 *
 * Read-only apart from the caching, which is what the first push would have
 * written anyway. It creates no product and lists nothing.
 *
 *   warmShop('PM')   Painting Matters
 *   warmShop('HZ')   HOUZE
 *   warmShop('TM')   Table Matters
 */
function warmShop(prefix) {
  var id = String(prefix || 'PM').toUpperCase();
  var shop = shopById_(id);
  var lines = ['WARM ' + id + (shop ? '  (' + shop.brand + ')' : '  — UNKNOWN SHOP ID'), ''];
  var failed = 0;

  function step(label, fn) {
    var t0 = Date.now();
    try {
      var out = fn();
      lines.push('  OK    ' + label + '  ' + (Date.now() - t0) + 'ms' +
        (out ? '  — ' + out : ''));
      return out;
    } catch (e) {
      failed++;
      lines.push('  FAIL  ' + label + '  ' + (Date.now() - t0) + 'ms');
      lines.push('        ' + (e && e.message ? e.message : e));
      // The stack is the whole point of running this here rather than from a
      // phone, so it is printed rather than summarised.
      if (e && e.stack) lines.push('        ' + String(e.stack).split('\n').slice(0, 4).join('\n        '));
      return null;
    }
  }

  if (!shop) {
    lines.push('  Known shops: ' + SHOPS.map(function (s) { return s.id; }).join(', '));
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  step('credentials present', function () {
    ttCreds_(id);
    return 'app key and secret found';
  });

  step('access token', function () {
    var t = ttToken_(id);
    var exp = Number(prop_(id + '_ACCESS_EXPIRES') || 0);
    var days = exp ? Math.round((exp - Date.now() / 1000) / 86400) : 0;
    return t ? 'valid, ' + days + ' day(s) left' : 'EMPTY';
  });

  step('shop cipher', function () {
    var c = prop_(id + '_SHOP_CIPHER');
    if (!c) throw new Error('No shop cipher stored. Run ' + shop.authorizeFn +
      '() and complete the consent screen — nothing works without it.');
    return 'stored';
  });

  var warehouse = step('sales warehouse', function () {
    var cached = prop_(id + '_WAREHOUSE_ID');
    var w = ttWarehouseId_(id);
    return w + (cached ? ' (was already cached)' : ' (looked up and CACHED — this is the cost a first push pays)');
  });

  step('Drive photo folder', function () {
    var f = datedPhotoFolder_(id, sgtDate_(new Date()));
    return f.getName() + ' — ' + folderPath_(f);
  });

  step('product search reachable', function () {
    var r = ttFetch_(id, 'post', '/product/202502/products/search',
      { page_size: 1 }, { status: 'ALL' });
    if (r.code !== 0) throw new Error('TikTok refused: ' + ttReason_(r));
    return 'the Product API answers for this shop';
  });

  lines.push('');
  if (failed) {
    lines.push(failed + ' step(s) failed. The first one that failed is the thing to fix —');
    lines.push('the later steps depend on the earlier ones.');
  } else {
    lines.push('All steps passed, and everything cacheable is now cached.');
    lines.push('The next push from a phone skips the lookups timed above.');
    lines.push('');
    lines.push('Still not checkable from here: the RETURN WAREHOUSE, which has no API.');
    lines.push('If a push is refused with 12052535, set it in Seller Center for ' + shop.brand + '.');
  }

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}
