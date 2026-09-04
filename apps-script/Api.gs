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

/** Actions that must serialise, because they read-then-write the Sheet. */
var WRITE_ACTIONS = {
  addListing: 1, saveSku: 1, pushSku: 1, exportListing: 1, setRole: 1
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

    // Identity comes from a Google ID token the frontend forwards, verified
    // against Google — never from a claim the caller simply asserts.
    var identity = verifyIdToken_(body.id_token || params.id_token);
    if (!identity) return json_({ error: 'Sign in with Google to continue.' }, 401);

    var user = resolveUser_(identity);

    if (action === 'whoami') {
      return json_({
        email: user.email, name: user.name, role: user.role,
        approved: canList_(user), admin: isAdmin_(user)
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

    if (WRITE_ACTIONS[action]) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) {
        return json_({ error: 'The app is busy. Try again in a moment.' }, 503);
      }
      try {
        return route_(action, params, body, user);
      } finally {
        lock.releaseLock();
      }
    }
    return route_(action, params, body, user);
  } catch (err) {
    // Log the detail, return something safe. A stack trace in a response body
    // is information disclosure.
    console.error(action + ' failed: ' + err + (err && err.stack ? '\n' + err.stack : ''));
    logEvent_((params && params.actor) || 'unknown', action, '', String(err), 'error');
    return json_({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

function route_(action, params, body, user) {
  switch (action) {
    case 'shops':
      return json_(shopsForClient_());

    case 'listings':
      return json_(listListings_(params.shop_id || body.shop_id));

    case 'addListing':
      return json_(addListing_(body.shop_id, body.listing_id, user.name));

    case 'skus':
      return json_(listSkus_(params.listing_id || body.listing_id));

    case 'allowance':
      var shopId = params.shop_id || body.shop_id;
      var used = pushedToday_(shopId);
      return json_({ used: used, cap: Number(prop_(shopId + '_DAILY_CAP') || 1000),
                     remaining: Math.max(0, Number(prop_(shopId + '_DAILY_CAP') || 1000) - used) });

    case 'pushSku':
      return json_(pushSku_(body, user));

    case 'exportListing':
      return json_(exportListing_(body.listing_id, user.name));

    case 'users':
      if (!isAdmin_(user)) return json_({ error: 'Admins only.' }, 403);
      return json_(usersAll_());

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
  if (allowed.indexOf(role) === -1) throw new Error('Unknown role: ' + role);
  if (target === String(OWNER_EMAIL).toLowerCase() && role !== ROLE_ADMIN) {
    // Without this, one mistake locks everyone out of approving anyone.
    throw new Error('The owner account cannot be demoted.');
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
  throw new Error('No such user: ' + target);
}

function json_(obj, status) {
  // Apps Script web apps always answer 200; the status is carried in the body
  // so the frontend can branch on it.
  if (status) obj._status = status;
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
