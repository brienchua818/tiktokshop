/**
 * Orders: pull them down from TikTok, and answer the question a purchase order
 * actually asks.
 *
 * The unit of work here is a LISTING, not a factory. One listing per factory
 * per stream is the convention rather than a rule the data enforces, so
 * grouping by listing is both what Brien asked for and the only grouping
 * TikTok's data supports directly — a line item knows its product id, and
 * nothing in an order knows which factory it came from.
 *
 * > [!important] An order can span listings
 * > A buyer can put items from two listings in one basket. So "orders for a
 * > listing" means "line items whose product is that listing", and per-listing
 * > revenue sums line items rather than order totals. Summing order totals per
 * > listing double-counts every mixed basket, which on a good stream is a lot
 * > of them.
 *
 * Times are Asia/Singapore throughout, converted to epoch seconds at the API
 * boundary because that is the only thing TikTok accepts.
 */

/** TikTok returns at most this many orders per page. */
var ORDER_PAGE_SIZE = 50;

/**
 * One page of orders created within a window.
 *
 * `create_time_ge` / `create_time_lt` — inclusive start, exclusive end. Half
 * open on purpose: two adjacent windows then partition the day rather than
 * both claiming an order created exactly on the boundary.
 */
function ttSearchOrders_(prefix, fromEpoch, toEpoch, pageToken) {
  var query = { page_size: String(ORDER_PAGE_SIZE) };
  if (pageToken) query.page_token = pageToken;

  var r = ttFetch_(prefix, 'post', '/order/202309/orders/search', query, {
    create_time_ge: Number(fromEpoch),
    create_time_lt: Number(toEpoch)
  });
  if (r.code !== 0) throw fail_('TS-ORD-01', 'Could not read orders: ' + ttReason_(r));

  var data = r.data || {};
  return { orders: data.orders || [], nextPageToken: data.next_page_token || '' };
}

/**
 * Every order in a window, following pagination.
 *
 * Capped. A runaway loop here would burn the shop's rate limit and stall every
 * other call the app makes, so it stops and says so rather than continuing
 * silently on partial data — a purchase order built from half the orders is
 * worse than no purchase order.
 */
function ttAllOrders_(prefix, fromEpoch, toEpoch) {
  var all = [];
  var token = '';
  var pages = 0;
  var MAX_PAGES = 60;

  do {
    var page = ttSearchOrders_(prefix, fromEpoch, toEpoch, token);
    all = all.concat(page.orders);
    token = page.nextPageToken;
    pages++;
    if (pages >= MAX_PAGES && token) {
      throw fail_('TS-ORD-02', 
        'That range has more than ' + MAX_PAGES * ORDER_PAGE_SIZE + ' orders. ' +
        'Narrow the dates and sync again.'
      );
    }
  } while (token);

  return all;
}

/** Epoch seconds for an ISO date and HH:mm, read as Singapore local time. */
function sgtEpoch_(isoDate, hhmm) {
  var time = String(hhmm || '00:00');
  // +08:00 written explicitly rather than relying on the script's timezone,
  // which is a project setting anyone could change.
  var d = new Date(isoDate + 'T' + time + ':00+08:00');
  if (isNaN(d.getTime())) throw fail_('TS-ORD-03', 'Not a date: ' + isoDate + ' ' + time);
  return Math.floor(d.getTime() / 1000);
}

/**
 * The end of a window, as an exclusive bound.
 *
 * Someone picking 18:00 to 23:59 means the whole evening, including the
 * fifty-nine seconds after 23:59:00. Treating the chosen minute as the
 * exclusive bound silently dropped them from every window — invisible in
 * testing, and an order in that minute simply would not appear.
 *
 * So the bound is the END of the chosen minute. Still exclusive, so two
 * adjacent windows partition the day instead of both claiming an order.
 */
function sgtEndEpoch_(isoDate, hhmm) {
  return sgtEpoch_(isoDate, hhmm || '23:59') + 60;
}

/**
 * Pull a window of orders into the Sheet.
 *
 * Rows are replaced rather than appended, keyed by order id, so re-syncing the
 * same window updates statuses instead of duplicating orders. A status changes
 * after the fact — cancelled, refunded — and a purchase order built from the
 * first sync would otherwise still show it as sold.
 */
