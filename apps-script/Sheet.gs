/**
 * The Sheet as the data store.
 *
 * Tabs are created on demand, so a fresh spreadsheet needs no manual setup —
 * calling setupSheets() once, or just using the app, produces them.
 *
 * Every write goes through LockService. Two people adding SKUs seconds apart
 * during a livestream would otherwise both read the same last row and one
 * would overwrite the other, silently losing a SKU.
 */

function ss_() { return SpreadsheetApp.openById(DATA_SHEET_ID); }

var HEADERS = {};
HEADERS[TAB_LISTINGS] = ['listing_id', 'shop_id', 'brand', 'product_name', 'supplier', 'created_at'];
HEADERS[TAB_SKUS] = [
  'sku_id', 'listing_id', 'shop_id', 'brand', 'identifier', 'title', 'variant',
  'price', 'stock', 'weight_kg', 'dims_cm', 'tiktok_image_uri', 'photo_url',
  'category_id', 'status', 'error', 'tiktok_product_id', 'idempotency_key',
  'created_at', 'pushed_at', 'created_by'
];
HEADERS[TAB_ORDERS] = [
  'order_id', 'shop_id', 'brand', 'status', 'created_at_sgt', 'created_epoch',
  'total', 'currency', 'item_count', 'synced_at'
];
// One row per line item, not per order, because an order can hold items from
// two listings and per-listing figures have to come from the items.
HEADERS[TAB_ORDER_ITEMS] = [
  'order_id', 'shop_id', 'listing_id', 'product_name', 'sku_id', 'seller_sku',
  'variation', 'quantity', 'sale_price', 'currency', 'status',
  'created_at_sgt', 'created_epoch'
];
HEADERS[TAB_LOG] = ['timestamp_sgt', 'actor', 'action', 'shop', 'detail', 'result'];
HEADERS[TAB_USERS] = ['email', 'name', 'role', 'first_seen', 'last_seen', 'approved_by', 'note'];

/** Create any missing tab, with a frozen, bold header row. */
function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    var headers = HEADERS[name] || [];
    if (headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    // Drop the default "Sheet1" once a real tab exists, so the file does not
    // open on an empty sheet.
    var first = ss.getSheetByName('Sheet1');
    if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  return sh;
}

/** Run once to lay the spreadsheet out. Safe to re-run. */
function setupSheets() {
  [TAB_LISTINGS, TAB_SKUS, TAB_ORDERS, TAB_ORDER_ITEMS, TAB_LOG, TAB_USERS]
    .forEach(function (n) { sheet_(n); });
  ensureOwner_();
  logEvent_('system', 'setup_sheets', '', 'Tabs ensured', 'ok');
  return 'Sheets ready: ' + ss_().getUrl();
}

/**
 * Append rows under the script lock, so concurrent writers cannot clobber
 * each other.
 *
 * Goes through withScriptLock_ rather than taking the lock directly, because
 * this is almost always called from inside a write action that already holds
 * it — see Lock.gs for why nesting the lock is a trap.
 */
function appendRows_(name, rows) {
  if (!rows.length) return;
  withScriptLock_(30000, function () {
    var sh = sheet_(name);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    SpreadsheetApp.flush();
  });
}

function readAll_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = HEADERS[name];
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

/**
 * The activity log.
 *
 * Brien asked for a record of what is happening. Every action lands here with
 * who did it, so "who listed this, and when" has an answer — the app being
 * replaced had no notion of a user at all.
 */
function logEvent_(actor, action, shop, detail, result) {
  try {
    appendRows_(TAB_LOG, [[
      Utilities.formatDate(new Date(), 'Asia/Singapore', 'yyyy-MM-dd HH:mm:ss'),
      actor || 'unknown',
      action,
      shop || '',
      String(detail || '').slice(0, 500),
      result || ''
    ]]);
  } catch (e) {
    // Logging must never break the thing it is logging.
    console.error('log failed: ' + e);
  }
}

