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

/** The Drive things a person may want to open, by real URL. */
function driveLinks_() {
  return {
    sheet: 'https://docs.google.com/spreadsheets/d/' + DATA_SHEET_ID + '/edit',
    log: 'https://docs.google.com/spreadsheets/d/' + DATA_SHEET_ID + '/edit#gid=0',
    exports: 'https://drive.google.com/drive/folders/' + EXPORTS_FOLDER_ID,
    photos: 'https://drive.google.com/drive/folders/' + PHOTOS_FOLDER_ID,
    root: 'https://drive.google.com/drive/folders/' + DRIVE_ROOT_ID
  };
}

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
  // Read-modify-write on TikTok's stock, so it must not interleave with
  // another phone doing the same thing to the same variation.
  setStock: 1,
  // Hands out a number two phones must never share. See reserveIdentifier_.
  reserveIdentifier: 1,
  // Rebuilds the product from a read, exactly as pushSku does; two at once
  // would each write the other's variation out of existence.
  removeVariation: 1,
  // Rebuilds the product from a read, exactly as a push does.
  restoreVariation: 1
};

/** Actions callable without an approved role. */
var OPEN_ACTIONS = { ping: 1, whoami: 1 };

function handle_(e, method) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  var body = {};
  /**
   * What actually arrived, recorded rather than inferred.
   *
   * Brien, Painting Matters, 16 Sep: a pushSku refused with NO_TOKEN while he
   * was signed in. NO_TOKEN means neither credential field reached this
   * function, and the credential was in the POST body — so the body did not
   * arrive intact. Which of the three ways that can happen was a guess:
   * postData absent, contents empty, or contents present but not JSON.
   *
   * A guess is not good enough for something that stops a broadcast, so the
   * refusal below now names the case instead. `bodyState` is the diagnosis.
   */
  var bodyState = 'n/a';
  if (method === 'POST') {
    if (!e || !e.postData) bodyState = 'no postData';
    else if (!e.postData.contents) bodyState = 'postData empty';
    else {
      bodyState = 'parsed ' + e.postData.contents.length + ' bytes';
      try {
        body = JSON.parse(e.postData.contents);
      } catch (err) {
        body = {};
        bodyState = 'unparseable, ' + e.postData.contents.length + ' bytes';
      }
    }
  }
  var params = e && e.parameter ? e.parameter : {};

  try {
    // `build` is how anyone — Brien, a probe, or the next person debugging a
    // fix that "did not work" — tells a pasted backend from a stale one. It
    // names the commit the paste was generated from. Unauthenticated on
    // purpose: it has to be answerable before sign-in, and the repository is
    // public, so a commit sha discloses nothing.
    if (action === 'ping') return json_({
      ok: true,
      build: typeof BACKEND_BUILD === 'string' ? BACKEND_BUILD : 'unstamped',
      time: new Date().toISOString()
    });

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
      if (identity.code === 'NO_TOKEN') {
        /**
         * The one refusal that is never the person's fault.
         *
         * NO_TOKEN means no credential reached this function at all, which the
         * app refuses to let happen — it will not send a request without one.
         * So it is a transport failure, and the only useful thing to say is
         * what arrived. Logged with the action and the body's state so the
         * next occurrence is a fact rather than another inference.
         */
        warn_('TS-API-06', 'No credential reached the backend on "' + action + '" (' +
          method + '). Body: ' + bodyState + '. Query keys: ' +
          Object.keys(params).join(', ') + '.');
        return json_({
          error: identity.message, code: identity.code,
          body_state: bodyState, method: method
        }, 401);
      }
      return json_({ error: identity.message, code: identity.code }, 401);
    }

    var user = resolveUser_(identity);
    actorName_ = user.name || user.email || '';

    if (action === 'whoami') {
      // Every whoami hands back a fresh session, so a phone that checks in at
      // the start of a stream is good until well after it ends.
      var session = issueSession_(user);
      return json_({
        email: user.email, name: user.name, role: normaliseRole_(user.role),
        approved: canList_(user), admin: isAdmin_(user),
        session_token: session.session_token, session_expires_at: session.session_expires_at,
        // Where the data actually lives. Served rather than hardcoded in the
        // app, so a folder can be moved without a redeploy — and so the
        // "Data sheet" row in the app opens the real thing instead of a
        // guess at its URL.
        links: driveLinks_()
      });
    }

    if (!canList_(user)) {
      // Deliberately explicit: a person waiting for approval should know that
      // is what is happening, not see a generic refusal.
      var role = normaliseRole_(user.role);
      // Coded, because "blocked" and "awaiting approval" need different
      // actions from different people and were previously indistinguishable
      // to anything reading the reply — including the app, which could only
      // show the sentence and hope somebody read it carefully.
      return json_({
        error: role === ROLE_BLOCKED
          ? 'This account has been blocked.'
          : 'Your account is awaiting approval. Ask Brien to approve ' + user.email + '.',
        code: role === ROLE_BLOCKED ? 'ACCOUNT_BLOCKED' : 'AWAITING_APPROVAL',
        role: role
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

    /**
     * "Refused" and "went wrong" are different answers, and only one is final.
     *
     * A rejection from TikTok is the operator's to act on, so its own wording
     * goes through verbatim — "you haven't set the return warehouse" is
     * actionable, "push failed" is not. 422 rather than 500: the request was
     * understood and refused, and the client must NOT retry it, because it
     * would be refused identically and each attempt costs daily allowance.
     *
     * That was applied to every exception, which is how a transient
     * infrastructure error became permanent. Brien, HOUZE, 16 Sep: WX11 and
     * WX12 both stopped dead on "Exception: Service error: Drive" — Drive
     * having one of its periodic bad minutes — because the catch answered 422
     * and the client reads 422 as "will fail identically, park it". A retry
     * three seconds later would have worked.
     *
     * TS-UNC-00 is precisely the code for "nobody anticipated this": it is set
     * by codeOf_ when the error carries no code of ours, which means the
     * RUNTIME raised it — a Drive outage, a Sheets limit, a TypeError — not a
     * decision anybody made about this SKU. Those get 500, which the client
     * already treats as retryable. Everything we or TikTok deliberately
     * refused keeps 422 and stays final.
     */
    var unanticipated = code === 'TS-UNC-00';
    var status = (action === 'pushSku' && !unanticipated) ? 422 : 500;
    return json_({ error: message, code: code, retryable: unanticipated }, status);
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

    /**
     * EVERY action reads its arguments from the query string as well as the
     * body. `params.x || body.x`, with one documented exception.
     *
     * Not tidiness. Apps Script delivers every reply through a 302 to a
     * GET-only host, and when a browser preserves the method rather than
     * downgrading it the client retries the same call as a GET — on which leg
     * the body is gone. An action that only looks at the body gets undefined
     * for every argument.
     *
     * This has now been found three times, on setRole ("Unknown role:
     * undefined") and on removeVariation, where Wen Xuan could not delete a
     * variation on 15 Sep and got "Unknown listing: undefined [TS-PRD-09]"
     * mid-broadcast. Fixing them one at a time is why it came back, so the
     * rule is asserted by a test over this function rather than remembered.
     *
     * The exception is `pushSku`: a photo does not fit in a URL. It is
     * protected by its idempotency key instead.
     */
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
      return json_(removeVariation_(
        params.listing_id || body.listing_id,
        params.tiktok_sku_id || body.tiktok_sku_id,
        user
      ));

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
        params.shop_id || body.shop_id,
        params.from_date || body.from_date, params.from_time || body.from_time,
        params.to_date || body.to_date, params.to_time || body.to_time,
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
        params.shop_id || body.shop_id,
        // An array cannot ride in a query string as itself, so on the GET leg
        // it arrives comma-separated. Split rather than dropped, or an export
        // retried as a GET would quietly cover every listing instead of the
        // ones asked for.
        body.listing_ids || (params.listing_ids ? String(params.listing_ids).split(',') : []),
        params.from_date || body.from_date, params.from_time || body.from_time,
        params.to_date || body.to_date, params.to_time || body.to_time,
        params.cost_divisor || body.cost_divisor, requester_(user)
      ));

    case 'exportListing':
      return json_(exportListing_(params.listing_id || body.listing_id, requester_(user)));

    /**
     * Change one variation's stock.
     *
     * A delta ("add 10 more") rather than a total, because TikTok's endpoint
     * REPLACES the quantity — established against the real API on 8 Sep — so
     * two phones topping up during a broadcast must add 10 and 10 rather than
     * both writing the same stale total and one silently undoing the other.
     * The absolute form is there for "set it to exactly this".
     */
    case 'setStock':
      return json_(setVariationStock_(
        params.listing_id || body.listing_id,
        params.identifier || body.identifier,
        params.tiktok_sku_id || body.tiktok_sku_id,
        Number(params.delta || body.delta || 0),
        (params.absolute || body.absolute) === undefined ? null : Number(params.absolute || body.absolute),
        user
      ));

    case 'reserveIdentifier':
      return json_(reserveIdentifier_(
        params.listing_id || body.listing_id,
        params.prefix || body.prefix
      ));

    // Asked for only when the Removed tab is opened. See removedVariations_.
    case 'removedVariations':
      return json_(removedVariations_(
        params.listing_id || body.listing_id,
        params.limit || body.limit
      ));

    // Put a removed variation back. A write, so it takes the lock like any
    // other: it rebuilds the product from a read, and two at once would each
    // write the other's variation out of existence.
    case 'restoreVariation':
      return json_(restoreVariation_(
        params.listing_id || body.listing_id,
        params.identifier || body.identifier,
        params.stock || body.stock,
        user
      ));

    case 'users':
      if (!isAdmin_(user)) return json_({ error: 'Admins only.' }, 403);
      return json_(usersForClient_());

    /**
     * Reads its arguments from the query string as well as the body.
     *
     * It was body-only, on the reasoning that a write should be POST-only so
     * it cannot happen by following a link. The reasoning was sound and the
     * result was broken: every Apps Script reply is delivered by a 302 to a
     * GET-only host, and when a browser preserves the method instead of
     * downgrading it, the client retries the same call as a GET. On that leg
     * the body is gone, so `body.role` was undefined and every role change
     * failed with "Unknown role: undefined".
     *
     * So it accepts both, like every other action. The protection that
     * actually holds is the one shared by all of them: no request without a
     * valid session or ID token gets an identity, and no identity without the
     * admin role gets past the line above.
     */
    case 'setRole':
      if (!isAdmin_(user)) return json_({ error: 'Admins only.' }, 403);
      return json_(setRole_(params.email || body.email, params.role || body.role, user));

    default:
      return json_({ error: 'Unknown action: ' + action }, 400);
  }
}

