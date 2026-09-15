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
function ttSearchOrders_(prefix, fromEpoch, toEpoch, pageToken, byUpdateTime) {
  var query = { page_size: String(ORDER_PAGE_SIZE) };
  if (pageToken) query.page_token = pageToken;

  /**
   * By CREATION time, or by when the order last CHANGED.
   *
   * Creation time answers "what happened during the stream", which is what an
   * export needs. It is the wrong question for a sync that runs every two
   * minutes: an order created an hour ago and cancelled a moment ago has not
   * changed its creation time, so a creation-time window never sees the
   * cancellation — and a window wide enough to catch it re-fetches every order
   * in it, over and over.
   *
   * Update time asks only what has changed since we last looked, which during
   * a quiet minute is nothing at all.
   *
   * NOT assumed to work. The parameter could not be confirmed against TikTok's
   * documentation from here, and an ignored filter does not error — it returns
   * the most recent orders, which would look like a working sync while
   * silently missing everything. The caller proves it was applied.
   */
  var body = byUpdateTime
    ? { update_time_ge: Number(fromEpoch), update_time_lt: Number(toEpoch) }
    : { create_time_ge: Number(fromEpoch), create_time_lt: Number(toEpoch) };

  var r = ttFetch_(prefix, 'post', '/order/202309/orders/search', query, body);
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
function ttAllOrders_(prefix, fromEpoch, toEpoch, byUpdateTime) {
  var all = [];
  var token = '';
  var pages = 0;
  var MAX_PAGES = 60;

  do {
    var page = ttSearchOrders_(prefix, fromEpoch, toEpoch, token, byUpdateTime);
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

  var written = writeOrders_(shopId, orders, actor);
  var filledNote = written.filledNote;

  logEvent_(actor, 'sync_orders', shop.brand,
    orders.length + ' orders ' + fromDate + ' to ' + toDate +
      (filledNote ? ' · seller_sku filled: ' + filledNote : ''), 'ok');

  return {
    orders: orders.length,
    items: written.items,
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

/**
 * What a line item's status means for the money. The FULL table, not a
 * denylist.
 *
 * It was a denylist — CANCELLED, CANCEL, UNPAID were not sold, and everything
 * else, including every status nobody had thought of, was sold. On the one
 * number a factory is paid against, that default is the wrong way round: a
 * status TikTok adds tomorrow, or one this code has never seen, would silently
 * be counted as money kept.
 *
 * The nine order-level statuses below are TikTok's complete set, verified 15
 * Sep against three of their own sources that agree: the Get Order List enum
 * (doc 650aa8094a0bb702c06df242), Get Order Detail (6894134ba28e5204961601a5),
 * and the Order API overview (650b1b4bbace3e02b76d1011), whose embedded state
 * diagram carries TikTok's internal codes — UNPAID[100], ON_HOLD[105],
 * AWAITING_SHIPMENT[111], AWAITING_COLLECTION[112], PARTIALLY_SHIPPING[114],
 * IN_TRANSIT[121], DELIVERED[122], COMPLETED[130], CANCELLED[140]. Nine nodes,
 * no others. The `docv2` pages are a JavaScript shell with no text in them;
 * they were read through the documentation site's own JSON API at
 * /api/v1/document/detail?document_id=<id>&workspace_id=3.
 *
 * Four outcomes, because three were not enough to be honest:
 *
 *   sold    the seller kept the money
 *   unsold  the money did not stick, and TikTok returns the units to stock
 *   held    PAID, but the buyer may still cancel unilaterally. Committed
 *           stock, not yet revenue — counting it as either is a lie.
 *   unknown a status this table does not list. Never counted as sold, always
 *           logged, so an unrecognised value is a question rather than an
 *           overpayment.
 */
var LINE_STATUS_MEANING = {
  UNPAID: 'unsold',
  CANCELLED: 'unsold',
  CANCEL: 'unsold',
  ON_HOLD: 'held',
  AWAITING_SHIPMENT: 'sold',
  AWAITING_COLLECTION: 'sold',
  PARTIALLY_SHIPPING: 'sold',
  IN_TRANSIT: 'sold',
  DELIVERED: 'sold',
  COMPLETED: 'sold',
  // Seen on real line items on 15 Sep, and not in TikTok's published enum.
  TO_SHIP: 'sold'
};

/**
 * What a status means, with the unknown case named rather than assumed.
 *
 * A blank status is `unknown`, not sold. TikTok returning nothing for a field
 * is not evidence that the money stuck.
 */
function lineStatusMeaning_(status) {
  var key = String(status || '').trim().toUpperCase();
  if (!key) return 'unknown';
  return LINE_STATUS_MEANING[key] || 'unknown';
}

/**
 * Kept because the export and the old tests name it, and because "is this one
 * of the statuses that definitely did not sell" is still a real question.
 */
var UNSOLD_STATUSES = {
  CANCELLED: 1, CANCEL: 1, UNPAID: 1
};

/**
 * NOT A COMPLETE ANSWER, and the code says so where it matters.
 *
 * TikTok's own overview states three times that a FULLY REFUNDED order lands
 * in COMPLETED — transitions 7, 14 and 15, verbatim: "Once the order amount is
 * a full refund to the buyer, the order status will be updated to COMPLETED."
 * The line-item `display_status` enum has no REFUNDED, RETURNED or
 * PARTIALLY_REFUNDED value at all; a fully refunded line still reads DELIVERED.
 *
 * So no order status distinguishes a refund from a sale. Refunds live in a
 * separate object, /return_refund/202309/returns/search, and until this app
 * reads it every "sold" figure here is "sold, before refunds".
 */
var SOLD_IS_BEFORE_REFUNDS = true;

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
    // Undated lines belong to every window rather than none. See
    // listingOrders_ for why: the alternative drops units from the export
    // while the listing screen still counts them.
    if (!t) return true;
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
function resolveSellerSkus_(shopId, items, known_) {
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

  /**
   * Products the caller has already read, so this does not read them again.
   *
   * `listingState` reads the product to build the screen, then reached this
   * through the sold count and read the SAME product a second time over the
   * network — on a screen that refreshes throughout a broadcast. Passing the
   * snapshot in removes one TikTok call per refresh, and TikTok calls are the
   * slow part: signing, the round trip, and the shop's rate limit.
   */
  var already = known_ || {};
  Object.keys(already).forEach(function (listingId) {
    (already[listingId].skus || []).forEach(function (sk) {
      if (sk.id && sk.sellerSku && !known[String(sk.id)]) {
        known[String(sk.id)] = { sku: String(sk.sellerSku), src: 'sheet' };
      }
    });
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
function variationSales_(listingId, fromEpoch, toEpoch, known_) {
  var undated = 0;
  var items = readAll_(TAB_ORDER_ITEMS).filter(function (r) {
    if (String(r.listing_id) !== String(listingId)) return false;
    if (fromEpoch === null && toEpoch === null) return true;
    var t = Number(r.created_epoch || 0);
    /**
     * A line with no creation time belongs to every window, not to none.
     *
     * It used to fall out of both bounds, so the export dropped it — while the
     * listing screen, which passes no window at all, still counted it. The two
     * screens disagreed about the same units and the export was the one that
     * lost them, which is the direction that shorts a factory. Including it and
     * saying so is the honest reading: we know the sale happened, we do not
     * know exactly when.
     */
    if (!t) { undated++; return true; }
    if (fromEpoch !== null && t < fromEpoch) return false;
    if (toEpoch !== null && t >= toEpoch) return false;
    return true;
  });
  if (undated) {
    warn_('TS-ORD-27', undated + ' order line(s) on ' + listingId + ' carry no creation time, ' +
      'so they are counted in every window rather than none.');
  }

  // Rows synced before seller_sku was being filled at sync time get the same
  // treatment here, so an old sync does not need repeating to read correctly.
  if (items.length) {
    var shopId = String(items[0].shop_id || '');
    if (shopId) resolveSellerSkus_(shopId, items, known_);
  }

  /**
   * Refunds, matched to these lines before anything is counted.
   *
   * Read from its own tab rather than from the order, because the order cannot
   * say. Small: a returns tab holds one row per returned line item, not per
   * order.
   */
  var refunds = refundIndex_(readAll_(TAB_RETURNS).filter(function (r) {
    return !items.length || String(r.shop_id) === String(items[0].shop_id || '');
  }));

  var byVariation = groupVariationSales_(items, refunds);

  /**
   * An unrecognised status is a question, not a silent zero.
   *
   * The old denylist counted anything it did not recognise as SOLD, so a value
   * TikTok adds tomorrow would quietly enter a factory's payout. It is now
   * counted apart and named here, so the fix is a line in
   * LINE_STATUS_MEANING rather than an investigation.
   */
  var unknown = {};
  Object.keys(byVariation).forEach(function (k) {
    Object.keys(byVariation[k].unknown_statuses).forEach(function (st) { unknown[st] = true; });
  });
  var names = Object.keys(unknown);
  if (names.length) {
    warn_('TS-ORD-26', 'Order line statuses this app does not recognise on ' + listingId +
      ': ' + names.join(', ') + '. They are NOT counted as sold. Add them to ' +
      'LINE_STATUS_MEANING once their meaning is confirmed.');
  }

  return { byVariation: byVariation, items: items };
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
function groupVariationSales_(items, refunds) {
  var refunded = refunds || {};
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
        /** Paid but still cancellable by the buyer alone. ON_HOLD. */
        held_units: 0,
        /** A status this app does not recognise. Never counted as sold. */
        unknown_units: 0,
        /** The buyer has the money back. Was counted as sold until 15 Sep. */
        refunded_units: 0,
        /** A return or refund request is open and undecided. */
        at_risk_units: 0,
        unknown_statuses: {},
        revenue: 0,
        price: String(r.sale_price || '')
      };
    }
    var g = byVariation[key];
    if (!g.sku_image && r.sku_image) g.sku_image = String(r.sku_image);
    if (!g.seller_sku && r.seller_sku) g.seller_sku = String(r.seller_sku);

    /**
     * One line item is one unit, so a blank quantity is one, not none.
     *
     * This read `Number(r.quantity || 0)`, which turned a row written before
     * the column existed — padded with '' when the headers were migrated —
     * into zero. Such a row then contributed nothing to sold, nothing to
     * cancelled and nothing to revenue: it disappeared from the purchase order
     * entirely rather than appearing in either column. Vanishing is the one
     * outcome a number a factory is paid on must never have.
     */
    var qty = Number(r.quantity);
    if (!isFinite(qty) || qty <= 0) qty = 1;

    var meaning = lineStatusMeaning_(r.status);

    /**
     * A refund overrides the order status, because the order status cannot see
     * it.
     *
     * A refunded line still reads DELIVERED or COMPLETED — TikTok has no
     * status for "refunded" at all. So the refund is looked up separately and
     * applied here, and a unit the buyer has been given the money back for
     * stops counting as sold however healthy the order looks.
     *
     * An open request is neither: it is not yet lost, and calling it sold
     * would put money in a payout that may be handed back next week.
     */
    var refund = refunded[String(r.line_item_id || '')];
    if (refund === 'refunded') meaning = 'refunded';
    else if (refund === 'at_risk' && meaning === 'sold') meaning = 'at_risk';

    if (meaning === 'sold') {
      g.units += qty;
      g.revenue += Number(r.sale_price || 0) * qty;
    } else if (meaning === 'unsold') {
      g.unsold_units += qty;
    } else if (meaning === 'held') {
      // Paid, inside the buyer's remorse window, cancellable without the
      // seller's agreement. Committed stock; not yet money.
      g.held_units += qty;
    } else if (meaning === 'refunded') {
      g.refunded_units += qty;
    } else if (meaning === 'at_risk') {
      g.at_risk_units += qty;
    } else {
      g.unknown_units += qty;
      g.unknown_statuses[String(r.status || '(blank)')] = true;
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
    var entry = {
      units: g.units,
      unsold: g.unsold_units,
      held: g.held_units,
      unknown: g.unknown_units,
      refunded: g.refunded_units,
      at_risk: g.at_risk_units
    };
    if (g.sku_id) compact['id:' + g.sku_id] = entry;
    /**
     * The seller_sku key is written only when no other variation has claimed
     * it.
     *
     * `identifierFromVariation_` can recover the same identifier from two
     * different variations' names, and the last writer used to win — so a
     * variation whose TikTok id was unknown would be handed ANOTHER
     * variation's sold count rather than none. A wrong number presented
     * confidently is worse than no number, and this one is paid against.
     */
    if (g.seller_sku) {
      var key = 'sku:' + g.seller_sku;
      if (compact[key] && compact[key].__owner !== g.sku_id) {
        compact[key] = { units: null, unsold: null, held: null, unknown: null, ambiguous: true };
      } else if (!compact[key]) {
        compact[key] = entry;
        compact[key].__owner = g.sku_id;
      }
    }
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

function variationSalesCached_(listingId, known_) {
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

  var compact = salesIndex_(variationSales_(listingId, null, null, known_).byVariation);

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
  var hit = sales['id:' + String(tiktokSkuId || '')] ||
            sales['sku:' + String(identifier || '')] ||
            null;
  // An identifier two variations both answer to tells us nothing about either.
  // Null reads on screen as "no sold figure", which is true; a number would
  // not be.
  if (hit && hit.ambiguous) return null;
  return hit;
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

// ── the background sync ───────────────────────────────────────────────

/**
 * Keep the sold count current without anyone pressing anything.
 *
 * Brien, 15 Sep: *"Isn't orders always synced when I press the sync icon in
 * listings tab?"* It was not. The listing refresh reads orders from the SHEET;
 * only the Sync button on the Orders tab pulls new ones from TikTok. Nobody
 * touches that tab during a broadcast, so the sold figure on every phone was
 * frozen at whenever somebody last synced — which is why variations showed a
 * creator and no sold count.
 *
 * Fixing it on the phone was the obvious move and the wrong one. Pulling
 * orders on every listing refresh would add three to eight TikTok calls and
 * several seconds to the button pressed most during a stream, and compete for
 * the rate limit with the pushes. A browser timer is worse still: it only runs
 * while a phone is awake with the app in front.
 *
 * So it runs on Apps Script's own schedule. The listing refresh stays a Sheet
 * read and stays fast; sold is never more than one interval old; and it is
 * true on every phone at once, including one that has been in a pocket.
 */
/**
 * Apps Script accepts 1, 5, 10, 15 or 30. Nothing else.
 *
 * Brien asked for two and two is not on the list — `everyMinutes(2)` throws
 * "The value you passed to everyMinutes was invalid". One is the nearest
 * allowed value in the direction he wanted, and affordable because a firing
 * with nothing to report is three property reads plus one TikTok call that
 * answers empty. Five would have been the lazy read of the error.
 */
var SYNC_ALLOWED_MINUTES = [1, 5, 10, 15, 30];
var SYNC_EVERY_MINUTES = 1;
var SYNC_WINDOW_MIN = 20;
var SYNC_ACTIVE_HOURS = 6;
var SYNC_TRIGGER_FN = 'syncRecentOrders';
var LAST_LISTED_PREFIX = 'LAST_LISTED_';
var LAST_SYNCED_PREFIX = 'LAST_SYNCED_';
var SYNC_BACKFILL_MIN = 60;
/** How long after a shop's last push its orders are still watched for changes. */
var SYNC_TAIL_HOURS = 72;
var LAST_RETURNS_PREFIX = 'LAST_RETURNS_';
/** First returns run looks back this far, so an existing refund is not missed. */
var SYNC_RETURNS_BACKFILL_H = 720;

/**
 * Install the timer. Run once, by hand, from the editor.
 *
 * Idempotent: it removes any trigger it already installed before adding one,
 * so running it twice does not sync twice as often.
 */
function installOrderSync() {
  // Checked here rather than discovered at the trigger API, which reports it
  // as an exception in the editor with no clue which value is acceptable.
  if (SYNC_ALLOWED_MINUTES.indexOf(SYNC_EVERY_MINUTES) < 0) {
    throw fail_('TS-ORD-31', 'SYNC_EVERY_MINUTES is ' + SYNC_EVERY_MINUTES +
      ', which Apps Script will refuse. It must be one of ' + SYNC_ALLOWED_MINUTES.join(', ') + '.');
  }
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SYNC_TRIGGER_FN) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  ScriptApp.newTrigger(SYNC_TRIGGER_FN).timeBased().everyMinutes(SYNC_EVERY_MINUTES).create();
  var message = 'Order sync installed: every ' + SYNC_EVERY_MINUTES + ' minutes' +
    (removed ? ' (replaced ' + removed + ' existing)' : '');
  console.log(message);
  return message;
}

/** Take the timer off again. */
function removeOrderSync() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SYNC_TRIGGER_FN) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return 'Removed ' + removed + ' order sync trigger(s)';
}

/**
 * Shops worth syncing right now.
 *
 * Gated on ACTIVITY rather than on the clock. A "stream hours" window would
 * need a timezone, a schedule, and remembering to change it — and would miss a
 * daytime stream while burning quota through a quiet evening. A shop that has
 * listed something in the last few hours is a shop taking orders; one that has
 * not is costing nothing.
 *
 * Pure so the rule can be asserted without a Sheet or a clock.
 */
function shopsToSync_(lastListed, nowMs, activeHours, tailHours) {
  var cutoff = nowMs - (activeHours || SYNC_ACTIVE_HOURS) * 3600 * 1000;
  /**
   * A long tail, because an order does not stop changing when a stream ends.
   *
   * The gate was six hours from the last push, which is right for "is a
   * broadcast running". It is wrong for cancellations and refunds, which
   * arrive the next morning — and exports read the Sheet, not TikTok, so a
   * purchase order built before somebody remembered to press Sync counts
   * cancelled units as sold. That is the failure this whole sync exists to
   * prevent, arriving through the back door.
   *
   * So a shop stays in the sync for a good while after it last listed. The
   * cost of a firing with nothing to report is one TikTok call that answers
   * empty, which is the point of asking by change rather than by window.
   */
  var tail = nowMs - (tailHours || SYNC_TAIL_HOURS) * 3600 * 1000;
  var out = [];
  Object.keys(lastListed || {}).forEach(function (shopId) {
    if (!shopId) return;
    var at = Number(lastListed[shopId] || 0);
    if (at && at >= Math.min(cutoff, tail)) out.push(shopId);
  });
  return out.sort();
}

/**
 * When each shop last listed something, from Script Properties.
 *
 * Deliberately NOT from the SKUs tab. The gate runs on every firing of the
 * timer — seven hundred times a day — and reading a whole tab to decide
 * whether to do nothing is more expensive than the work it is avoiding.
 * `noteListed_` writes one property on each push instead; reading three of
 * them is free.
 */
function lastListedAt_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var out = {};
  SHOPS.forEach(function (shop) {
    var raw = props[LAST_LISTED_PREFIX + shop.id];
    if (raw) out[shop.id] = Number(raw);
  });
  return out;
}

/** Stamped on every successful push, so the gate above costs one property read. */
function noteListed_(shopId) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty(LAST_LISTED_PREFIX + String(shopId), String(Date.now()));
  } catch (e) {
    // The gate degrades to "do not sync", which is visible as a stale sold
    // count rather than as damage. Never worth failing a push over.
    console.error('could not stamp last listed: ' + e);
  }
}

/**
 * The trigger's target. Never throws: a timer that fails is disabled by Apps
 * Script after enough errors, and a silent sync that stopped weeks ago is the
 * worst version of this feature.
 */
/**
 * Orders that have CHANGED since we last looked, and nothing else.
 *
 * Pure, so the rule can be asserted without TikTok or a clock.
 *
 * Two jobs. It proves the filter was applied — TikTok ignoring an unknown
 * parameter returns the most recent orders instead of erroring, which would
 * look like a working sync while silently missing everything — and it says
 * where the next watermark should sit.
 *
 * The watermark is the newest change actually SEEN, not "now". A clock-based
 * one skips anything that changed during the call itself; this one cannot,
 * and the worst it does is re-fetch a handful next time.
 */
function changedSince_(orders, sinceEpoch) {
  var stale = [];
  var newest = sinceEpoch;
  (orders || []).forEach(function (o) {
    var at = Number(o.update_time || o.create_time || 0);
    if (at && at < sinceEpoch) stale.push(o);
    if (at > newest) newest = at;
  });
  return {
    applied: stale.length === 0,
    stale: stale.length,
    watermark: newest,
    count: (orders || []).length
  };
}

/**
 * The trigger's target. Never throws: Apps Script disables a timer that fails
 * often enough, and a sync that silently stopped weeks ago is the worst
 * version of this feature.
 */
function syncRecentOrders() {
  /**
   * One run at a time.
   *
   * At a one-minute trigger a slow run — the first returns pass backfills a
   * month — is still going when the next fires. Both would fetch and write the
   * same rows. The writes are keyed and idempotent so nothing corrupts, but
   * they would queue on the script lock behind each other and spend the shop's
   * rate limit twice over for one answer.
   *
   * A cache entry rather than a property: it expires by itself, so a run
   * killed by the six-minute limit cannot leave the sync switched off for ever.
   */
  var guard = null;
  try {
    guard = CacheService.getScriptCache();
    if (guard && guard.get('sync_running')) return;
    if (guard) guard.put('sync_running', '1', 300);
  } catch (e) {
    // No cache is not a reason to skip the sync, only to lose the guard.
    guard = null;
  }

  try {
    syncRecentOrdersOnce_();
  } finally {
    try { if (guard) guard.remove('sync_running'); } catch (e) { /* expires anyway */ }
  }
}

function syncRecentOrdersOnce_() {
  var shops;
  try {
    shops = shopsToSync_(lastListedAt_(), Date.now(), SYNC_ACTIVE_HOURS);
  } catch (e) {
    warn_('TS-ORD-23', 'Background sync could not read its activity marks: ' + e);
    return;
  }
  // The common case, and it must cost almost nothing: three property reads and
  // a return. Every two minutes, all day, every day.
  if (!shops.length) return;

  var props = PropertiesService.getScriptProperties();
  var nowEpoch = Math.floor(Date.now() / 1000);

  shops.forEach(function (shopId) {
    try {
      var markKey = LAST_SYNCED_PREFIX + shopId;
      var since = Number(props.getProperty(markKey) || 0) ||
        (nowEpoch - SYNC_BACKFILL_MIN * 60);

      /**
       * Ask only for what has changed. Usually nothing.
       *
       * Brien: *"it should only look at orders that have status change like
       * cancellation ... It should only recognize when there's a change and
       * not fire or do more when it doesn't record a change."* Exactly right,
       * and the reason a creation-time window was wrong at this cadence: it
       * re-fetched every order in it every two minutes and still could not see
       * a cancellation, because cancelling does not change when an order was
       * created.
       */
      var orders = ttAllOrders_(shopId, since, nowEpoch + 1, true);
      var check = changedSince_(orders, since);

      if (!check.applied) {
        /**
         * The filter was ignored, so what came back is not what was asked
         * for. Nothing is written from it, and this shop falls back to the
         * creation-time window for this run — correct, just more expensive.
         */
        warn_('TS-ORD-25', shopId + ': update_time filter not applied (' + check.stale +
          ' order(s) older than the watermark). Falling back to creation time.');
        var from = new Date((nowEpoch - SYNC_WINDOW_MIN * 60) * 1000);
        var to = new Date(nowEpoch * 1000);
        var d = function (x) { return Utilities.formatDate(x, 'Asia/Singapore', 'yyyy-MM-dd'); };
        var t = function (x) { return Utilities.formatDate(x, 'Asia/Singapore', 'HH:mm'); };
        syncOrders_(shopId, d(from), d(from) === d(to) ? t(from) : '00:00', d(to), t(to),
                    'background sync');
        return;
      }

      // Nothing changed. No Sheet is opened, nothing is written, and the
      // watermark does not move — which is the whole point of the question
      // being "what changed" rather than "what exists".
      if (check.count) {
        writeOrders_(shopId, orders, 'background sync');
        props.setProperty(markKey, String(check.watermark));
      }

      /**
       * Refunds, on their own watermark.
       *
       * A separate endpoint and a separate clock: a refund can land days after
       * the order stopped changing, so sharing the orders watermark would make
       * the refund pass ask about a window the orders pass had already moved
       * past. Separate here also means a shop whose returns scope is not yet
       * granted still gets its orders — the failure is contained to the pass
       * that needs the permission.
       */
      try {
        var returnsKey = LAST_RETURNS_PREFIX + shopId;
        var returnsSince = Number(props.getProperty(returnsKey) || 0) ||
          (nowEpoch - SYNC_RETURNS_BACKFILL_H * 3600);
        syncReturns_(shopId, returnsSince, 'background sync');
        props.setProperty(returnsKey, String(nowEpoch));
      } catch (e) {
        warn_('TS-ORD-30', shopId + ': returns sync failed (orders are unaffected): ' + e);
      }
    } catch (e) {
      // One shop failing must not stop the others, and must not disable the
      // timer. The log is where a sync that has been failing all week is found.
      warn_('TS-ORD-24', 'Background sync failed for ' + shopId + ': ' + e);
    }
  });
}

/**
 * Turn TikTok's orders into rows and write them.
 *
 * Extracted so the manual sync and the two-minute background one share one
 * path. They fetch differently — a window someone chose, versus whatever has
 * changed since the last watermark — but what happens to an order afterwards
 * must not depend on which asked for it.
 */
function writeOrders_(shopId, orders, actor) {
  var shop = shopById_(shopId);
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
        created_epoch: created,
        // What a refund is matched on. See HEADERS[TAB_ORDER_ITEMS].
        line_item_id: String(li.id || '')
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
   * written together so a reader never sees orders without their items.
   */
  withScriptLock_(30000, function () {
    replaceByKey_(TAB_ORDERS, 'order_id', orderRows);
    replaceByKey_(TAB_ORDER_ITEMS, 'order_id', itemRows);
  });

  return { orders: orders.length, items: itemRows.length, filledNote: filledNote };

}

// ── returns and refunds ───────────────────────────────────────────────

/**
 * What a return status means for the money.
 *
 * The complete enum, read on 15 Sep from TikTok's own Search Returns page
 * (doc 650ab69edefece02be70785b, `POST /return_refund/202309/returns/search`)
 * through the documentation site's JSON API. The rendered page is a JavaScript
 * shell with no text in it, which is why an earlier attempt to check this
 * "against the docs" found nothing and why this table is quoted rather than
 * remembered.
 *
 * This exists because NO ORDER STATUS CAN ANSWER IT. TikTok's Order API
 * overview states three times that a fully refunded order lands in COMPLETED —
 * "Once the order amount is a full refund to the buyer, the order status will
 * be updated to COMPLETED" — and the line-item `display_status` enum has no
 * REFUNDED, RETURNED or PARTIALLY_REFUNDED value at all. A refunded line still
 * reads DELIVERED. Every "sold" figure this app produced before this table was
 * "sold, before refunds", and a factory was paid on it.
 *
 *   refunded  the buyer has the money back, or certainly will
 *   at_risk   a request is open and undecided
 *   kept      the request was rejected, cancelled or withdrawn
 */
var RETURN_STATUS_MEANING = {
  // "The return/refund was processed successfully. The buyer has been refunded."
  RETURN_OR_REFUND_REQUEST_COMPLETE: 'refunded',
  // "The return/refund request was approved. The buyer will be refunded."
  RETURN_OR_REFUND_REQUEST_SUCCESS: 'refunded',
  // "Buyer's replacement request was resolved by refund due to insufficient inventory."
  REPLACEMENT_REQUEST_REFUND_SUCCESS: 'refunded',

  // Open and undecided. The money is still the seller's for now, but naming it
  // separately is what lets the screen say "3 sold, 1 being returned" rather
  // than picking one of those and being wrong either way.
  RETURN_OR_REFUND_REQUEST_PENDING: 'at_risk',
  AWAITING_BUYER_SHIP: 'at_risk',
  BUYER_SHIPPED_ITEM: 'at_risk',
  AWAITING_BUYER_RESPONSE: 'at_risk',
  REPLACEMENT_REQUEST_PENDING: 'at_risk',

  // Decided in the seller's favour.
  REFUND_OR_RETURN_REQUEST_REJECT: 'kept',
  REJECT_RECEIVE_PACKAGE: 'kept',
  RETURN_OR_REFUND_REQUEST_CANCEL: 'kept',
  REPLACEMENT_REQUEST_REJECT: 'kept',
  REPLACEMENT_REQUEST_CANCEL: 'kept'
};

/** Unknown is at_risk, never kept: an unrecognised return must not read as a sale. */
function returnStatusMeaning_(status) {
  var key = String(status || '').trim().toUpperCase();
  if (!key) return 'at_risk';
  return RETURN_STATUS_MEANING[key] || 'at_risk';
}

/** One page of returns. Filters are documented on the Search Returns page. */
function ttSearchReturns_(prefix, sinceEpoch, pageToken) {
  var query = { page_size: String(ORDER_PAGE_SIZE) };
  if (pageToken) query.page_token = pageToken;
  var r = ttFetch_(prefix, 'post', '/return_refund/202309/returns/search', query, {
    update_time_ge: Number(sinceEpoch)
  });
  if (r.code !== 0) throw fail_('TS-ORD-28', 'Could not read returns: ' + ttReason_(r));
  var data = r.data || {};
  return { returns: data.return_orders || [], nextPageToken: data.next_page_token || '' };
}

/**
 * Flatten TikTok's returns into one row per returned line item.
 *
 * Pure, so the shape can be asserted without the network. One return can cover
 * several line items and each is decided on its own, so the row key is the
 * return LINE item rather than the return.
 */
function returnRows_(shopId, returns, syncedAt) {
  var rows = [];
  (returns || []).forEach(function (ret) {
    (ret.return_line_items || []).forEach(function (li) {
      rows.push({
        return_line_item_id: String(li.return_line_item_id || ''),
        return_id: String(ret.return_id || ''),
        shop_id: shopId,
        order_id: String(ret.order_id || ''),
        line_item_id: String(li.order_line_item_id || ''),
        sku_id: String(li.sku_id || ''),
        seller_sku: String(li.seller_sku || ''),
        return_type: String(ret.return_type || ''),
        return_status: String(ret.return_status || ''),
        refund_total: String((li.refund_amount && li.refund_amount.refund_total) || ''),
        currency: String((li.refund_amount && li.refund_amount.currency) || 'SGD'),
        create_epoch: Number(ret.create_time || 0),
        update_epoch: Number(ret.update_time || ret.create_time || 0),
        synced_at: syncedAt
      });
    });
  });
  return rows;
}

/**
 * Refund state per order line item id, for the sold count to consult.
 *
 * Keyed by `line_item_id` because that is the only field a return and an order
 * line agree on. When one line item has more than one return against it — a
 * rejected request followed by a second attempt — the WORST outcome wins:
 * refunded beats at_risk beats kept. A unit refunded on the second attempt is
 * refunded, whatever the first attempt said.
 */
function refundIndex_(returnRows) {
  var rank = { kept: 0, at_risk: 1, refunded: 2 };
  var out = {};
  (returnRows || []).forEach(function (r) {
    var id = String(r.line_item_id || '');
    if (!id) return;
    var meaning = returnStatusMeaning_(r.return_status);
    if (!out[id] || rank[meaning] > rank[out[id]]) out[id] = meaning;
  });
  return out;
}

/** Pull returns changed since the watermark into the Returns tab. */
function syncReturns_(shopId, sinceEpoch, actor) {
  var all = [];
  var token = '';
  var pages = 0;
  do {
    var page = ttSearchReturns_(shopId, sinceEpoch, token);
    all = all.concat(page.returns);
    token = page.nextPageToken;
    pages++;
    if (pages >= 60 && token) {
      warn_('TS-ORD-29', shopId + ': more than ' + (60 * ORDER_PAGE_SIZE) +
        ' returns changed since ' + sinceEpoch + '; stopping and keeping what was read.');
      break;
    }
  } while (token);

  var rows = returnRows_(shopId, all, new Date().toISOString());
  if (rows.length) {
    withScriptLock_(30000, function () {
      replaceByKey_(TAB_RETURNS, 'return_line_item_id', rows);
    });
    logEvent_(actor, 'sync_returns', shopId, rows.length + ' return line(s)', 'ok');
  }
  return { returns: all.length, lines: rows.length };
}