function syncOrders_(shopId, fromDate, fromTime, toDate, toTime, actor) {
  var shop = shopById_(shopId);
  if (!shop) throw fail_('TS-ORD-04', 'Unknown shop: ' + shopId);

  var fromEpoch = sgtEpoch_(fromDate, fromTime || '00:00');
  var toEpoch = sgtEndEpoch_(toDate, toTime);
  if (toEpoch <= fromEpoch) throw fail_('TS-ORD-05', 'The end of the range is before its start.');

  var orders = ttAllOrders_(shopId, fromEpoch, toEpoch);

  // Prove the window was actually applied.
  //
  // create_time_ge / create_time_lt are the documented filter names, but the
  // documentation could not be read from here and an ignored filter does not
  // error — it returns the most recent orders, which would then be exported as
  // though they belonged to the requested window. A factory would be paid for
  // someone else's stream. Cheap to check, and impossible to notice otherwise.
  var strays = orders.filter(function (o) {
    var t = Number(o.create_time || 0);
    return t && (t < fromEpoch || t >= toEpoch);
  });
  if (strays.length) {
    throw fail_('TS-ORD-06', 
      'TikTok returned ' + strays.length + ' order(s) outside the requested window ' +
      '(for example ' + sgtStampFromEpoch_(strays[0].create_time) + '). ' +
      'The date filter is not being applied, so nothing was saved. Tell Brien.'
    );
  }

  var orderRows = [];
  var itemRows = [];

  orders.forEach(function (o) {
    var created = Number(o.create_time || 0);
    orderRows.push({
      order_id: String(o.id || ''),
      shop_id: shopId,
      brand: shop.brand,
      status: String(o.status || ''),
      created_at_sgt: created ? sgtStampFromEpoch_(created) : '',
      created_epoch: created,
      total: String((o.payment && o.payment.total_amount) || ''),
      currency: String((o.payment && o.payment.currency) || 'SGD'),
      item_count: (o.line_items || []).length,
      synced_at: new Date().toISOString()
    });

    // ONE LINE ITEM IS ONE UNIT.
    //
    // There is no quantity field on a line item — confirmed against a real
    // order, whose keys are: buyer_service_fee, currency, display_status,
    // gift_retail_price, id, is_gift, original_price, package_id,
    // package_status, platform_discount, product_id, product_name, rts_time,
    // sale_price, seller_discount, seller_sku, sku_id, sku_image, sku_name,
    // sku_type, tracking_number. Buying three of a SKU produces three line
    // items, each with its own id, package and tracking, because TikTok tracks
    // fulfilment per unit.
    //
    // So units are counted, not summed, and sale_price is the price of one
    // unit. Recorded as quantity 1 per row to keep the arithmetic downstream
    // uniform, and stated here because reading `Number(li.quantity || 1)`
    // would look like a defensive default rather than the actual model.
    (o.line_items || []).forEach(function (li) {
      itemRows.push({
        order_id: String(o.id || ''),
        shop_id: shopId,
        listing_id: String(li.product_id || ''),
        product_name: String(li.product_name || ''),
        sku_id: String(li.sku_id || ''),
        // Empty on products not created by this app; the identifier is only
        // there because we put it there. Grouping falls back to sku_id.
        seller_sku: String(li.seller_sku || ''),
        variation: String(li.sku_name || ''),
        sku_image: String(li.sku_image || ''),
        quantity: 1,
        sale_price: String(li.sale_price || ''),
        currency: String(li.currency || 'SGD'),
        status: String(li.display_status || o.status || ''),
        created_at_sgt: created ? sgtStampFromEpoch_(created) : '',
        created_epoch: created
      });
    });
  });

  // Blank seller_sku is filled before the rows are written, so every reader
  // — the app's order detail, the export — sees the same identifier.
  var filled = resolveSellerSkus_(shopId, itemRows);
  var filledNote = describeResolution_(filled);
  if (filled.unresolved) {
    warn_('TS-ORD-08', filled.unresolved + ' order line(s) have no identifier from any source ' +
      '(' + filledNote + ')', shopId);
  }

  /**
   * The lock goes here, around the write, and not around the fetch above.
   *
   * Fetching a busy window is dozens of TikTok calls and takes minutes. Held
   * across that, a SKU push during a broadcast would queue behind an order
   * sync — the one thing in this app that must never wait. The two tabs are
   * rewritten together so a reader never sees orders without their items.
   */
  withScriptLock_(30000, function () {
    replaceByKey_(TAB_ORDERS, 'order_id', orderRows);
    replaceByKey_(TAB_ORDER_ITEMS, 'order_id', itemRows);
  });

  logEvent_(actor, 'sync_orders', shop.brand,
    orders.length + ' orders ' + fromDate + ' to ' + toDate +
      (filledNote ? ' · seller_sku filled: ' + filledNote : ''), 'ok');

  return {
    orders: orders.length,
    items: itemRows.length,
    from: fromDate + ' ' + (fromTime || '00:00'),
    to: toDate + ' ' + (toTime || '23:59')
  };
}

