/**
 * TikTok Shop integration.
 *
 * The signing algorithm and token handling follow the same shape as
 * Sheldon Delivery API, which has been running them in production. Two
 * independent implementations of this signer agreed step for step, which is
 * the best evidence available that it is right.
 *
 * Script Properties per shop, {P} being HZ | TM | PM:
 *   {P}_APP_KEY, {P}_APP_SECRET, {P}_SERVICE_ID   (set by hand once)
 *   {P}_ACCESS_TOKEN, {P}_ACCESS_EXPIRES,
 *   {P}_REFRESH_TOKEN, {P}_REFRESH_EXPIRES,
 *   {P}_SHOP_CIPHER                                (written by the callback)
 */

function ttCreds_(prefix) {
  var key = prop_(prefix + '_APP_KEY');
  var secret = prop_(prefix + '_APP_SECRET');
  if (!key || !secret) {
    throw new Error('No app credentials for ' + prefix +
      '. Add ' + prefix + '_APP_KEY and ' + prefix + '_APP_SECRET in Script Properties.');
  }
  return { key: key, secret: secret };
}

/**
 * Request signature.
 *
 * Sort the query minus sign/access_token, join as key+value with NO
 * separators, prefix the path, append the exact body string (skipped for
 * multipart), wrap in the app secret, HMAC-SHA256, lowercase hex.
 */
function ttSign_(path, query, bodyString, secret) {
  var keys = Object.keys(query).filter(function (k) {
    return k !== 'sign' && k !== 'access_token';
  }).sort();
  var input = path;
  keys.forEach(function (k) { input += k + query[k]; });
  if (bodyString) input += bodyString;
  var raw = Utilities.computeHmacSha256Signature(secret + input + secret, secret);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function ttQuery_(q) {
  return Object.keys(q).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]);
  }).join('&');
}

/**
 * Consent URL for one shop.
 *
 * The service_id identifies the APP the seller is being asked to authorise, and
 * it is generated per app registration — so it is not interchangeable with the
 * one in Sheldon Delivery API. Reusing that one would send the seller to
 * authorise the delivery app, and TikTok would then redirect to the delivery
 * project's callback, not this one: the tokens would land in the wrong place
 * and this project would simply never receive them.
 *
 * Find it in Partner Center on the app's own page, alongside the App Key and
 * App Secret. If the label is not obvious, open the authorisation link Partner
 * Center generates for the app — the number after `service_id=` is it.
 */
function ttAuthorizeUrl(prefix) {
  var serviceId = prop_(prefix + '_SERVICE_ID');
  if (!serviceId) {
    throw new Error(
      'Set ' + prefix + '_SERVICE_ID in Script Properties first.\n\n' +
      'It comes from THIS project\'s ' + prefix + ' app in TikTok Partner Center — ' +
      'next to the App Key and App Secret, or as the number after "service_id=" in ' +
      'the authorisation link Partner Center shows for that app.\n\n' +
      'Do NOT copy it from Sheldon Delivery API. That is a different app ' +
      'registration, and its callback points at the delivery project — the ' +
      'tokens would never arrive here.'
    );
  }
  return 'https://services.tiktokshop.com/open/authorize?service_id=' +
    encodeURIComponent(serviceId) + '&state=' + encodeURIComponent(prefix);
}

/**
 * Zero-argument wrappers, one per shop.
 *
 * The Apps Script editor's Run button cannot pass arguments, so calling
 * ttAuthorizeUrl('HZ') from the toolbar is not possible — you would have to
 * edit the source to change the shop, which is exactly the kind of fiddling
 * that gets done wrong at speed. Three named functions make the dropdown the
 * whole interface.
 *
 * Each logs a consent URL. Open it in a browser signed in to THAT shop's
 * TikTok account, ideally a private window per shop so the sessions do not
 * collide.
 */
function authorizeHOUZE() { return logAuthorizeUrl_('HZ'); }
function authorizeTableMatters() { return logAuthorizeUrl_('TM'); }
function authorizePaintingMatters() { return logAuthorizeUrl_('PM'); }

/**
 * Every shop that still needs authorising, in one run.
 *
 * Authorising is the one step in this whole setup that cannot be automated —
 * it is a consent screen that has to be approved while signed in as the shop.
 * So the least this can do is stop making someone run a different function per
 * shop, work out which ones are outstanding, and re-read the log each time.
 *
 * Shops already authorised are skipped rather than re-listed, because a
 * re-authorisation that was not wanted costs the tokens currently working.
 * Shops with no credentials are skipped too — Table Matters is deliberately
 * not set up, and printing a broken link for it every run trains people to
 * ignore the output.
 */
