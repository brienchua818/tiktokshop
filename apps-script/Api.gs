/**
 * The JSON API.
 *
 * Same shape as Sheldon Delivery API — `?action=` routing, LockService around
 * writes — so the two projects read alike.
 *
 * Every action except `ping` requires a verified Google identity AND an
 * approved role. Authentication proves who someone is; the allowlist decides
 * whether they may act. Conflating the two is how an app that pushes to live
 * shops ends up open to anyone with a Google account.
 */


/**
 * Anything over this is worth a line in the log. The phone gives up at 25 s
 * on a read and 90–240 s on a write, so a backend action that takes longer
 * than 15 s is already most of the way to looking like a hang from a factory
 * floor — and the log is the only place the duration is visible.
 */
var SLOW_ACTION_MS = 15000;

function timed_(action, fn) {
  var started = Date.now();
  var result = fn();
  var ms = Date.now() - started;
  if (ms > SLOW_ACTION_MS) warn_('TS-API-04', action + ' took ' + Math.round(ms / 1000) + 's');
  return result;
}

/**
 * Who is acting, for the log's error path. Set once identity is verified, so a
 * failure after that point is attributed to a person rather than "unknown" —
 * which is what every export failure read as in the log.
 */
var actorName_ = '';

/** How a person is named on a file they asked for: name, then email as the id. */
function requester_(user) {
  var name = String(user.name || '').trim();
  var email = String(user.email || '').trim();
  if (name && email) return name + ' (' + email + ')';
  return name || email || 'unknown';
}

function doGet(e) {
  // TikTok sends the seller back as {redirect_url}?code=...&state=...
  // Checked before anything else, or the callback would be treated as an API
  // call and the authorisation silently lost.
  if (e && e.parameter && e.parameter.code && !e.parameter.action) {
    return ttHandleAuthCallback_(e);
  }
  return handle_(e, 'GET');
}

function doPost(e) {
  return handle_(e, 'POST');
}

/**
 * Actions that must serialise, because they read-then-write the Sheet.
 *
 * Deliberately short. The lock is held for the WHOLE action, and during a
 * broadcast every SKU push needs it — so anything slow in here stalls the one
 * thing that cannot wait.
 *
 * The exports and the order sync are not here on purpose. They make dozens of
 * TikTok calls and build a spreadsheet, which is minutes; holding the lock
 * across that would make a push mid-stream queue behind an export. They touch
 * different tabs from a push, so they never needed to serialise against one —
 * only against themselves, which each does internally around its own write.
 */
var WRITE_ACTIONS = {
  addListing: 1, saveSku: 1, pushSku: 1, setRole: 1,
  // Rebuilds the product from a read, exactly as pushSku does; two at once
  // would each write the other's variation out of existence.
  removeVariation: 1
};

/** Actions callable without an approved role. */
var OPEN_ACTIONS = { ping: 1, whoami: 1 };