/**
 * The allowlist as the app should see it, with the role canonicalised.
 *
 * The Users tab is edited by hand, so a role arrives as "Lister", " admin " or
 * "ADMIN". The backend's own checks lowercase before comparing, so those all
 * work for access; the app compared the raw string and showed the person with
 * no role selected at all. One place to normalise beats two places to remember.
 */
function usersForClient_() {
  return usersAll_().map(function (u) {
    var copy = {};
    Object.keys(u).forEach(function (k) { copy[k] = u[k]; });
    copy.role = normaliseRole_(u.role);
    return copy;
  });
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
  var target = String(email || '').trim().toLowerCase();
  var want = normaliseRole_(role);
  var allowed = [ROLE_ADMIN, ROLE_LISTER, ROLE_PENDING, ROLE_BLOCKED];
  // Names the role it was given and the ones it would accept. "Unknown role:
  // undefined" was the whole error message for a fortnight and said nothing
  // about what had actually gone wrong.
  if (allowed.indexOf(want) === -1) {
    throw fail_('TS-API-01',
      'Unknown role: ' + JSON.stringify(role) + '. Expected one of ' + allowed.join(', ') + '.');
  }
  if (!target) throw fail_('TS-API-05', 'No email given, so there is nobody to change.');
  role = want;
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
      // Written outside Sheet.gs, so it clears the request read cache itself.
      invalidateRead_(TAB_USERS);
      // And the cross-request copy sign-in uses, so a block or an approval
      // takes effect on the very next request rather than a minute later.
      invalidateUsersCache_();
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