/** Singapore-local display stamp from epoch seconds. */
function sgtStampFromEpoch_(epochSeconds) {
  return Utilities.formatDate(
    new Date(Number(epochSeconds) * 1000), 'Asia/Singapore', 'yyyy-MM-dd HH:mm'
  );
}

/** Statuses that mean the money did not stick, so they must not count as sold. */
var UNSOLD_STATUSES = {
  CANCELLED: 1, CANCEL: 1, UNPAID: 1
};

/**
 * Per-listing totals inside a window.
 *
 * This is the answer to "what did this factory sell on this stream". The
 * window is applied to every line item, so a listing used across two streams
 * reports only the one being asked about — which is the whole point of having
 * a date filter rather than a listing total.
 */
function orderSummary_(shopId, fromDate, fromTime, toDate, toTime) {
  var fromEpoch = sgtEpoch_(fromDate, fromTime || '00:00');
  var toEpoch = sgtEndEpoch_(toDate, toTime);

  var items = readAll_(TAB_ORDER_ITEMS).filter(function (r) {
    if (shopId && String(r.shop_id) !== String(shopId)) return false;
    var t = Number(r.created_epoch || 0);
    return t >= fromEpoch && t < toEpoch;
  });

  var out = summariseItems_(items);
  out.from = fromDate + ' ' + (fromTime || '00:00');
  out.to = toDate + ' ' + (toTime || '23:59');
  return out;
}

/**
 * Group line items into per-listing totals.
 *
 * Separated from the Sheet read so it can be tested: these numbers become a
 * purchase order sent to a factory, and an arithmetic mistake here is money.
 */
function summariseItems_(items) {
  var byListing = {};
  items.forEach(function (r) {
    var key = String(r.listing_id || 'unknown');
    if (!byListing[key]) {
      byListing[key] = {
        listing_id: key,
        product_name: String(r.product_name || ''),
        orders: {},
        units: 0,
        revenue: 0,
        unsold_units: 0,
        latest_epoch: 0
      };
    }
    var g = byListing[key];
    g.orders[String(r.order_id)] = 1;

    var qty = Number(r.quantity || 0);
    var line = Number(r.sale_price || 0) * qty;
    var status = String(r.status || '').toUpperCase();

    // Cancelled and unpaid lines are counted separately rather than dropped.
    // A factory asking "why is this less than we called out" deserves the
    // number, and dropping them silently makes the export unexplainable.
    if (UNSOLD_STATUSES[status]) {
      g.unsold_units += qty;
    } else {
      g.units += qty;
      g.revenue += line;
    }
    if (Number(r.created_epoch || 0) > g.latest_epoch) {
      g.latest_epoch = Number(r.created_epoch || 0);
    }
    if (!g.product_name && r.product_name) g.product_name = String(r.product_name);
  });

  var listings = Object.keys(byListing).map(function (k) {
    var g = byListing[k];
    return {
      listing_id: g.listing_id,
      product_name: g.product_name,
      order_count: Object.keys(g.orders).length,
      units: g.units,
      unsold_units: g.unsold_units,
      revenue: Math.round(g.revenue * 100) / 100,
      latest_order_sgt: g.latest_epoch ? sgtStampFromEpoch_(g.latest_epoch) : ''
    };
  }).sort(function (a, b) { return b.revenue - a.revenue; });

  var orderIds = {};
  items.forEach(function (r) { orderIds[String(r.order_id)] = 1; });

  return {
    listings: listings,
    // Distinct orders, not the sum of the per-listing counts: a basket holding
    // two listings is ONE order, and summing would report it as two.
    total_orders: Object.keys(orderIds).length,
    // Summed from line items, so a basket holding two listings contributes to
    // both without being counted twice here.
    total_units: listings.reduce(function (n, l) { return n + l.units; }, 0),
    total_revenue: Math.round(
      listings.reduce(function (n, l) { return n + l.revenue; }, 0) * 100
    ) / 100
  };
}

