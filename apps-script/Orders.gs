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
    orders.length + ' orders ' + fromDate + ' to ' + toDate, 'ok');

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

  return {
    listings: listings,
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
 * The line items behind one listing's total, inside the same window.
 *
 * Grouped by variation, because that is what a factory is being asked to
 * supply — a list of two hundred order rows is not a purchase order, and
 * "A7 × 14" is.
 */
function listingOrders_(listingId, fromDate, fromTime, toDate, toTime) {
  var fromEpoch = sgtEpoch_(fromDate, fromTime || '00:00');
  var toEpoch = sgtEndEpoch_(toDate, toTime);

  var items = readAll_(TAB_ORDER_ITEMS).filter(function (r) {
    if (String(r.listing_id) !== String(listingId)) return false;
    var t = Number(r.created_epoch || 0);
    return t >= fromEpoch && t < toEpoch;
  });

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
    var qty = Number(r.quantity || 0);
    if (UNSOLD_STATUSES[String(r.status || '').toUpperCase()]) {
      g.unsold_units += qty;
    } else {
      g.units += qty;
      g.revenue += Number(r.sale_price || 0) * qty;
    }
  });

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