function handle_(e, method) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  var body = {};
  if (method === 'POST' && e && e.postData && e.postData.contents) {
    try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
  }
  var params = e && e.parameter ? e.parameter : {};

  try {
    if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });

    // Identity: a session this backend issued, or failing that a Google ID
    // token verified against Google — never a claim the caller simply asserts.
    // The session is checked first because it is free (an HMAC, no network)
    // and lasts a working day; the Google token is the way to get one.
    var sessionToken = body.session_token || params.session_token;
    var googleToken = body.id_token || params.id_token;
    var identity = sessionToken ? verifySession_(sessionToken) : { ok: false, code: 'NO_TOKEN' };
    if (!identity.ok && googleToken) identity = verifyIdToken_(googleToken);
    if (!identity.ok && !googleToken && !sessionToken) identity = verifyIdToken_('');
    if (!identity.ok) {
      // The reason travels with the refusal. Every one of these used to read
      // "Sign in with Google to continue.", so a backend that was merely
      // misconfigured looked exactly like a user who had not signed in — and
      // the screen looped with nothing to act on.
      return json_({ error: identity.message, code: identity.code }, 401);
    }

    var user = resolveUser_(identity);
    actorName_ = user.name || user.email || '';

    if (action === 'whoami') {
      // Every whoami hands back a fresh session, so a phone that checks in at
      // the start of a stream is good until well after it ends.
      var session = issueSession_(user);
      return json_({
        email: user.email, name: user.name, role: user.role,
        approved: canList_(user), admin: isAdmin_(user),
        session_token: session.session_token, session_expires_at: session.session_expires_at
      });
    }

    if (!canList_(user)) {
      // Deliberately explicit: a person waiting for approval should know that
      // is what is happening, not see a generic refusal.
      return json_({
        error: user.role === ROLE_BLOCKED
          ? 'This account has been blocked.'
          : 'Your account is awaiting approval. Ask Brien to approve ' + user.email + '.',
        role: user.role
      }, 403);
    }

    // One lock for the whole write, taken here and nowhere deeper. Everything
    // below assumes it is held; see Lock.gs for why nesting it is a trap.
    if (WRITE_ACTIONS[action]) {
      return timed_(action, function () {
        return withScriptLock_(30000, function () {
          return route_(action, params, body, user);
        });
      });
    }
    return timed_(action, function () { return route_(action, params, body, user); });
  } catch (err) {
    var message = String(err && err.message ? err.message : err);

    // Two outcomes reach here that are not failures, and the client has to be
    // able to tell them apart from a genuine one — retrying a rejected listing
    // burns the shop's daily allowance, while NOT retrying a busy one loses a
    // SKU mid-livestream.

    // The listing filled up. Singapore allows 100 variations per product, so a
    // long factory run simply outgrows one; the client offers a continuation
    // listing rather than showing an error.
    if (err && err.code === 'LISTING_FULL') {
      return json_({
        error: message, code: 'LISTING_FULL',
        product_id: err.listingId || '', sku_count: err.skuCount || 0,
        max_skus: MAX_SKUS_PER_PRODUCT, next: 'start_new_listing'
      }, 409);
    }

    // Another write holds the lock. Retryable, and nothing has been lost.
    if (/^BUSY:/.test(message)) {
      return json_({
        error: message.replace(/^BUSY:\s*/, ''), code: 'LISTING_BUSY', retryable: true
      }, 409);
    }

    // Every failure leaves with a code. One this backend raised carries its
    // own (TS-EXP-07 is one line of Export.gs); one the runtime raised — a
    // Sheets limit, a Drive permission, a TypeError — is TS-UNC-00, which
    // says "nobody anticipated this" and names the runtime's own error type,
    // because that is the finding. The same code goes to the app, the Log
    // tab and the execution log, so any one of the three is enough to look
    // it up in ERROR-CODES.md.
    var code = codeOf_(err);
    if (code === 'TS-UNC-00' && err && err.name && err.name !== 'Error') {
      message = err.name + ': ' + message;
    }
    console.error('[' + code + '] ' + action + ' failed: ' + err +
      (err && err.stack ? '\n' + err.stack : ''));
    logEvent_(actorName_ || (params && params.actor) || 'unknown', action, '',
      '[' + code + '] ' + message, 'error');

    // A rejection from TikTok is the operator's to act on, so its own wording
    // goes through verbatim — "you haven't set the return warehouse" is
    // actionable, "push failed" is not. 422 rather than 500: the request was
    // understood and refused, and the client must not retry it.
    return json_({ error: message, code: code }, action === 'pushSku' ? 422 : 500);
  }
}