/**
 * Print one raw order, so the field names above can be checked.
 *
 * Written from memory of the Orders API, because the reference site is a
 * JavaScript application a script cannot read. Every field name here is a
 * guess until this has been run once, and a wrong one does not error — it
 * quietly reports zero units, which is the worst possible failure for a
 * document a factory gets paid against.
 *
 * Read-only. Prints today's first order and changes nothing.
 */
function inspectOrders() {
  var shops = SHOPS.filter(function (s) { return Boolean(prop_(s.id + '_ACCESS_TOKEN')); });
  if (!shops.length) {
    Logger.log('No shop is authorised yet.');
    return;
  }
  var shopId = shops[0].id;
  var to = new Date();
  var from = new Date(to.getTime() - 7 * 86400000);

  Logger.log('Shop: ' + shopId + '  (last 7 days)');
  var page = ttSearchOrders_(
    shopId, Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000), ''
  );
  Logger.log('orders returned: ' + page.orders.length);

  var o = page.orders[0];
  if (!o) {
    Logger.log('No orders in the last 7 days — nothing to inspect.');
    return;
  }
  Logger.log('--- order keys ---');
  Logger.log(Object.keys(o).join(', '));
  Logger.log('id          = ' + JSON.stringify(o.id));
  Logger.log('status      = ' + JSON.stringify(o.status));
  Logger.log('create_time = ' + JSON.stringify(o.create_time));
  Logger.log('payment     = ' + JSON.stringify(o.payment));

  var li = (o.line_items || [])[0];
  if (li) {
    Logger.log('--- line item keys ---');
    Logger.log(Object.keys(li).join(', '));
    Logger.log('product_id  = ' + JSON.stringify(li.product_id));
    Logger.log('seller_sku  = ' + JSON.stringify(li.seller_sku));
    Logger.log('sku_name    = ' + JSON.stringify(li.sku_name));
    Logger.log('sale_price  = ' + JSON.stringify(li.sale_price));
    Logger.log('quantity    = ' + JSON.stringify(li.quantity));
  } else {
    Logger.log('That order has no line_items array — the field name is wrong.');
  }
  return 'Logged. Paste the log to Brien.';
}

/**
 * The identifier at the front of a variation name, or ''.
 *
 * Both apps that have listed for HOUZE write the variation as the identifier
 * followed by the name: "B6 Silver Magnetic Charging Stand" (this app) and
 * "F21-Segretto cast iron Mint" (the old one). The identifier scheme is one
 * to three letters and a running number, so that — and only that — is what is
 * recognised. "Floral Blue", "3 Tier, White" and "Default" yield '' rather than
 * a guess: an invented identifier on a purchase order is worse than a blank.
 */
function identifierFromVariation_(name) {
  var m = String(name || '').match(/^\s*([A-Za-z]{1,3}\d{1,6})(?=[\s\-–—:_.,/]|$)/);
  return m ? m[1].toUpperCase() : '';
}

/**
 * Fill in seller_sku where TikTok left it blank on an order line.
 *
 * TikTok returns seller_sku inconsistently on line items: on 4 Sep the same
 * variation (F20) came back with it on some orders and without on others, and
 * F21 never had it. The purchase order needs the identifier on every row, so
 * it is recovered from the best source available, in this order:
 *
 *   1. another line item with the same TikTok sku id that does carry it;
 *   2. this app's own SKU rows, by TikTok sku id;
 *   3. TikTok's product read, which lists seller_sku per sku id — one call
 *      per listing, and only for listings that still have a blank;
 *   4. the identifier at the front of the variation name.
 *
 * Mutates the items. Returns counts per source for the log. Never throws: a
 * TikTok read that fails is a warn, and the name pattern still applies.
 */