// ── listings ─────────────────────────────────────────────────────────
function listListings_(shopId) {
  return readAll_(TAB_LISTINGS)
    .filter(function (r) { return String(r.shop_id) === String(shopId); })
    .sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
}

function addListing_(shopId, listingId, actor, productName) {
  var shop = shopById_(shopId);
  if (!shop) throw new Error('Unknown shop: ' + shopId);

  var existing = listListings_(shopId).filter(function (r) {
    return String(r.listing_id) === String(listingId);
  })[0];
  if (existing) return existing;

  // The picker already knows the name, so it sends it. A hand-typed id does
  // not, and a card showing nothing but a nineteen-digit number is no use to
  // someone choosing between streams — so it is looked up. Failing that lookup
  // must not stop the listing being added: an unnamed stream still works, and
  // refusing one because TikTok was slow would be the worse outcome.
  var name = String(productName || '').trim();
  if (!name) {
    try {
      name = ttGetProduct_(shopId, String(listingId)).title || '';
    } catch (e) {
      logEvent_(actor, 'add_listing_name_lookup', shop.brand, String(e), 'warn');
    }
  }

  var row = {
    listing_id: String(listingId),
    shop_id: shopId,
    brand: shop.brand,
    product_name: name,
    supplier: '',
    created_at: new Date().toISOString()
  };
  appendRows_(TAB_LISTINGS, [HEADERS[TAB_LISTINGS].map(function (h) { return row[h]; })]);
  logEvent_(actor, 'add_listing', shop.brand, 'listing ' + listingId, 'ok');
  return row;
}

// ── SKUs ─────────────────────────────────────────────────────────────
function listSkus_(listingId) {
  return readAll_(TAB_SKUS).filter(function (r) {
    return String(r.listing_id) === String(listingId);
  });
}

/** Already-pushed SKUs today, for the daily allowance figure. */
function pushedToday_(shopId) {
  var today = Utilities.formatDate(new Date(), 'Asia/Singapore', 'yyyy-MM-dd');
  return readAll_(TAB_SKUS).filter(function (r) {
    return String(r.shop_id) === String(shopId) &&
      String(r.status) === 'pushed' &&
      String(r.pushed_at).indexOf(today) === 0;
  }).length;
}

/**
 * Replace every row whose key appears in `rows`, and append the rest.
 *
 * Re-syncing a window has to update statuses rather than duplicate orders: an
 * order that is cancelled or refunded after the first sync would otherwise
 * still read as sold in every export made afterwards.
 *
 * Written as one read and one write of the whole tab. A per-row update would
 * be dozens of Sheets calls inside a six-minute execution limit, and this tab
 * is thousands of rows at most.
 */
function replaceByKey_(tabName, keyField, rows) {
  if (!rows || !rows.length) return 0;

  var headers = HEADERS[tabName];
  var incoming = {};
  rows.forEach(function (r) { incoming[String(r[keyField])] = 1; });

  var kept = readAll_(tabName).filter(function (r) {
    return !incoming[String(r[keyField])];
  });

  var all = kept.concat(rows).map(function (r) {
    return headers.map(function (h) { return r[h] === undefined ? '' : r[h]; });
  });

  var sheet = sheet_(tabName);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  }
  if (all.length) {
    sheet.getRange(2, 1, all.length, headers.length).setValues(all);
  }
  SpreadsheetApp.flush();
  return rows.length;
}

/** A prior push with this idempotency key, so a retry cannot duplicate. */
function findByIdempotencyKey_(key) {
  return readAll_(TAB_SKUS).filter(function (r) {
    return String(r.idempotency_key) === String(key) && String(r.status) === 'pushed';
  })[0] || null;
}

function recordSku_(sku) {
  var row = HEADERS[TAB_SKUS].map(function (h) { return sku[h] === undefined ? '' : sku[h]; });
  appendRows_(TAB_SKUS, [row]);
}