function route_(action, params, body, user) {
  switch (action) {
    case 'shops':
      return json_(shopsForClient_());

    // The shop's live products, so a stream can be chosen rather than typed.
    case 'tiktokProducts':
      return json_(ttSearchProducts_(
        params.shop_id || body.shop_id,
        params.page_token || body.page_token || ''
      ));

    case 'listings':
      return json_(listListings_(params.shop_id || body.shop_id));

    // Reads its arguments from either place, like the read actions above.
    //
    // Not for tidiness: when a browser mishandles the redirect Apps Script
    // answers through, the client retries the same call as a GET, and an
    // action that only looks at the body would refuse it. This one is on the
    // critical path — no listing means no stream to add SKUs to — so it must
    // survive that retry. pushSku deliberately does not, because a photo does
    // not fit in a URL; it is protected by its idempotency key instead.
    case 'addListing':
      return json_(addListing_(
        params.shop_id || body.shop_id,
        params.listing_id || body.listing_id,
        user.name,
        params.product_name || body.product_name || ''
      ));

    // What TikTok shows right now: review state, and stock per variation.
    // Read-only and safe to call on a refresh button.
    case 'listingState':
      return json_(listingState_(params.listing_id || body.listing_id));

    case 'skus':
      return json_(listedSkusForClient_(params.listing_id || body.listing_id));

    // Remove one variation from TikTok and mark our record. Confirmed on the
    // client first; this end does not second-guess a person, it does the edit
    // safely or not at all.
    case 'removeVariation':
      return json_(removeVariation_(body.listing_id, body.tiktok_sku_id, user));

    case 'allowance':
      var shopId = params.shop_id || body.shop_id;
      var used = pushedToday_(shopId);
      return json_({ used: used, cap: Number(prop_(shopId + '_DAILY_CAP') || 1000),
                     remaining: Math.max(0, Number(prop_(shopId + '_DAILY_CAP') || 1000) - used) });

    case 'pushSku':
      return json_(pushSku_(body, user));

    // Pull a window of orders down from TikTok into the Sheet.
    case 'syncOrders':
      return json_(syncOrders_(
        body.shop_id, body.from_date, body.from_time, body.to_date, body.to_time,
        user.name
      ));

    // Per-listing totals inside a window. The window applies to every line
    // item, so a listing used on two streams reports only the one asked about.
    case 'orderSummary':
      return json_(orderSummary_(
        params.shop_id || body.shop_id,
        params.from_date || body.from_date, params.from_time || body.from_time,
        params.to_date || body.to_date, params.to_time || body.to_time
      ));

    // The variations behind one listing's total, in the same window.
    case 'listingOrders':
      return json_(listingOrders_(
        params.listing_id || body.listing_id,
        params.from_date || body.from_date, params.from_time || body.from_time,
        params.to_date || body.to_date, params.to_time || body.to_time
      ));

    // The purchase order: one workbook, a summary and a sheet per listing,
    // scoped to the same window as the screen it was launched from.
    case 'exportOrders':
      return json_(exportOrders_(
        body.shop_id, body.listing_ids || [],
        body.from_date, body.from_time, body.to_date, body.to_time,
        body.cost_divisor, requester_(user)
      ));

    case 'exportListing':
      return json_(exportListing_(params.listing_id || body.listing_id, requester_(user)));

    case 'users':
      if (!isAdmin_(user)) return json_({ error: 'Admins only.' }, 403);
      return json_(usersAll_());

    // Left POST-only on purpose. It is an admin action taken once in a while,
    // never mid-stream, so it does not need to survive a broken redirect — and
    // the fewer ways there are to change someone's role, the better.
    case 'setRole':
      if (!isAdmin_(user)) return json_({ error: 'Admins only.' }, 403);
      return json_(setRole_(body.email, body.role, user));

    default:
      return json_({ error: 'Unknown action: ' + action }, 400);
  }
}

function shopsForClient_() {
  return SHOPS.map(function (s) {
    return {
      shop_id: s.id,
      brand: s.brand,
      tiktok_handle: s.handle,
      entity: s.entity,
      authorised: Boolean(prop_(s.id + '_ACCESS_TOKEN')),
      daily_listing_cap: Number(prop_(s.id + '_DAILY_CAP') || 1000)
    };
  });
}

/** Change someone's role. Admins only, and the owner cannot be demoted. */
function setRole_(email, role, actor) {
  var target = String(email || '').toLowerCase();
  var allowed = [ROLE_ADMIN, ROLE_LISTER, ROLE_PENDING, ROLE_BLOCKED];
  if (allowed.indexOf(role) === -1) throw fail_('TS-API-01', 'Unknown role: ' + role);
  if (target === String(OWNER_EMAIL).toLowerCase() && role !== ROLE_ADMIN) {
    // Without this, one mistake locks everyone out of approving anyone.
    throw fail_('TS-API-02', 'The owner account cannot be demoted.');
  }

  var sh = sheet_(TAB_USERS);
  var last = sh.getLastRow();
  for (var i = 2; i <= last; i++) {
    if (String(sh.getRange(i, 1).getValue()).toLowerCase() === target) {
      sh.getRange(i, 3).setValue(role);
      sh.getRange(i, 6).setValue(actor.email);
      logEvent_(actor.name, 'set_role', '', target + ' -> ' + role, 'ok');
      return { email: target, role: role };
    }
  }
  throw fail_('TS-API-03', 'No such user: ' + target);
}

function json_(obj, status) {
  // Apps Script web apps always answer 200; the status is carried in the body
  // so the frontend can branch on it.
  if (status) obj._status = status;
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