function resolveSellerSkus_(shopId, items) {
  var counts = { sibling: 0, sheet: 0, tiktok: 0, name: 0, unresolved: 0 };
  var known = {};
  items.forEach(function (i) {
    if (i.sku_id && i.seller_sku) known[String(i.sku_id)] = { sku: String(i.seller_sku), src: 'sibling' };
  });
  var blank = items.filter(function (i) { return !String(i.seller_sku || ''); });
  if (!blank.length) return counts;

  readAll_(TAB_SKUS).forEach(function (r) {
    var id = String(r.tiktok_sku_id || '');
    if (id && r.identifier && !known[id]) known[id] = { sku: String(r.identifier), src: 'sheet' };
  });

  var need = {};
  blank.forEach(function (i) {
    if (i.sku_id && !known[String(i.sku_id)] && i.listing_id) need[String(i.listing_id)] = 1;
  });
  Object.keys(need).forEach(function (listingId) {
    try {
      ttGetProduct_(shopId, listingId).skus.forEach(function (sk) {
        if (sk.id && sk.sellerSku && !known[String(sk.id)]) {
          known[String(sk.id)] = { sku: String(sk.sellerSku), src: 'tiktok' };
        }
      });
    } catch (e) {
      warn_('TS-ORD-07', 'seller_sku lookup: could not read listing ' + listingId + ': ' +
        (e && e.message ? e.message : e) + ' [' + codeOf_(e) + ']', shopId);
    }
  });

  blank.forEach(function (i) {
    var hit = known[String(i.sku_id || '')];
    if (hit) { i.seller_sku = hit.sku; counts[hit.src]++; return; }
    var fromName = identifierFromVariation_(i.variation);
    if (fromName) { i.seller_sku = fromName; counts.name++; return; }
    counts.unresolved++;
  });
  return counts;
}

/** "3 from TikTok, 12 from names, 1 unresolved" — or '' when nothing was blank. */
function describeResolution_(c) {
  var parts = [];
  if (c.sibling) parts.push(c.sibling + ' from sibling lines');
  if (c.sheet) parts.push(c.sheet + ' from our rows');
  if (c.tiktok) parts.push(c.tiktok + ' from TikTok');
  if (c.name) parts.push(c.name + ' from names');
  if (c.unresolved) parts.push(c.unresolved + ' unresolved');
  return parts.join(', ');
}

/**
 * The line items behind one listing's total, inside the same window.
 *
 * Grouped by variation, because that is what a factory is being asked to
 * supply — a list of two hundred order rows is not a purchase order, and
 * "A7 × 14" is.
 */
/**
 * Units sold per variation of one listing, from the order line items.
 *
 * Extracted so the live listing screen can show the same number the purchase
 * order does. It was inline in `listingOrders_`, which meant the export had a
 * trustworthy sold count and the screen somebody watches during a stream had
 * an estimate derived from stock levels — an estimate that goes DOWN when
 * stock is topped up. See the vault note on variation stock.
 *
 * One line item is one unit: a TikTok order line carries no quantity field, so
 * three of a SKU arrive as three lines, and the sync records `quantity: 1` per
 * row for that reason.
 *
 * `toEpoch` may be null for "everything ever", which is what the listing
 * screen wants: a variation's lifetime sales, not this window's.
 */
function variationSales_(listingId, fromEpoch, toEpoch) {
  var items = readAll_(TAB_ORDER_ITEMS).filter(function (r) {
    if (String(r.listing_id) !== String(listingId)) return false;
    if (fromEpoch === null && toEpoch === null) return true;
    var t = Number(r.created_epoch || 0);
    if (fromEpoch !== null && t < fromEpoch) return false;
    if (toEpoch !== null && t >= toEpoch) return false;
    return true;
  });

  // Rows synced before seller_sku was being filled at sync time get the same
  // treatment here, so an old sync does not need repeating to read correctly.
  if (items.length) {
    var shopId = String(items[0].shop_id || '');
    if (shopId) resolveSellerSkus_(shopId, items);
  }

  return { byVariation: groupVariationSales_(items), items: items };
}

/**
 * Line items to per-variation totals. Pure, so it can be asserted.
 *
 * The one number in this app that a factory is paid against, so it is a
 * function with tests rather than a loop inside a Sheet read. It was the
 * latter, which is part of why the listing screen ended up with a different
 * and wrong sold figure: the correct arithmetic was not reachable from
 * anywhere else.
 */