function authorizeAll() {
  var lines = ['', 'SHOPS TO AUTHORISE', ''];
  var pending = 0;

  SHOPS.forEach(function (shop) {
    if (!prop_(shop.id + '_SERVICE_ID')) {
      lines.push('- ' + shop.brand + ': skipped, not set up yet');
      return;
    }
    if (prop_(shop.id + '_ACCESS_TOKEN')) {
      lines.push('- ' + shop.brand + ': already authorised, nothing to do');
      return;
    }
    pending++;
    lines.push('');
    lines.push('== ' + pending + '. ' + shop.brand + '  (' + shop.handle + ') ==');
    lines.push('Open this signed in as ' + shop.handle + ', in a PRIVATE window:');
    lines.push('');
    lines.push('   ' + ttAuthorizeUrl(shop.id));
    lines.push('');
  });

  lines.push('');
  if (pending === 0) {
    lines.push('Nothing to authorise. Run checkSetup to confirm the rest.');
  } else {
    // Printed here rather than only in checkSetup, because this is the moment
    // it matters. TikTok redirects to whatever Partner Center has registered,
    // and a stale deployment id there fails as a Google Drive page reading
    // "Sorry, unable to open the file at present" — which names nothing that
    // would lead you back to this setting.
    try {
      var execUrl = ScriptApp.getService().getUrl();
      if (execUrl) {
        lines.push('BEFORE YOU CLICK: each app\'s Redirect URL in Partner Center');
        lines.push('must be EXACTLY this, or approving lands on a Google Drive error:');
        lines.push('');
        lines.push('   ' + execUrl);
        lines.push('');
      }
    } catch (e) { /* not deployed yet; checkSetup reports that properly */ }

    lines.push(pending + ' shop(s) to go.');
    lines.push('A private window per shop, or the second sign-in reuses the first.');
    lines.push('After approving, TikTok returns you to this script and stores the');
    lines.push('tokens. Then run checkSetup.');
  }

  var out = lines.join('\n');
  Logger.log(out);
  return out;
}

function logAuthorizeUrl_(prefix) {
  var shop = shopById_(prefix);
  var url = ttAuthorizeUrl(prefix);
  Logger.log(
    'Authorise ' + (shop ? shop.brand : prefix) + ' (' + prefix + ')\n\n' + url +
    '\n\nOpen that while signed in to ' + (shop ? shop.handle : 'the right shop') +
    '. A private window avoids clashing with another shop\'s session.'
  );
  return url;
}

/**
 * The OAuth callback. `state` carries which shop began the flow — with three
 * shops, guessing would file one brand's tokens against another.
 */
function ttHandleAuthCallback_(e) {
  var code = e.parameter.code;
  var prefix = String(e.parameter.state || '').toUpperCase();
  if (!shopById_(prefix)) {
    return HtmlService.createHtmlOutput('<p>Unknown shop in callback state.</p>');
  }
  try {
    var c = ttCreds_(prefix);
    var url = TT_AUTH_HOST + '/api/v2/token/get?' + ttQuery_({
      app_key: c.key, app_secret: c.secret, auth_code: code,
      // Not the OAuth-standard 'authorization_code'. TikTok deviates here and
      // the standard spelling fails.
      grant_type: 'authorized_code'
    });
    var body = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText() || '{}');
    if (body.code !== 0) throw new Error(body.message || 'token exchange failed');

    var d = body.data;
    var set = {};
    set[prefix + '_ACCESS_TOKEN'] = d.access_token;
    set[prefix + '_ACCESS_EXPIRES'] = String(d.access_token_expire_in || 0);
    set[prefix + '_REFRESH_TOKEN'] = d.refresh_token;
    set[prefix + '_REFRESH_EXPIRES'] = String(d.refresh_token_expire_in || 0);
    setProps_(set);

    // Ask TikTok which shops the token covers, and keep the cipher. Never
    // hardcode it — the docs say so explicitly.
    var shops = ttAuthorizedShops_(prefix, d.access_token);
    if (shops.code === 0 && shops.data && shops.data.shops && shops.data.shops.length) {
      var s = {};
      s[prefix + '_SHOP_CIPHER'] = shops.data.shops[0].cipher;
      s[prefix + '_SHOP_ID'] = shops.data.shops[0].id;
      setProps_(s);
    }

    logEvent_('system', 'tiktok_authorised', shopById_(prefix).brand, prefix, 'ok');
    return HtmlService.createHtmlOutput(
      '<p>' + shopById_(prefix).brand + ' connected. You can close this window.</p>'
    );
  } catch (err) {
    logEvent_('system', 'tiktok_authorise_failed', prefix, String(err), 'error');
    return HtmlService.createHtmlOutput('<p>Could not connect: ' + err + '</p>');
  }
}

/** Refresh, storing BOTH tokens — TikTok issues a new refresh token too. */
function ttRefresh_(prefix) {
  var c = ttCreds_(prefix);
  var rt = prop_(prefix + '_REFRESH_TOKEN');
  if (!rt) throw new Error(prefix + ' is not authorised yet.');
  var url = TT_AUTH_HOST + '/api/v2/token/refresh?' + ttQuery_({
    app_key: c.key, app_secret: c.secret, refresh_token: rt, grant_type: 'refresh_token'
  });
  var body = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText() || '{}');
  if (body.code !== 0) throw new Error(prefix + ' refresh failed: ' + body.message);
  var d = body.data, set = {};
  set[prefix + '_ACCESS_TOKEN'] = d.access_token;
  set[prefix + '_ACCESS_EXPIRES'] = String(d.access_token_expire_in || 0);
  if (d.refresh_token) {
    set[prefix + '_REFRESH_TOKEN'] = d.refresh_token;
    set[prefix + '_REFRESH_EXPIRES'] = String(d.refresh_token_expire_in || 0);
  }
  setProps_(set);
  return d.access_token;
}

