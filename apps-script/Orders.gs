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
 * Five outcomes, because three were not enough to be honest:
 *
 *   sold    the seller kept the money
 *   unsold  the money did not stick, and TikTok returns the units to stock
 *   unpaid  placed, and not paid for yet. Not revenue, so the money columns
 *           count it with unsold exactly as they always have; named apart so
 *           the listing screen stops calling it cancelled. See emptyTally_.
 *   held    PAID, but the buyer may still cancel unilaterally. Committed
 *           stock, not yet revenue — counting it as either is a lie.
 *   unknown a status this table does not list. Never counted as sold, always
 *           logged, so an unrecognised value is a question rather than an
 *           overpayment.
 */
var LINE_STATUS_MEANING = {
  // Was 'unsold', so the listing screen showed a basket waiting on payment as
  // "1 cancelled" while nobody had cancelled anything.
  UNPAID: 'unpaid',
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

  /**
   * Refunds, read before anything is counted.
   *
   * The orders screen and the export used to count a refunded unit as sold,
   * because the order status cannot see a refund — see SOLD_IS_BEFORE_REFUNDS.
   * The listing screen stopped doing that on 15 Sep; this side had not.
   */
  var refunds = refundIndex_(readAll_(TAB_RETURNS).filter(function (r) {
    return !shopId || String(r.shop_id) === String(shopId);
  }));

  var out = summariseItems_(items, refunds);

  var unknown = Object.keys(out.totals.unknown_statuses);
  if (unknown.length) {
    warn_('TS-ORD-33', 'Order line statuses this app does not recognise in this window: ' +
      unknown.join(', ') + '. They are NOT counted as sold, so the orders screen ' +
      'and the export short by their units rather than overpaying. Add them to ' +
      'LINE_STATUS_MEANING once their meaning is confirmed.');
  }
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
function summariseItems_(items, refunds) {
  var byListing = {};
  items.forEach(function (r) {
    /**
     * A blank listing id is kept blank, not renamed.
     *
     * This invented the string 'unknown' as a grouping key, and the export
     * then fed it back through `listingOrders_('unknown', ...)` as though it
     * were a real TikTok listing id — which matches no row, so the sheet came
     * out empty while the Summary line above it showed real units and real
     * money. A factory sheet with a total and no lines is worse than one that
     * says what it does not know.
     *
     * The blank travels as a blank, and the export names it honestly.
     */
    /**
     * Unattributed lines are grouped by PRODUCT, not pooled into one row.
     *
     * Keying every blank listing id as one group merged unrelated products —
     * different brands, different factories — into a single Summary row
     * labelled with whichever name happened to arrive first, and tapping it on
     * the orders screen returned all of them. Naming one product and showing
     * another's money under it is worse than the 'unknown' string it replaced.
     *
     * The blank listing id still travels as a blank, so nothing pretends to be
     * a real TikTok listing. The row just says which product it is.
     */
    var key = String(r.listing_id || '');
    if (!key) key = '\u0000noListing:' + String(r.product_name || r.sku_id || r.seller_sku || '?');
    if (!byListing[key]) {
      var fresh = emptyTally_();
      // The key carries a product name so the rows stay apart; the row itself
      // reports a blank id, because there is no listing to open.
      fresh.unattributed = key.indexOf('\u0000noListing:') === 0;
      fresh.listing_id = fresh.unattributed ? '' : key;
      fresh.product_name = String(r.product_name || '');
      fresh.orders = {};
      fresh.latest_epoch = 0;
      byListing[key] = fresh;
    }
    var g = byListing[key];
    g.orders[String(r.order_id)] = 1;

    /**
     * The same function the listing screen counts with.
     *
     * This was its own loop over a three-status denylist, so a refunded unit
     * was sold here and not sold there, and the export — built from this side
     * — was the one paying for it. Two aggregators, two rules, one payout.
     */
    addLine_(g, r, refunds);

    if (Number(r.created_epoch || 0) > g.latest_epoch) {
      g.latest_epoch = Number(r.created_epoch || 0);
    }
    if (!g.product_name && r.product_name) g.product_name = String(r.product_name);
  });

  var listings = Object.keys(byListing).map(function (k) {
    var g = roundTally_(byListing[k]);
    g.order_count = Object.keys(g.orders).length;
    /**
     * The ids themselves, not just how many.
     *
     * The export can be asked for a subset of listings, and the TOTAL line
     * then has to count the DISTINCT orders across that subset. Summing
     * `order_count` says two for one basket that touched two listings.
     * Counting needs the ids, so they travel with the row.
     */
    g.order_ids = Object.keys(g.orders);
    g.latest_order_sgt = g.latest_epoch ? sgtStampFromEpoch_(g.latest_epoch) : '';
    delete g.orders;
    return g;
  }).sort(function (a, b) { return b.sold_value - a.sold_value; });

  var orderIds = {};
  items.forEach(function (r) { orderIds[String(r.order_id)] = 1; });

  var totals = listings.reduce(function (t, l) { return addTally_(t, l); }, emptyTally_());
  roundTally_(totals);

  var out = {
    listings: listings,
    // Distinct orders, not the sum of the per-listing counts: a basket holding
    // two listings is ONE order, and summing would report it as two.
    total_orders: Object.keys(orderIds).length,
    // Summed from line items, so a basket holding two listings contributes to
    // both without being counted twice here.
    total_units: totals.sold_units,
    total_revenue: totals.sold_value,
    totals: totals
  };
  return out;
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
/**
 * One tally shape, and one place that fills it.
 *
 * `groupVariationSales_` and `summariseItems_` counted the same line items by
 * two different rules: the first got the refund model and the four-way status
 * table on 15 Sep, the second was still on the old three-status denylist. So
 * the listing screen and the ORDERS screen — and the export built from it —
 * disagreed about the same units, with the export on the wrong side. That is
 * the second time the two ends of this app have drifted apart on a payout
 * figure, so they now share a function rather than a convention.
 *
 * Every bucket carries units AND value, because "why is the money less than
 * the units suggest" is the question a factory actually asks, and answering it
 * needs both halves of every row.
 */
function emptyTally_() {
  return {
    /** Everything a buyer put in a basket. sold + cancelled + refunded + at risk + held + unknown. */
    ordered_units: 0, ordered_value: 0,
    /** Kept. The number a factory is paid on. */
    sold_units: 0, sold_value: 0,
    /** Cancelled or never paid for. TikTok returns these to stock. */
    cancelled_units: 0, cancelled_value: 0,
    /**
     * Of the cancelled units, the ones never paid for. A breakdown, NOT a
     * bucket: they stay inside cancelled_units, so every subtraction over the
     * buckets — the export's net sold, the orders screen's — comes out exactly
     * as it did before UNPAID had a name of its own. Only the listing screen
     * takes them back out, in salesIndex_.
     */
    unpaid_units: 0, unpaid_value: 0,
    /** Bought, then given back. Invisible in any order status — see RETURN_STATUS_MEANING. */
    refunded_units: 0, refunded_value: 0,
    /** A return request is open and undecided. */
    at_risk_units: 0, at_risk_value: 0,
    /** Paid, inside the buyer's remorse window, cancellable by them alone. */
    held_units: 0, held_value: 0,
    /** A status this app does not recognise. Never counted as sold. */
    unknown_units: 0, unknown_value: 0,
    unknown_statuses: {}
  };
}

/** Add one order line to a tally, by the one rule. */
function addLine_(tally, row, refunds) {
  // One line item is one unit; a blank quantity is one, not none. See the note
  // in groupVariationSales_ — zero made a legacy row vanish from every column.
  var qty = Number(row.quantity);
  if (!isFinite(qty) || qty <= 0) qty = 1;
  var value = Number(row.sale_price || 0) * qty;

  var meaning = lineStatusMeaning_(row.status);
  var refund = (refunds || {})[String(row.line_item_id || '')];
  if (refund === 'refunded') meaning = 'refunded';
  else if (refund === 'at_risk' && meaning === 'sold') meaning = 'at_risk';

  tally.ordered_units += qty;
  tally.ordered_value += value;

  if (meaning === 'sold') { tally.sold_units += qty; tally.sold_value += value; }
  else if (meaning === 'unsold' || meaning === 'unpaid') {
    tally.cancelled_units += qty; tally.cancelled_value += value;
    if (meaning === 'unpaid') { tally.unpaid_units += qty; tally.unpaid_value += value; }
  }
  else if (meaning === 'refunded') { tally.refunded_units += qty; tally.refunded_value += value; }
  else if (meaning === 'at_risk') { tally.at_risk_units += qty; tally.at_risk_value += value; }
  else if (meaning === 'held') { tally.held_units += qty; tally.held_value += value; }
  else {
    tally.unknown_units += qty;
    tally.unknown_value += value;
    tally.unknown_statuses[String(row.status || '(blank)')] = true;
  }
  return meaning;
}

/**
 * The names the rest of the app already reads, kept in step with the tally.
 *
 * `units`, `revenue` and `unsold_units` predate the tally and are read by the
 * listing screen, the orders screen and the export. They are assigned FROM the
 * tally rather than counted alongside it, so there is exactly one place a unit
 * can be put in the wrong bucket.
 */
function withLegacyNames_(t) {
  t.units = t.sold_units;
  t.revenue = t.sold_value;
  t.unsold_units = t.cancelled_units;
  return t;
}

/** Round every money figure on a tally, so the aliases cannot drift from it. */
function roundTally_(t) {
  ['ordered_value', 'sold_value', 'cancelled_value', 'unpaid_value', 'refunded_value',
   'at_risk_value', 'held_value', 'unknown_value'].forEach(function (f) {
    t[f] = Math.round(t[f] * 100) / 100;
  });
  return withLegacyNames_(t);
}

/** Add one tally into another. Used for the per-listing and export totals. */
function addTally_(into, from) {
  ['ordered_units', 'ordered_value', 'sold_units', 'sold_value',
   'cancelled_units', 'cancelled_value', 'unpaid_units', 'unpaid_value',
   'refunded_units', 'refunded_value',
   'at_risk_units', 'at_risk_value', 'held_units', 'held_value',
   'unknown_units', 'unknown_value'].forEach(function (f) {
    into[f] += from[f] || 0;
  });
  Object.keys(from.unknown_statuses || {}).forEach(function (st) {
    into.unknown_statuses[st] = true;
  });
  return into;
}

function groupVariationSales_(items, refunds) {
  var byVariation = {};
  items.forEach(function (r) {
    // sku_id first: seller_sku is empty on anything this app did not list,
    // and two variations can share a sku_name. Only the id is guaranteed
    // unique, and getting this wrong merges two variations into one row of a
    // purchase order.
    var key = String(r.sku_id || r.seller_sku || r.variation || '?');
    if (!byVariation[key]) {
      var fresh = emptyTally_();
      fresh.sku_id = String(r.sku_id || '');
      fresh.seller_sku = String(r.seller_sku || '');
      fresh.variation = String(r.variation || '');
      fresh.sku_image = String(r.sku_image || '');
      fresh.price = String(r.sale_price || '');
      byVariation[key] = fresh;
    }
    var g = byVariation[key];
    if (!g.sku_image && r.sku_image) g.sku_image = String(r.sku_image);
    if (!g.seller_sku && r.seller_sku) g.seller_sku = String(r.seller_sku);
    // One rule, one place. Quantity handling, the four-way status table and
    // the refund override all live in addLine_ — see the note on emptyTally_
    // for why this is no longer a loop with its own arithmetic.
    addLine_(g, r, refunds);
  });
  Object.keys(byVariation).forEach(function (k) { withLegacyNames_(byVariation[k]); });
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
      // Cancelled means cancelled here. The tally keeps unpaid units inside
      // its cancelled figure for the money (see emptyTally_), and this screen
      // is the one place that has to tell the two apart.
      unsold: g.unsold_units - (g.unpaid_units || 0),
      unpaid: g.unpaid_units || 0,
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
        compact[key] = { units: null, unsold: null, unpaid: null, held: null, unknown: null, ambiguous: true };
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
 * Keyed per listing AND per orders version, like the SKU slices in Sheet.gs.
 * It was keyed per listing alone with a sixty-second life, so a sync that had
 * just written a cancellation could sit behind a minute-old answer, and any
 * refresh more than a minute after the last one re-read the whole Order Items
 * tab whether or not a single order had changed.
 *
 * Every write to Order Items or Returns bumps the version (`tabChanged_`), so
 * the entry is unreachable the moment anything it was built from changes, and
 * can otherwise live for CacheService's six-hour maximum. A quiet minute now
 * writes nothing, so it bumps nothing, so the screen keeps its cached answer.
 *
 * Only the counts are cached, not the rows, so the payload stays far inside
 * the 100 KB per-key limit even for a 200-SKU stream.
 */
var SALES_CACHE_TTL_S = 21600;

function variationSalesCached_(listingId, known_) {
  var key = 'sales:v' + ordersVersion_() + ':' + String(listingId);
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
    return roundTally_(byVariation[k]);
  }).sort(function (a, b) {
    // Identifier order, so the export reads in the order the stream ran.
    return String(a.seller_sku).localeCompare(String(b.seller_sku), 'en', { numeric: true });
  });

  /**
   * Totals summed from the rows, not counted again.
   *
   * Every figure on the TOTAL line of a factory's sheet is the sum of the
   * column above it, by construction. The old code summed `units` and
   * `revenue` by hand and left every other column to the export to total for
   * itself — which is how a sheet ends up with a TOTAL that does not match.
   */
  var totals = rows.reduce(function (t, r) { return addTally_(t, r); }, emptyTally_());
  roundTally_(totals);

  return {
    listing_id: String(listingId),
    from: fromDate + ' ' + (fromTime || '00:00'),
    to: toDate + ' ' + (toTime || '23:59'),
    variations: rows,
    order_count: Object.keys(items.reduce(function (m, r) {
      m[String(r.order_id)] = 1; return m;
    }, {})).length,
    total_units: totals.sold_units,
    total_revenue: totals.sold_value,
    totals: totals
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
/** Inside the tail, a shop is synced this often rather than on every firing. */
var SYNC_TAIL_EVERY_MIN = 10;
/** After the tail, a shop is still synced for this long, for refunds of older orders... */
var SYNC_DORMANT_DAYS = 30;
/** ...this often. */
var SYNC_DORMANT_EVERY_MIN = 60;
/** When each shop was last synced, so the slower tiers know when they are due. */
var LAST_SYNC_RUN_PREFIX = 'LAST_SYNC_RUN_';
var LAST_RETURNS_PREFIX = 'LAST_RETURNS_';
/** First returns run looks back this far, so an existing refund is not missed. */
var SYNC_RETURNS_BACKFILL_H = 720;

/**
 * How far behind its watermark each sync asks again.
 *
 * TikTok does not index a change the instant it stamps it. An order whose
 * update_time is a few seconds older than the newest one we saw can turn up in
 * search only after we asked — and a query starting exactly at the watermark
 * never asks about that second again, so the order is skipped for good.
 *
 * Two minutes is a judgement, not a measurement: TS-ORD-25 recorded HOW MANY
 * orders came back behind the watermark (one, every time) but not by how much.
 * It is short enough that the orders asked about twice are a handful, which
 * `dropUnchanged_` then does not write.
 */
var SYNC_OVERLAP_S = 120;

/**
 * How much older than a query's lower bound an order may be before TikTok is
 * taken to have ignored the filter.
 *
 * Any amount was too strict: TS-ORD-25 fired 44 times on 18 days, every time
 * for a single order, and every time threw the run onto the creation-time
 * fallback, which cannot see a cancellation. With TikTok's indexing lag, an
 * order a little behind the lower bound is the normal case, not a fault. An
 * ignored filter returns the shop's most recent orders whatever they are, and
 * on a shop that has traded for more than an hour that soon includes one far
 * older than this.
 */
var SYNC_FILTER_TOLERANCE_S = 3600;

/**
 * When the order pass stops starting new pages.
 *
 * Apps Script kills an execution at six minutes. The pass used to read every
 * page before writing any and then throw TS-ORD-02 at sixty pages, so a
 * backlog bigger than that was never written and never got smaller. Four
 * minutes leaves room for the returns pass; what is left over is resumed on
 * the next firing from the saved page (SYNC_CURSOR_PREFIX).
 */
var SYNC_BUDGET_MS = 4 * 60 * 1000;

/**
 * Orders (and returns) already written whose update_time sits inside the
 * overlap, by id, so asking about them again does not write them again.
 *
 * In Script Properties, not CacheService. It has to outlast the gap between
 * two runs — an hour, for a shop in the slowest tier — and the cache may drop
 * an entry before its expiry, which here would mean the boundary order being
 * rewritten again: the TS-ORD-08-every-minute this exists to stop. It is
 * read in the same `getProperties()` call as the watermark it belongs to, so
 * it costs no extra read. The 9 KB per-value cap is the price, and
 * SYNC_STATE_MAX_CHARS checks it before every write.
 */
var SYNC_SEEN_PREFIX = 'SYNC_SEEN_';
var RETURNS_SEEN_PREFIX = 'RETURNS_SEEN_';
/** A scan stopped by SYNC_BUDGET_MS, saved so the next run carries on from it. */
var SYNC_CURSOR_PREFIX = 'SYNC_CURSOR_';
/** Under Script Properties' 9 KB per-value cap, with headroom. */
var SYNC_STATE_MAX_CHARS = 8000;

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
 * not costs a call every ten minutes, then every hour, then nothing — see
 * syncEveryMinutes_.
 *
 * Pure so the rule can be asserted without a Sheet or a clock.
 *
 * `lastRun` is when each shop was last synced, so the slower tiers know when
 * they are due. `backlog` names shops with a scan to finish (SYNC_CURSOR_PREFIX);
 * those go on every firing whatever their tier, or a shop in the hourly tier
 * would work through its backlog four minutes an hour.
 */
function shopsToSync_(lastListed, nowMs, lastRun, backlog) {
  var ran = lastRun && typeof lastRun === 'object' ? lastRun : {};
  var owed = backlog && typeof backlog === 'object' ? backlog : {};
  var ids = {};
  Object.keys(lastListed || {}).concat(Object.keys(owed)).forEach(function (id) { ids[id] = true; });

  var out = [];
  Object.keys(ids).forEach(function (shopId) {
    if (!shopId) return;
    if (owed[shopId]) { out.push(shopId); return; }
    var at = Number((lastListed || {})[shopId] || 0);
    if (!at) return;
    var every = syncEveryMinutes_(nowMs - at);
    if (!every) return;
    var last = Number(ran[shopId] || 0);
    // Thirty seconds of slack, because the timer does not fire on the second:
    // a shop last synced at 10:00:05 is due at the firing near 10:10, not the
    // one near 10:11.
    if (every > 1 && last && last <= nowMs && nowMs - last < every * 60000 - 30000) return;
    out.push(shopId);
  });
  return out.sort();
}

/**
 * How often a shop is synced, from how long ago it was last active. 0 is never.
 *
 * A long tail, because an order does not stop changing when a stream ends.
 * Cancellations arrive the next morning and refunds for weeks — and exports
 * read the Sheet, not TikTok, so a purchase order built before somebody
 * remembered to press Sync counts those units as sold. That is the failure
 * this whole sync exists to prevent, arriving through the back door.
 *
 * It was one gate: every minute for 72 hours after a push, then never. That
 * was too often for the morning after, when nobody is watching a counter
 * tick, and too short for a refund on day four, which was never read at all.
 * So the cadence falls away with the activity instead:
 *
 *   within  6 h   every firing    a broadcast is on; sold is on screen
 *   within 72 h   every 10 min    cancellations and the morning after
 *   within 30 d   every 60 min    returns and refunds of older orders
 *   after that    not at all
 */
function syncEveryMinutes_(sinceActivityMs) {
  var hours = sinceActivityMs / 3600000;
  if (hours <= SYNC_ACTIVE_HOURS) return SYNC_EVERY_MINUTES;
  if (hours <= SYNC_TAIL_HOURS) return SYNC_TAIL_EVERY_MIN;
  if (hours <= SYNC_DORMANT_DAYS * 24) return SYNC_DORMANT_EVERY_MIN;
  return 0;
}

/**
 * When each shop was last active, from Script Properties.
 *
 * Deliberately NOT from the SKUs tab. The gate runs on every firing of the
 * timer — fourteen hundred times a day — and reading a whole tab to decide
 * whether to do nothing is more expensive than the work it is avoiding.
 * `noteShopActivity_` writes one property instead; reading three of them is
 * free. Takes the run's own `getProperties()` snapshot when it has one, so
 * the gate and the sync behind it share one read.
 */
function lastListedAt_(snapshot_) {
  var raw = shopProps_(snapshot_ || PropertiesService.getScriptProperties().getProperties(),
                       LAST_LISTED_PREFIX);
  var out = {};
  Object.keys(raw).forEach(function (id) { out[id] = Number(raw[id]); });
  return out;
}

/** One value per shop under a prefix, from a properties snapshot. */
function shopProps_(snapshot, prefix) {
  var out = {};
  SHOPS.forEach(function (shop) {
    var raw = (snapshot || {})[prefix + shop.id];
    if (raw) out[shop.id] = raw;
  });
  return out;
}

/**
 * Mark a shop as trading, so the background sync watches its orders closely.
 *
 * Stamped on every successful push (`recordSku_`), and meant for any other
 * write that says a shop is mid-broadcast. One property write, so the gate
 * above costs one property read.
 */
function noteShopActivity_(shopId) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty(LAST_LISTED_PREFIX + String(shopId), String(Date.now()));
  } catch (e) {
    // The gate degrades to a slower tier, which is visible as a stale sold
    // count rather than as damage. Never worth failing a push over.
    console.error('could not stamp shop activity: ' + e);
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
 *
 * `sinceEpoch` is the query's lower bound. An order behind it is only proof
 * the filter was ignored once it is more than `toleranceS` behind — see
 * SYNC_FILTER_TOLERANCE_S for why any amount at all was a false alarm.
 */
function changedSince_(orders, sinceEpoch, toleranceS) {
  var slack = toleranceS === undefined || toleranceS === null
    ? SYNC_FILTER_TOLERANCE_S : Number(toleranceS);
  var stale = [];
  var newest = sinceEpoch;
  (orders || []).forEach(function (o) {
    var at = Number(o.update_time || o.create_time || 0);
    if (at && at < sinceEpoch - slack) stale.push(o);
    if (at > newest) newest = at;
  });
  return {
    applied: stale.length === 0,
    stale: stale.length,
    watermark: newest,
    count: (orders || []).length
  };
}

/** When an order or a return last changed, by TikTok's clock. 0 when it does not say. */
function changedAt_(x) {
  return Number((x && (x.update_time || x.create_time)) || 0);
}

/**
 * What came back, minus what we already wrote at exactly that update_time.
 *
 * Pure. The query asks again about the last two minutes on purpose (see
 * SYNC_OVERLAP_S), and even without the overlap its lower bound is inclusive,
 * so the newest order came back on every run until a newer one arrived. Each
 * time it was written again — the lock, the Sheet, and resolveSellerSkus_,
 * which logged TS-ORD-08 for its one unresolvable line 3,747 times, once a
 * minute. An order whose update_time has not moved has not changed, so it is
 * dropped here; one with no time at all is always written, as before.
 */
function dropUnchanged_(items, seen, idField) {
  var memo = seen || {};
  return (items || []).filter(function (x) {
    var at = changedAt_(x);
    return !(at && memo[String(x[idField] || '')] === at);
  });
}

/**
 * The memo after a page: everything on it, plus what was already remembered at
 * or after `floorEpoch`.
 *
 * Pure. The page's own entries are kept whatever their age, because they are
 * what TikTok answered last and so what it may answer again; older ones fall
 * away once the watermark has left them more than the overlap behind, so the
 * memo stays the size of one answer rather than of the order history.
 */
function rememberSeen_(seen, items, idField, floorEpoch) {
  var out = {};
  Object.keys(seen || {}).forEach(function (id) {
    if (Number(seen[id]) >= floorEpoch) out[id] = Number(seen[id]);
  });
  (items || []).forEach(function (x) {
    var id = String(x[idField] || '');
    var at = changedAt_(x);
    if (id && at) out[id] = at;
  });
  return out;
}

/**
 * The memo as stored: newest first, cut to fit a Script Property.
 *
 * Measured here rather than discovered at setProperty, which refuses a value
 * over 9 KB with an exception and leaves the old memo in place. Sorted so the
 * same memo always serialises to the same text: the caller writes only when
 * the text changed, and an unchanged run must write nothing. What is dropped
 * is the OLDEST entries, which are the least likely to be asked about again;
 * dropping one costs at most one rewrite of that order.
 */
function seenText_(seen, maxChars) {
  var ids = Object.keys(seen || {}).sort(function (a, b) {
    return (seen[b] - seen[a]) || (a < b ? -1 : a > b ? 1 : 0);
  });
  var parts = [];
  var length = 2;
  var dropped = 0;
  ids.forEach(function (id) {
    var part = JSON.stringify(id) + ':' + Number(seen[id]);
    if (length + part.length + 1 > maxChars) { dropped++; return; }
    parts.push(part);
    length += part.length + 1;
  });
  return { text: '{' + parts.join(',') + '}', dropped: dropped };
}

/** A JSON property, or null when it is missing or not JSON. Never throws. */
function syncState_(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * One shop's changed orders, written a page at a time.
 *
 * Every page is written as soon as it arrives, and what was covered is saved
 * before the next is asked for, so a run that stops — at SYNC_BUDGET_MS, at a
 * BUSY lock, or killed at six minutes — has kept everything up to its last
 * page, and the next run carries on from there instead of starting again.
 * It used to read every page, then write them all, then throw TS-ORD-02 at
 * sixty, which left a backlog bigger than that unwritten for ever.
 *
 * The watermark itself moves only when the scan reaches its last page. TikTok
 * returns this search newest-CREATED first unless told otherwise, and whether
 * it honours `sort_field=update_time` could not be confirmed (see LIMITS.md).
 * Without that, the newest change on page one says nothing about page two,
 * and moving the watermark to it would skip everything still unread. So an
 * unfinished scan saves its page token instead (SYNC_CURSOR_PREFIX), with the
 * exact bounds it was issued for, and the next run resumes that same query.
 *
 * Returns { fallback: true } when TikTok was found ignoring the filter, and
 * { pending: true } when the budget stopped it with pages still to read.
 */
function syncChangedOrders_(shopId, snapshot, nowEpoch, deadlineMs) {
  var props = PropertiesService.getScriptProperties();
  var markKey = LAST_SYNCED_PREFIX + shopId;
  var seenKey = SYNC_SEEN_PREFIX + shopId;
  var cursorKey = SYNC_CURSOR_PREFIX + shopId;

  var watermark = Number(snapshot[markKey] || 0) || (nowEpoch - SYNC_BACKFILL_MIN * 60);
  var seen = syncState_(snapshot[seenKey]) || {};
  var seenSaved = String(snapshot[seenKey] || '');
  var cursor = syncState_(snapshot[cursorKey]);
  var cursorSaved = Boolean(snapshot[cursorKey]);
  var trimmed = false;

  /**
   * From two minutes behind the watermark, not from it. See SYNC_OVERLAP_S:
   * an order TikTok indexed after we last asked would otherwise sit behind
   * the query for good. What that asks about twice, dropUnchanged_ discards.
   */
  var fresh = function () {
    return { ge: Math.max(0, watermark - SYNC_OVERLAP_S), lt: nowEpoch + 1, token: '', newest: watermark };
  };
  var scan = cursor && cursor.token && Number(cursor.lt) > Number(cursor.ge)
    ? { ge: Number(cursor.ge), lt: Number(cursor.lt), token: String(cursor.token),
        newest: Math.max(watermark, Number(cursor.newest) || 0) }
    : fresh();
  var resuming = Boolean(scan.token);

  while (true) {
    var page;
    try {
      page = ttSearchOrders_(shopId, scan.ge, scan.lt, scan.token, true);
    } catch (e) {
      if (!resuming) throw e;
      /**
       * A saved page TikTok will not continue from.
       *
       * How long a page token stays good is not documented anywhere we have
       * found. One that has lapsed costs a re-read from the watermark, which
       * is what every run did before tokens were saved — never a gap.
       */
      warn_('TS-ORD-35', shopId + ': could not resume the saved order scan, so it starts ' +
        'again from the watermark. Reason: ' + (e && e.message ? e.message : e), shopId);
      props.deleteProperty(cursorKey);
      cursorSaved = false;
      scan = fresh();
      resuming = false;
      continue;
    }
    resuming = false;

    var check = changedSince_(page.orders, scan.ge);
    if (!check.applied) {
      // A scan built on an ignored filter is not worth resuming.
      if (cursorSaved) props.deleteProperty(cursorKey);
      return { fallback: true, stale: check.stale };
    }

    // Nothing changed: no Sheet is opened, nothing is written, and no lock is
    // taken. Which is the whole point of the question being "what changed"
    // rather than "what exists".
    var changed = dropUnchanged_(page.orders, seen, 'id');
    if (changed.length) writeOrders_(shopId, changed, 'background sync');

    if (check.watermark > scan.newest) scan.newest = check.watermark;
    seen = rememberSeen_(seen, page.orders, 'id', Math.max(watermark, scan.newest) - SYNC_OVERLAP_S);
    var stored = seenText_(seen, SYNC_STATE_MAX_CHARS);
    if (stored.dropped && !trimmed) {
      trimmed = true;
      warn_('TS-ORD-36', shopId + ': ' + stored.dropped + ' order(s) left out of the sync memo, ' +
        'which is capped at ' + SYNC_STATE_MAX_CHARS + ' characters. They may be written once more.', shopId);
    }
    if (stored.text !== seenSaved) {
      props.setProperty(seenKey, stored.text);
      seenSaved = stored.text;
    }

    if (!page.nextPageToken) break;
    scan.token = page.nextPageToken;

    var text = JSON.stringify(scan);
    if (text.length <= SYNC_STATE_MAX_CHARS) {
      props.setProperty(cursorKey, text);
      cursorSaved = true;
    } else {
      // Not resumable, so the next run starts this scan again. Slower, never a gap.
      warn_('TS-ORD-37', shopId + ': the order scan\'s page token is ' + text.length +
        ' characters, too long to save; the next run starts the scan again.', shopId);
      if (cursorSaved) props.deleteProperty(cursorKey);
      cursorSaved = false;
    }

    if (Date.now() >= deadlineMs) {
      var next = cursorSaved ? 'carries on from the same page' : 'starts the scan again';
      warn_('TS-ORD-34', shopId + ': more orders changed than one run can read. Stopped at ' +
        Math.round(SYNC_BUDGET_MS / 60000) + ' minutes with everything read so far written; ' +
        'the next run ' + next + '.', shopId);
      return { pending: true };
    }
  }

  // The last page: everything changed since the watermark has been read and
  // written, so — and only now — the watermark moves.
  if (scan.newest > watermark) props.setProperty(markKey, String(scan.newest));
  if (cursorSaved) props.deleteProperty(cursorKey);
  return {};
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
   * It lives for those six minutes, not five: a run that works through a
   * backlog now uses SYNC_BUDGET_MS and the returns pass after it on purpose,
   * and a guard that lapsed first would let a second run resume the same
   * saved page alongside it.
   */
  var guard = null;
  try {
    guard = CacheService.getScriptCache();
    if (guard && guard.get('sync_running')) return;
    if (guard) guard.put('sync_running', '1', 360);
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
  var startedMs = Date.now();
  var snapshot;
  var shops;
  try {
    // One read for the whole run: the gate, every watermark, every memo.
    snapshot = PropertiesService.getScriptProperties().getProperties();
    shops = shopsToSync_(lastListedAt_(snapshot), startedMs,
                         shopProps_(snapshot, LAST_SYNC_RUN_PREFIX),
                         shopProps_(snapshot, SYNC_CURSOR_PREFIX));
  } catch (e) {
    warn_('TS-ORD-23', 'Background sync could not read its activity marks: ' + e);
    return;
  }
  // The common case, and it must cost almost nothing: one property read and
  // a return. Every minute, all day, every day.
  if (!shops.length) return;

  var props = PropertiesService.getScriptProperties();
  var nowEpoch = Math.floor(startedMs / 1000);
  var deadlineMs = startedMs + SYNC_BUDGET_MS;

  shops.forEach(function (shopId) {
    try {
      // Stamped before the work, so a shop whose sync keeps failing is still
      // retried at its tier's pace rather than on every firing.
      props.setProperty(LAST_SYNC_RUN_PREFIX + shopId, String(Date.now()));

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
      var orders = syncChangedOrders_(shopId, snapshot, nowEpoch, deadlineMs);

      if (orders.fallback) {
        /**
         * The filter was ignored, so what came back is not what was asked
         * for. The watermark does not move on it, and this shop falls back to
         * the creation-time window for this run — correct, just more
         * expensive. The returns pass below still runs: it is a different
         * endpoint with its own filter, and skipping it here left refunds
         * unread on exactly the runs that were already going wrong.
         */
        warn_('TS-ORD-25', shopId + ': update_time filter not applied (' + orders.stale +
          ' order(s) more than ' + SYNC_FILTER_TOLERANCE_S + 's older than the query\'s lower ' +
          'bound). Falling back to creation time.');
        var from = new Date((nowEpoch - SYNC_WINDOW_MIN * 60) * 1000);
        var to = new Date(nowEpoch * 1000);
        var d = function (x) { return Utilities.formatDate(x, 'Asia/Singapore', 'yyyy-MM-dd'); };
        var t = function (x) { return Utilities.formatDate(x, 'Asia/Singapore', 'HH:mm'); };
        syncOrders_(shopId, d(from), d(from) === d(to) ? t(from) : '00:00', d(to), t(to),
                    'background sync');
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
        var returnsSeenKey = RETURNS_SEEN_PREFIX + shopId;
        var returnsMark = Number(snapshot[returnsKey] || 0);
        // The same overlap as the orders pass, for the same reason: a return
        // indexed late must not fall behind a query that has moved past it.
        var returnsSince = returnsMark
          ? returnsMark - SYNC_OVERLAP_S
          : nowEpoch - SYNC_RETURNS_BACKFILL_H * 3600;
        var returnsSeen = syncState_(snapshot[returnsSeenKey]) || {};
        var ret = syncReturns_(shopId, returnsSince, 'background sync', returnsSeen);
        /**
         * The watermark only moves over ground actually covered.
         *
         * It moved to now unconditionally, including after the 60-page guard
         * had stopped the scan early — so every refund past that point was
         * never asked for again, and stayed counted as SOLD in every export
         * from then on. A refund silently counted as a sale is money paid to a
         * factory for goods the buyer gave back.
         *
         * Leaving it put means the next run re-reads the same window. If the
         * backlog is genuinely that large it stays put and keeps warning,
         * which is visible; advancing loses the refunds silently, which is not.
         *
         * And it moves to the newest change SEEN, not to the clock. This query
         * has no upper bound, so any return TikTok had indexed with a later
         * stamp than that one was in the answer, and anything that changes
         * afterwards is stamped later still. The filter compares TikTok's
         * clock, not ours, and ours can disagree with it; the stamp on a
         * return we have already read cannot. The price is the boundary
         * return coming back on every run, which the memo turns into nothing
         * written.
         */
        if (!ret.truncated) {
          var nextMark = Math.max(returnsMark, ret.newest);
          if (nextMark > returnsMark) props.setProperty(returnsKey, String(nextMark));
          var keptReturns = seenText_(
            rememberSeen_(returnsSeen, ret.read, 'return_id', nextMark - SYNC_OVERLAP_S),
            SYNC_STATE_MAX_CHARS);
          if (keptReturns.dropped) {
            warn_('TS-ORD-38', shopId + ': ' + keptReturns.dropped + ' return(s) left out of the ' +
              'returns memo, which is capped at ' + SYNC_STATE_MAX_CHARS + ' characters. ' +
              'They may be written once more.', shopId);
          }
          if (keptReturns.text !== String(snapshot[returnsSeenKey] || '')) {
            props.setProperty(returnsSeenKey, keptReturns.text);
          }
        }
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

/**
 * Pull returns changed since the watermark into the Returns tab.
 *
 * `seen_` is the memo of returns already written (see dropUnchanged_): one
 * whose update_time has not moved is read and not written. Returns what was
 * read and the newest change in it, for the caller's watermark and memo.
 */
function syncReturns_(shopId, sinceEpoch, actor, seen_) {
  var all = [];
  var token = '';
  var pages = 0;
  var truncated = false;
  do {
    var page = ttSearchReturns_(shopId, sinceEpoch, token);
    all = all.concat(page.returns);
    token = page.nextPageToken;
    pages++;
    if (pages >= 60 && token) {
      truncated = true;
      warn_('TS-ORD-29', shopId + ': more than ' + (60 * ORDER_PAGE_SIZE) +
        ' returns changed since ' + sinceEpoch + '; stopping and keeping what was read. ' +
        'The watermark is NOT advanced, so the rest is read on the next run.');
      break;
    }
  } while (token);

  var newest = 0;
  all.forEach(function (ret) { newest = Math.max(newest, changedAt_(ret)); });

  var rows = returnRows_(shopId, dropUnchanged_(all, seen_, 'return_id'), new Date().toISOString());
  if (rows.length) {
    withScriptLock_(30000, function () {
      replaceByKey_(TAB_RETURNS, 'return_line_item_id', rows);
    });
    logEvent_(actor, 'sync_returns', shopId, rows.length + ' return line(s)', 'ok');
  }
  return { returns: all.length, lines: rows.length, truncated: truncated, newest: newest, read: all };
}

// ── reconciliation ────────────────────────────────────────────────────

/**
 * Orders this app has recorded that TikTok is no longer returning.
 *
 * `replaceByKey_` only ever touches keys present in the incoming batch. There
 * is no delete pass and no tombstone, so an order that drops out of TikTok's
 * results stays in the Sheet at its last-seen status FOREVER — and if that
 * status was a selling one, its units are counted as sold in every export made
 * from then on. Nothing reconciled the Sheet against TikTok and nothing aged a
 * row out.
 *
 * Pure, so the comparison can be asserted without the network.
 *
 * It reports rather than decides, and that is deliberate. An order TikTok does
 * not return may have been cancelled and dropped — in which case counting it
 * as sold overpays — or may simply be absent from that particular response, in
 * which case removing it underpays. Both are wrong and this function cannot
 * tell which, so it names them and leaves the judgement to someone who can.
 */
function ordersMissingFromTikTok_(sheetOrderIds, tiktokOrderIds) {
  var live = {};
  (tiktokOrderIds || []).forEach(function (id) { if (id) live[String(id)] = true; });
  var missing = [];
  var seen = {};
  (sheetOrderIds || []).forEach(function (id) {
    var key = String(id || '');
    if (!key || seen[key]) return;
    seen[key] = true;
    if (!live[key]) missing.push(key);
  });
  return missing;
}

/**
 * Check a window's recorded orders against TikTok, at the moment it matters.
 *
 * At export time rather than on a timer. An export IS the moment the number
 * decides what a factory is paid, it already takes minutes, and a check that
 * runs then cannot be forgotten — whereas a nightly one can have been failing
 * for a week before anyone builds a purchase order.
 *
 * Asks by creation time, which is the same window the export uses, so the two
 * are comparing the same thing.
 */
function reconcileWindow_(shopId, fromEpoch, toEpoch) {
  var recorded = readAll_(TAB_ORDER_ITEMS).filter(function (r) {
    if (String(r.shop_id) !== String(shopId)) return false;
    var t = Number(r.created_epoch || 0);
    // An undated row cannot be placed in a window, so it cannot be judged
    // missing from one either.
    if (!t) return false;
    return t >= fromEpoch && t < toEpoch;
  });
  if (!recorded.length) return { checked: 0, missing: [], units: 0 };

  var live = ttAllOrders_(shopId, fromEpoch, toEpoch).map(function (o) { return String(o.id || ''); });
  var missing = ordersMissingFromTikTok_(
    recorded.map(function (r) { return r.order_id; }), live);

  var gone = {};
  missing.forEach(function (id) { gone[id] = true; });
  var units = recorded.filter(function (r) {
    return gone[String(r.order_id)] && lineStatusMeaning_(r.status) === 'sold';
  }).length;

  if (missing.length) {
    warn_('TS-ORD-32', shopId + ': ' + missing.length + ' recorded order(s) are not in ' +
      'TikTok\'s list for this window, carrying ' + units + ' unit(s) still counted as sold. ' +
      'They may have been cancelled and dropped, or may simply be absent from this ' +
      'response — check before paying on them. Orders: ' + missing.slice(0, 20).join(', ') +
      (missing.length > 20 ? ' and ' + (missing.length - 20) + ' more' : ''));
  }

  return { checked: recorded.length, missing: missing, units: units };
}