function groupVariationSales_(items) {
  var byVariation = {};
  items.forEach(function (r) {
    // sku_id first: seller_sku is empty on anything this app did not list,
    // and two variations can share a sku_name. Only the id is guaranteed
    // unique, and getting this wrong merges two variations into one row of a
    // purchase order.
    var key = String(r.sku_id || r.seller_sku || r.variation || '?');
    if (!byVariation[key]) {
      byVariation[key] = {
        sku_id: String(r.sku_id || ''),
        seller_sku: String(r.seller_sku || ''),
        variation: String(r.variation || ''),
        sku_image: String(r.sku_image || ''),
        units: 0,
        unsold_units: 0,
        revenue: 0,
        price: String(r.sale_price || '')
      };
    }
    var g = byVariation[key];
    if (!g.sku_image && r.sku_image) g.sku_image = String(r.sku_image);
    if (!g.seller_sku && r.seller_sku) g.seller_sku = String(r.seller_sku);
    var qty = Number(r.quantity || 0);
    if (UNSOLD_STATUSES[String(r.status || '').toUpperCase()]) {
      g.unsold_units += qty;
    } else {
      g.units += qty;
      g.revenue += Number(r.sale_price || 0) * qty;
    }
  });
  return byVariation;
}

/** The compact per-variation index the listing screen matches against. */
function salesIndex_(byVariation) {
  var compact = {};
  Object.keys(byVariation).forEach(function (k) {
    var g = byVariation[k];
    // Indexed by both keys the listing screen can match on. A variation this
    // app listed has a seller_sku; one added in Seller Center has only an id.
    if (g.sku_id) compact['id:' + g.sku_id] = { units: g.units, unsold: g.unsold_units };
    if (g.seller_sku) compact['sku:' + g.seller_sku] = { units: g.units, unsold: g.unsold_units };
  });
  return compact;
}

/**
 * Lifetime sold and cancelled units per variation, cheap enough for the queue.
 *
 * `variationSales_` reads the WHOLE Order Items tab and filters in memory, so
 * it costs what the entire order history costs. That is already why the orders
 * summary needed its deadline raised from 25 to 60 seconds. The listing screen
 * refreshes repeatedly during a broadcast and has a 40 second budget, so it
 * cannot pay that price on every tap.
 *
 * Cached for a minute, keyed per listing. During a stream a sold count that is
 * up to sixty seconds old is indistinguishable from a live one: orders arrive
 * minutes after a SKU is called, and nothing anybody does on this screen
 * depends on the difference. A stock write, when that ships, will clear the
 * key rather than wait for it to lapse.
 *
 * Only the two counts are cached, not the rows, so the payload stays far
 * inside the 100 KB per-key limit even for a 200-SKU stream.
 */
var SALES_CACHE_TTL_S = 60;

function variationSalesCached_(listingId) {
  var key = 'sales:' + String(listingId);
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) {
    // A cache that is unavailable must not stop the screen loading; it only
    // means paying full price for this read.
    warn_('TS-ORD-20', 'Sales cache unavailable: ' + e);
  }

  var compact = salesIndex_(variationSales_(listingId, null, null).byVariation);

  try {
    if (cache) cache.put(key, JSON.stringify(compact), SALES_CACHE_TTL_S);
  } catch (e) {
    warn_('TS-ORD-21', 'Could not cache sales for ' + listingId + ': ' + e);
  }
  return compact;
}

/** Sold and cancelled for one variation, by TikTok id then by identifier. */
function salesFor_(sales, tiktokSkuId, identifier) {
  if (!sales) return null;
  return sales['id:' + String(tiktokSkuId || '')] ||
         sales['sku:' + String(identifier || '')] ||
         null;
}

function listingOrders_(listingId, fromDate, fromTime, toDate, toTime) {
  var fromEpoch = sgtEpoch_(fromDate, fromTime || '00:00');
  var toEpoch = sgtEndEpoch_(toDate, toTime);

  var grouped = variationSales_(listingId, fromEpoch, toEpoch);
  var items = grouped.items;
  var byVariation = grouped.byVariation;
  var rows = Object.keys(byVariation).map(function (k) {
    var g = byVariation[k];
    g.revenue = Math.round(g.revenue * 100) / 100;
    return g;
  }).sort(function (a, b) {
    // Identifier order, so the export reads in the order the stream ran.
    return String(a.seller_sku).localeCompare(String(b.seller_sku), 'en', { numeric: true });
  });

  return {
    listing_id: String(listingId),
    from: fromDate + ' ' + (fromTime || '00:00'),
    to: toDate + ' ' + (toTime || '23:59'),
    variations: rows,
    order_count: Object.keys(items.reduce(function (m, r) {
      m[String(r.order_id)] = 1; return m;
    }, {})).length,
    total_units: rows.reduce(function (n, r) { return n + r.units; }, 0),
    total_revenue: Math.round(rows.reduce(function (n, r) { return n + r.revenue; }, 0) * 100) / 100
  };
}