/** A live access token, refreshed inside 24h of expiry. */
function ttToken_(prefix) {
  var tok = prop_(prefix + '_ACCESS_TOKEN');
  var exp = Number(prop_(prefix + '_ACCESS_EXPIRES') || 0);
  if (!tok) throw new Error(shopById_(prefix).brand + ' is not connected to TikTok yet.');
  // Refresh early: discovering an expired token mid-livestream is the
  // expensive case.
  if (exp && exp - Math.floor(Date.now() / 1000) < 86400) return ttRefresh_(prefix);
  return tok;
}

/** Signed call. `payload` is an object (JSON) or a Blob (multipart). */
function ttFetch_(prefix, method, path, extraQuery, payload) {
  var c = ttCreds_(prefix);
  var token = ttToken_(prefix);
  var cipher = prop_(prefix + '_SHOP_CIPHER');

  var query = { app_key: c.key, timestamp: String(Math.floor(Date.now() / 1000)) };
  if (cipher) query.shop_cipher = cipher;
  Object.keys(extraQuery || {}).forEach(function (k) { query[k] = extraQuery[k]; });

  var isBlob = payload && typeof payload.getBytes === 'function';
  // Stringified ONCE, and that exact string is both signed and sent.
  var bodyString = (payload && !isBlob) ? JSON.stringify(payload) : '';
  query.sign = ttSign_(path, query, bodyString, c.secret);

  var opts = { method: method, muteHttpExceptions: true,
               headers: { 'x-tts-access-token': token } };
  if (isBlob) {
    opts.payload = { data: payload };  // multipart; body is not signed
  } else if (bodyString) {
    opts.contentType = 'application/json';
    opts.payload = bodyString;
  }

  var url = TT_HOST + path + '?' + ttQuery_(query);
  var res = UrlFetchApp.fetch(url, opts);
  var parsed = ttParse_(res);

  // Throttling is HTTP 429 or business code 36009002. At three shops we sit
  // near one write per second, so one backoff is worth it.
  if (res.getResponseCode() === 429 || parsed.code === 36009002) {
    Utilities.sleep(5000);
    parsed = ttParse_(UrlFetchApp.fetch(url, opts));
  }
  return parsed;
}

function ttParse_(res) {
  var txt = res.getContentText() || '';
  try { return JSON.parse(txt); }
  catch (e) { return { code: -1, message: 'Non-JSON response: ' + txt.slice(0, 200) }; }
}

/**
 * The shop's own products, newest first.
 *
 * So a stream can be picked from a list rather than by pasting a TikTok
 * listing id. The id is a nineteen-digit number that has to be found in Seller
 * Center and carried across by hand, which on a factory floor is a transcription
 * error waiting to happen — and the app already holds credentials that can just
 * ask.
 *
 * ACTIVATE and its siblings only: a draft or a deleted product is not something
 * a livestream can add variations to, and offering one is offering a dead end.
 */
function ttSearchProducts_(prefix, pageToken) {
  var query = { page_size: '50' };
  if (pageToken) query.page_token = pageToken;

  var r = ttFetch_(prefix, 'post', '/product/202502/products/search', query, {
    status: 'ACTIVATE'
  });
  if (r.code !== 0) throw new Error(r.message || 'Could not read products from TikTok.');

  var data = r.data || {};
  var products = (data.products || []).map(function (p) {
    // A product carries its variation count in its skus array; showing it is
    // what tells someone at a glance whether a listing is nearly full at 100.
    var skus = p.skus || [];
    return {
      listing_id: String(p.id),
      product_name: p.title || '',
      sku_count: skus.length,
      status: p.status || '',
      image: (p.main_images && p.main_images[0] && p.main_images[0].thumb_urls &&
              p.main_images[0].thumb_urls[0]) || ''
    };
  });
  return { products: products, next_page_token: data.next_page_token || '' };
}

function ttAuthorizedShops_(prefix, accessToken) {
  var c = ttCreds_(prefix);
  var path = '/authorization/202309/shops';
  var query = { app_key: c.key, timestamp: String(Math.floor(Date.now() / 1000)) };
  query.sign = ttSign_(path, query, '', c.secret);
  return ttParse_(UrlFetchApp.fetch(TT_HOST + path + '?' + ttQuery_(query), {
    method: 'get', muteHttpExceptions: true,
    headers: { 'x-tts-access-token': accessToken }
  }));
}

/** Check every shop answers. Run by hand after setting up credentials. */
function ttSelfTest() {
  var out = [];
  SHOPS.forEach(function (s) {
    try {
      var r = ttAuthorizedShops_(s.id, ttToken_(s.id));
      out.push(s.brand + ': ' + (r.code === 0 ? 'OK' : 'code ' + r.code + ' ' + r.message));
    } catch (e) {
      out.push(s.brand + ': ' + e.message);
    }
  });
  var report = out.join('\n');
  Logger.log(report);
  return report;
}
