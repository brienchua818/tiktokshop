/**
 * Listing a product on TikTok.
 *
 * Order of operations matters — it is what avoids the two commonest failures:
 *   1. resolve a LEAF category (products cannot be created in a branch),
 *   2. fetch that category's mandatory attributes and fill them,
 *   3. dry-run with listing_check, so problems are named before they cost a
 *      slot against the daily upload cap,
 *   4. create.
 */

/** English-only, 25-255 characters. Both are TikTok's rules for Singapore. */
function validateTitle_(title) {
  var t = String(title || '').trim();
  if (!t) return 'Title is required.';
  if (t.length < TITLE_MIN) {
    return 'Title must be at least ' + TITLE_MIN + ' characters for Singapore — this is ' +
      t.length + '. TikTok rejects anything shorter.';
  }
  if (t.length > TITLE_MAX) return 'Title must be at most ' + TITLE_MAX + ' characters.';
  // ASCII control characters, including DEL. Checked before the English rule
  // so the message names the actual problem — the rule below would also catch
  // these, but would report them as "not English", which sends someone looking
  // for a Chinese character that is not there.
  if (/[\u0000-\u001F\u007F]/.test(t)) return 'Title contains control characters.';
  // HTML entities such as &nbsp;. Forbidden by 12052931, and invisible to
  // every other rule here: the characters are all plain ASCII, so without this
  // check a title carrying one is accepted locally and refused by TikTok.
  if (/&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/.test(t)) {
    return 'Title contains an HTML entity such as &nbsp; — write the character itself.';
  }
  // Anything outside Latin-1 plus common punctuation: catches Chinese, which
  // TikTok refuses in product names, and emoji.
  if (/[^\u0020-\u024F\u2018\u2019\u201C\u201D\u2013\u2014]/.test(t)) {
    return 'Title must be English. TikTok rejects Chinese characters and emoji in product names.';
  }
  if (!/[a-zA-Z0-9]/.test(t)) return 'Title cannot be only symbols.';
  if (/(.)\1{9,}/.test(t)) return 'Title repeats one character more than nine times in a row.';
  return '';
}

/**
 * Upload a photo and return its TikTok uri.
 *
 * The use case matters and is not interchangeable. TikTok issues a separate
 * uri per use case and refuses one in the other's place:
 *
 *   MAIN_IMAGE       the product hero, used when a listing is created
 *   ATTRIBUTE_IMAGE  the photo shown against a variation in the buyer's
 *                    options gallery, which is where every SKU after the
 *                    first appears
 *
 * So the same JPEG is uploaded twice on the SKU that creates a listing.
 */
function ttUploadImage_(prefix, blob, useCase) {
  return ttImageFrom_(ttFetch_(prefix, 'post', '/product/202309/images/upload',
    { use_case: useCase || 'MAIN_IMAGE' }, blob));
}

/** The image upload, built but not sent — so it can share a round trip. */
function ttImageRequest_(prefix, blob, useCase) {
  return ttRequest_(prefix, 'post', '/product/202309/images/upload',
    { use_case: useCase || 'MAIN_IMAGE' }, blob);
}

function ttImageFrom_(r) {
  if (r.code !== 0) throw fail_('TS-PRD-01', 'Image upload failed: ' + ttReason_(r));
  return r.data.uri;
}

/**
 * The buyer-visible name for a variation.
 *
 * Leads with the identifier on purpose: in a factory livestream the host says
 * "A7 is the blue one" and the buyer looks for A7 in the variant picker, so the
 * identifier is the shared vocabulary of the whole broadcast. Capped at
 * TikTok's 50 characters, at a word boundary where one is available.
 */
/**
 * The stored variant name with its identifier taken back off the front.
 *
 * `variantValueName_` puts the identifier on when a variation is listed, and
 * the Sheet records the result. Feeding that back through it would produce
 * "B74 B74 4 tier" — a restored variation renamed by the act of restoring it.
 */
function strippedVariantName_(stored, identifier) {
  var name = String(stored || '').trim();
  var id = String(identifier || '').trim();
  if (!id) return name;
  if (name.toUpperCase().indexOf(id.toUpperCase() + ' ') === 0) {
    return name.slice(id.length + 1).trim();
  }
  if (name.toUpperCase() === id.toUpperCase()) return '';
  return name;
}

function variantValueName_(identifier, variantName) {
  var name = String(variantName || '').trim().replace(/\s+/g, ' ');
  var combined = name ? identifier + ' ' + name : String(identifier);
  if (combined.length <= VALUE_NAME_MAX) return combined;
  var clipped = combined.slice(0, VALUE_NAME_MAX);
  var lastSpace = clipped.lastIndexOf(' ');
  return lastSpace > VALUE_NAME_MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped.replace(/\s+$/, '');
}

/**
 * Validate a variant name — the buyer-visible name of one variation.
 *
 * Deliberately NOT validateTitle_. A product title and a variant name are
 * different fields with different rules, and conflating them was a real bug:
 * a title floors at 25 characters and caps at 255, a variant name has no
 * minimum and caps at 50. So "Blue Mug" is perfectly valid here and was being
 * rejected.
 *
 * The character rules are shared, because TikTok polices them identically in
 * both places — 12052243 rejects Chinese in a sales-attribute name just as
 * 12052262 rejects it in a product name.
 */
function validateVariantName_(name) {
  var n = String(name || '').trim();
  if (!n) return 'Variant name is required.';
  if (n.length > VALUE_NAME_MAX) {
    return 'Variant name must be at most ' + VALUE_NAME_MAX + ' characters — this is ' +
      n.length + '.';
  }
  if (/[\u0000-\u001F\u007F]/.test(n)) return 'Variant name contains control characters.';
  if (/&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/.test(n)) {
    return 'Variant name contains an HTML entity such as &nbsp; — write the character itself.';
  }
  if (/[^\u0020-\u024F\u2018\u2019\u201C\u201D\u2013\u2014]/.test(n)) {
    return 'Variant name must be English. TikTok rejects Chinese characters and emoji here.';
  }
  if (!/[a-zA-Z0-9]/.test(n)) return 'Variant name cannot be only symbols.';
  if (/(.)\1{9,}/.test(n)) {
    return 'Variant name repeats one character more than nine times in a row.';
  }
  return '';
}

/**
 * The title for a continuation listing.
 *
 * Singapore caps a product at 100 variations, so a long factory run spills
 * into a second listing. That listing needs a product title, and the one thing
 * it must not need is for someone to invent one mid-broadcast — so it is
 * derived from the listing it continues.
 *
 * An existing "(2)" is incremented rather than stacked, because a 300-SKU run
 * produces a third listing and "Ceramic Run (2) (2)" is nobody's idea of a
 * product name.
 */
function continuationTitle_(parentTitle) {
  var title = String(parentTitle || '').trim();
  var match = /^(.*?)\s*\((\d+)\)$/.exec(title);
  var base = match ? match[1].replace(/\s+$/, '') : title;
  var next = match ? parseInt(match[2], 10) + 1 : 2;
  var suffix = ' (' + next + ')';
  var room = TITLE_MAX - suffix.length;
  if (base.length > room) base = base.slice(0, room).replace(/\s+$/, '');
  return base + suffix;
}

/**
 * Read a product and its variations.
 *
 * Called immediately before every edit, and its result is the only safe basis
 * for one — see buildAppendPayload_ for why a cached snapshot is worse than
 * no snapshot at all.
 *
 * Note the price translation. Get Product returns `price.sale_price`; every
 * write endpoint takes `price.amount`. Reading one and writing the other
 * blanks the price of every existing variation, so it happens once, here.
 */
/**
 * The displayable URL for a variation's photo, from a Get Product response.
 *
 * TikTok's public CDN copy is the one URL a phone can show without any
 * credential, so it is what the queue uses for a variation it has no local
 * photo for: listed from another phone, or added in Seller Center.
 *
 * This read `sku_img.url_list[0]` for a fortnight, which is the **202306**
 * spelling. The 202309 response has no `url_list` at all — `sku_img` is
 * `{height, thumb_urls, uri, urls, width}` — so the value was ALWAYS an empty
 * string and every variation a device had not photographed itself rendered a
 * grey square. That is L1 to L12 on Brien's screen on 7 Sep.
 *
 * `thumb_urls` first, because it is a 300px resize of a few kilobytes and a
 * listing carries twenty-five of them onto a phone on mobile data. `urls` is
 * the full-size fallback.
 *
 * Note what is deliberately NOT a fallback: the Sheet's `photo_thumb_url`.
 * It is `DriveApp.getUrl()`, a Drive *viewer page* rather than an image, so
 * putting it in an `<img>` renders nothing at all. Serving our own copy needs
 * the bytes served, which is separate work — see the note in the vault.
 *
 * A function rather than three lines inline so it can be tested, which is the
 * only reason the old spelling survived so long: nothing could assert it.
 */
function skuImageUrl_(attribute) {
  var img = attribute && attribute.sku_img;
  if (!img) return '';
  if (img.thumb_urls && img.thumb_urls.length && img.thumb_urls[0]) return String(img.thumb_urls[0]);
  if (img.urls && img.urls.length && img.urls[0]) return String(img.urls[0]);
  return '';
}

function ttGetProduct_(prefix, productId) {
  /**
   * `return_under_review_version` decides which product you are shown, and the
   * default is the wrong one for this app.
   *
   * TikTok's reference, verbatim: true returns "the latest version of the
   * product information that is currently under review"; false returns "a
   * snapshot of the product information that is live and online (before the
   * edit)". It was never set, so every read took the pre-edit snapshot.
   *
   * Adding a variation sends the WHOLE product back through review, so during
   * a livestream this product is permanently mid-review and every read lagged
   * behind reality. Brien's stream on 15 Sep: pushes that were live not
   * appearing, variations badged "Reviewing" minutes after going live, and a
   * removal that the list refused to reflect. All three are this one flag.
   *
   * It was also destroying data. A variation seen once and then missing from
   * the lagging snapshot was marked `removed`; a removed row is excluded from
   * the carry-forward that protects it; and TikTok deletes any SKU absent from
   * a partial edit. So a variation that was merely pending could be marked
   * gone and then actually deleted on the next push.
   */
  return ttGetProductVersion_(prefix, productId, true);
}

/**
 * One version of the product. `underReview` decides WHICH.
 *
 * TikTok's reference, verbatim: true returns "the latest version of the
 * product information that is currently under review"; false returns "a
 * snapshot of the product information that is live and online (before the
 * edit)".
 *
 * They answer different questions and the app needs both. "Is this variation
 * still there, and what must I carry forward so a partial edit does not delete
 * it?" is the under-review version. "Can a buyer buy this right now, and how
 * many are left?" is the live one — and reading the under-review version for
 * that is why the app told Brien a variation was Live while TikTok was still
 * reviewing it (15 Sep).
 *
 * Writes keep using the under-review version, which is the latest state and
 * what partial_edit rebuilds from.
 */
/** The product read, built but not sent — so it can share a round trip. */
function ttProductRequest_(prefix, productId, underReview) {
  return ttRequest_(prefix, 'get', '/product/202309/products/' + productId,
    { category_version: CATEGORY_VERSION,
      return_under_review_version: underReview ? 'true' : 'false' }, null);
}

function ttGetProductVersion_(prefix, productId, underReview) {
  var r = ttFetch_(prefix, 'get', '/product/202309/products/' + productId,
    { category_version: CATEGORY_VERSION,
      return_under_review_version: underReview ? 'true' : 'false' }, null);
  return ttProductFrom_(r, productId);
}

/** A product read's answer, as the rest of the app reads a product. */
function ttProductFrom_(r, productId) {
  if (r.code !== 0 || !r.data) {
    throw fail_('TS-PRD-02', 'Could not read the listing: ' + ttReason_(r));
  }
  var skus = (r.data.skus || []).map(function (raw) {
    var attribute = (raw.sales_attributes || [])[0] || {};
    var inventory = (raw.inventory || [])[0] || {};
    return {
      id: raw.id || '',
      sellerSku: raw.seller_sku || '',
      attributeId: attribute.id || '',
      attributeName: attribute.name || '',
      valueId: attribute.value_id || '',
      valueName: attribute.value_name || '',
      skuImgUri: (attribute.sku_img && attribute.sku_img.uri) || '',
      skuImgUrl: skuImageUrl_(attribute),
      priceAmount: String((raw.price && (raw.price.sale_price || raw.price.amount)) || ''),
      quantity: Number(inventory.quantity || 0),
      warehouseId: inventory.warehouse_id || '',
      /**
       * Every warehouse on this SKU, not just the first.
       *
       * A stock write has to echo the whole array back. TikTok's rule: "You
       * must include all warehouse IDs assigned to this SKU, along with the
       * respective quantity. Do not omit any or add unrelated warehouses",
       * enforced by 12019028, 12052037 and 12052533. `quantity` and
       * `warehouseId` above stay as the first warehouse, because that is what
       * every existing caller means by "the stock", and Singapore listings
       * here have one.
       */
      inventories: (raw.inventory || []).map(function (inv) {
        return { warehouse_id: String(inv.warehouse_id || ''), quantity: Number(inv.quantity || 0) };
      })
    };
  });
  return {
    productId: r.data.id || productId,
    title: r.data.title || '',
    // TikTok re-reviews the whole product on every edit, so this changes each
    // time a variation is added. Carried out of here rather than discarded,
    // because otherwise the only way to know whether a push actually landed is
    // to open Seller Center.
    status: r.data.status || '',
    auditReasons: auditReasons_(r.data),
    /**
     * The product's own main image, kept so an edit can fill a gap it did not
     * create. See `withVariantImages_`.
     */
    mainImageUri: (((r.data.main_images || [])[0]) || {}).uri || '',
    skus: skus
  };
}

/**
 * Every listed variant must carry an image, including ones we did not list.
 *
 * TikTok, 12052522: *"a main image URI is missing for one or more listed
 * product variants. Upload an image with use_case=ATTRIBUTE_IMAGE, set the
 * returned URI for every listed variant, and retry."* It applies to the WHOLE
 * payload, and an append has to send every existing SKU back — so one
 * variation without a photo makes every future append from this app fail.
 *
 * A7, HOUZE, 23 Sep: a variation called "test 1" had been added in Seller
 * Center with no attribute image. Seller Center allowed it; the API will not
 * round-trip it. The listing was permanently unappendable, and nothing in the
 * app said why.
 *
 * The gap is filled with the PRODUCT'S OWN main image. Brien's call, and the
 * defensible one: it is the same product, so it is not a wrong picture, where
 * using the incoming variant's photo would put one product's picture on
 * another. Logged every time, because it does change what a buyer sees on a
 * variation somebody else created and there is no way back to "no image".
 *
 * Returns the count filled so the caller can report it.
 */
function withVariantImages_(skus, mainImageUri, listingId) {
  var filled = [];
  skus.forEach(function (sku) {
    var attribute = (sku.sales_attributes || [])[0];
    if (!attribute) return;
    if (attribute.sku_img && attribute.sku_img.uri) return;
    if (!mainImageUri) return;
    attribute.sku_img = { uri: mainImageUri };
    filled.push(attribute.value_name || attribute.value_id || sku.seller_sku || '(unnamed)');
  });
  if (filled.length) {
    warn_('TS-PRD-38', 'On ' + listingId + ', ' + filled.length + ' existing variation(s) had no ' +
      'photo and TikTok refuses an edit without one on every variant: ' + filled.join(', ') +
      '. They were given the listing\u2019s own main image so this push could go through. ' +
      'Set a proper photo in Seller Center if a different one is wanted.');
  }
  return filled;
}

/**
 * Why a listing was rejected, flattened into readable lines.
 *
 * The shape TikTok uses nests reasons under positions, which is right for a
 * form that can highlight fields and useless on a phone. Reading defensively
 * because a rejection is exactly when a missing field would be least welcome.
 */
function auditReasons_(data) {
  var out = [];
  var groups = (data && data.audit_failed_reasons) || [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i] || {};
    var reasons = g.reasons || [];
    for (var j = 0; j < reasons.length; j++) {
      var line = String(reasons[j] || '').trim();
      if (line) out.push(g.position ? g.position + ': ' + line : line);
    }
    var tips = g.suggestions || [];
    for (var k = 0; k < tips.length; k++) {
      var tip = String(tips[k] || '').trim();
      if (tip) out.push('Fix: ' + tip);
    }
  }
  return out;
}

/**
 * What a listing looks like on TikTok right now, per variation.
 *
 * Answers the three questions that otherwise mean opening Seller Center: has
 * the push landed, is the variation live or still under review, and how much
 * stock is left.
 *
 * `sold` is `set - available`, not a figure TikTok reports. The product API has
 * no sold count — that lives in orders — but we know what we asked for and it
 * tells us what remains, so the difference is sound unless someone edits stock
 * in Seller Center. Labelled as derived in the UI rather than presented as
 * TikTok's own number.
 */
/**
 * What the screen shows as ours, by identifier.
 *
 * The invariant this exists to hold: **every SKU TikTok is showing appears
 * on the screen exactly once.** A live variation is either rendered from our
 * own row, or — if we have no row that renders — rendered as an external.
 * Never neither.
 *
 * It used to be built from EVERY row, while only `pushed` rows are actually
 * rendered. So any row in another state suppressed the external fallback for
 * an identifier it then did not draw, and the variation vanished from a
 * listing TikTok was serving. Brien, 15 Sep: Seller Center showed B74, B75
 * and A2 on I12; the app drew A2 alone and its own header said 3/100 next to
 * a list of one.
 *
 * Keyed on `seller_sku`, which is the identifier this app assigns and the
 * only field both sides agree on before a push returns.
 */
function shownAsOurs_(rows) {
  var shown = {};
  rows.forEach(function (r) {
    if (String(r.status) === 'pushed') shown[String(r.identifier)] = true;
  });
  return shown;
}

/**
 * Reconcile our rows against what TikTok is showing, and say what to write.
 *
 * Pure so it can be tested: the decision it makes can delete a livestream's
 * back catalogue. A row marked removed is dropped from the carry-forward, and
 * TikTok deletes any SKU absent from a partial edit, so a wrong mark here does
 * not merely mis-draw a screen — it really deletes.
 *
 * Two directions, and the second one was missing entirely:
 *
 *  - **Seen.** The id is stored if it was missing (rows written before that
 *    field existed repair themselves), and the first sighting is stamped.
 *
 *  - **Seen, having been marked removed.** TikTok is showing it, so it is on
 *    the listing, whatever we concluded before. The mark is lifted. Without
 *    this, `removed` was a one-way door: the loop skipped any row that was not
 *    `pushed`, so a variation wrongly marked — by a read taken before
 *    `return_under_review_version` was set, or inside a grace period that was
 *    too short for a slow review — could never come back, even with TikTok
 *    serving it on the live product.
 *
 *  - **Gone.** Confirmed once and absent now: deleted, in Seller Center or
 *    here. Marked only after a grace period, because a variation pushed
 *    seconds ago can briefly be in neither the live nor the under-review
 *    version.
 */
function skuRowUpdates_(rows, liveSkus, nowIso, nowMs) {
  var live = {};
  (liveSkus || []).forEach(function (s) {
    if (s && s.sellerSku) live[String(s.sellerSku)] = s;
  });

  var updates = [];
  (rows || []).forEach(function (r) {
    var status = String(r.status);
    if (status !== 'pushed' && status !== 'removed') return;

    var found = live[String(r.identifier)];

    if (found) {
      var patch = { sku_id: String(r.sku_id) };
      var changed = false;
      // TikTok is showing it. It is not removed, and saying so is the whole
      // point of this branch accepting a removed row at all.
      if (status === 'removed') {
        patch.status = 'pushed';
        patch.error = '';
        changed = true;
      }
      if (found.id && !String(r.tiktok_sku_id || '')) {
        patch.tiktok_sku_id = String(found.id);
        changed = true;
      }
      if (!String(r.confirmed_at || '')) {
        patch.confirmed_at = nowIso;
        changed = true;
      }
      if (changed) updates.push(patch);
      return;
    }

    // Already marked and still absent: nothing to say.
    if (status === 'removed') return;

    var seenAt = Date.parse(isoOf_(r.confirmed_at));
    if (!isNaN(seenAt) && nowMs - seenAt > REMOVAL_GRACE_MS) {
      updates.push({ sku_id: String(r.sku_id), status: 'removed',
        error: 'Removed from TikTok', removed_at: new Date().toISOString() });
    }
  });
  return updates;
}

/**
 * What a variation actually IS, from both versions of the product.
 *
 * Pure, because this is the fact the whole screen is built on and Brien named
 * it the one that must be right: *"the pending, reviewing and live
 * confirmation is very impt for us during the livestream"*.
 *
 * Four states, and the difference between the first two is the difference
 * between a buyer being able to buy it and not:
 *
 *   live       — in the version TikTok serves to buyers. Buyable now.
 *   reviewing  — in the pending version only. TikTok has it, nobody can buy it.
 *   pending    — in neither, but TikTok issued us a sku id when we created it.
 *                Genuinely in flight; not lost.
 *   not_listed — in neither, and no id. We have no evidence TikTok ever took it.
 *
 * The old code had one version and one flag, so "in the pending version"
 * and "buyable" were the same thing — which is why the app said Live while
 * TikTok was still reviewing.
 *
 * `quantity` comes from the LIVE version only. A pending variation has no
 * meaningful "left": nothing can be sold from it yet, and reporting the
 * pending number as stock invites someone to count on it.
 */
function variationState_(identifier, tiktokSkuId, liveSku, pendingSku) {
  if (liveSku) {
    return {
      state: 'live',
      on_tiktok: true,
      buyable: true,
      sku: liveSku,
      quantity: Number(liveSku.quantity || 0)
    };
  }
  if (pendingSku) {
    return {
      state: 'reviewing',
      on_tiktok: true,
      buyable: false,
      sku: pendingSku,
      quantity: null
    };
  }
  if (String(tiktokSkuId || '')) {
    return { state: 'pending', on_tiktok: false, buyable: false, sku: null, quantity: null };
  }
  return { state: 'not_listed', on_tiktok: false, buyable: false, sku: null, quantity: null };
}

/** Index a version's SKUs by seller_sku, the only key both sides agree on. */
function bySellerSku_(skus) {
  var out = {};
  (skus || []).forEach(function (sku) {
    if (sku && sku.sellerSku) out[String(sku.sellerSku)] = sku;
  });
  return out;
}

function listingState_(listingId) {
  /**
   * Read once.
   *
   * `listSkus_` is `readAll_(TAB_SKUS)` filtered in memory — it reads EVERY
   * SKU row ever written, across every listing and every shop. This function
   * called it three times per refresh, so one tap re-read the whole history
   * three times over. After a few hundred SKUs that is the "slow and heavy"
   * Brien reported on 15 Sep, and it has nothing to do with how many rows are
   * on this listing.
   */
  var rows = listSkus_(listingId);
  var shopId = rows.length ? String(rows[0].shop_id) : '';
  if (!shopId) {
    var listing = readAll_(TAB_LISTINGS).filter(function (r) {
      return String(r.listing_id) === String(listingId);
    })[0];
    shopId = listing ? String(listing.shop_id) : '';
  }
  if (!shopId) throw fail_('TS-PRD-03', 'Unknown listing: ' + listingId);

  /**
   * Both versions, because they answer different questions.
   *
   * `pending` is the latest state — what exists, including anything still in
   * review — and is what the removal rule and the carry-forward must use, or a
   * variation waiting for approval reads as gone and the next push deletes it.
   *
   * `buyable` is what TikTok serves to buyers, and is the only thing that may
   * be called Live. Reading one version for both is why the app told Brien a
   * variation was Live while TikTok was still reviewing it.
   *
   * The live read is allowed to fail on its own: a product that has never been
   * approved has no live version at all, and that is a legitimate answer
   * ("nothing is buyable yet"), not an error worth failing the whole screen
   * over.
   */
  var live = ttGetProductVersion_(shopId, String(listingId), true);
  var buyable = null;
  try {
    buyable = ttGetProductVersion_(shopId, String(listingId), false);
  } catch (e) {
    warn_('TS-PRD-33', 'No live version for ' + listingId + ' (nothing buyable yet): ' + e);
  }
  var liveSkus = bySellerSku_(buyable ? buyable.skus : []);
  var pendingSkus = bySellerSku_(live.skus);

  /**
   * Record what TikTok is showing, and what it has stopped showing.
   *
   * Two writes, and the second one matters more than it looks.
   *
   * Seeing a variation confirms it: the id is stored if it was missing (rows
   * written before that field existed are repaired for free), and the first
   * sighting is stamped.
   *
   * A variation that WAS confirmed and is now gone has been deleted — in
   * Seller Center, or in this app. That is not a variation to restore. Without
   * this distinction the carry-forward added for under-review variations would
   * put a deliberately deleted one back on the next push, which is worse than
   * the problem it solves: a SKU nobody wanted, live, at whatever price it
   * had. So the row is marked removed and takes itself out of consideration.
   */
  var updates = skuRowUpdates_(rows, live.skus, new Date().toISOString(), Date.now());
  if (updates.length) markSkus_(updates);
  if (updates.length) rows = listSkus_(listingId);

  /**
   * Units sold per variation, from the orders already synced for this listing.
   *
   * Cached for a minute, because reading it costs a full pass over the Order
   * Items tab and this screen refreshes throughout a broadcast. A sold count
   * up to sixty seconds old is indistinguishable from a live one here: orders
   * land minutes after a SKU is called.
   *
   * Failure is not fatal. An empty map means every row reports `sold: null`,
   * which the screen already renders as "no sold figure" rather than zero —
   * the listing screen's job is to say whether a push landed, and that must
   * not depend on the orders tab being readable.
   */
  var sales = {};
  try {
    // The product this screen already read. Without it the sold count reads
    // the same product from TikTok a second time, every refresh.
    var knownProducts = {};
    knownProducts[String(listingId)] = live;
    sales = variationSalesCached_(listingId, knownProducts) || {};
  } catch (e) {
    warn_('TS-ORD-22', 'Could not read sales for ' + listingId + ': ' + e);
  }

  var variants = rows.filter(function (r) {
    return String(r.status) === 'pushed' || String(r.status) === 'removed';
  }).map(function (r) {
    var st = variationState_(
      r.identifier, r.tiktok_sku_id,
      liveSkus[String(r.identifier)], pendingSkus[String(r.identifier)]
    );
    var match = st.sku;
    var sale = salesFor_(sales, (match && match.id) || r.tiktok_sku_id, r.identifier);
    var sold = sale ? sale.units : null;
    return {
      identifier: String(r.identifier || ''),
      variant: String(r.variant || ''),
      price: String(r.price || ''),
      status: String(r.status || ''),
      external: false,
      tiktok_sku_id: String((match && match.id) || r.tiktok_sku_id || ''),
      image_url: String((match && match.skuImgUrl) || ''),
      created_at: isoOf_(r.created_at),
      created_by: String(r.created_by || ''),

      /**
       * One word for what this variation is. See variationState_.
       *
       * live | reviewing | pending | not_listed. The screen reads this and
       * nothing else, so "Live" can no longer mean "TikTok has heard of it".
       */
      state: st.state,
      /** Can a buyer buy it right now. The only thing "Live" may mean. */
      buyable: st.buyable,
      /** TikTok has it in some version. Not the same as buyable. */
      on_tiktok: st.on_tiktok,

      removed: String(r.status) === 'removed',

      /**
       * What is left, and what was ever available.
       *
       * `stock_total` is DERIVED: available plus sold. It is not stored, and
       * that is the whole point. The stored figure was what the app asked for
       * when the variation was first listed, and nothing kept it current — so
       * B137 read "1 left of 5 · 6 sold", which cannot be true. One left and
       * six sold means seven were available; somebody topped it up.
       *
       * Deriving it also makes a cancellation self-correcting. TikTok puts the
       * units back (Brien, confirmed: cancel an order of 2 and 2 return), so
       * `stock_available` rises, the total rises with it, and a variation
       * stops being sold out without any special case for cancellations.
       *
       * Null when there is nothing to add up: a variation nobody can buy yet
       * has no "left", and orders that have never been synced are not zero.
       */
      stock_available: st.quantity,
      /**
       * Every unit accounted for, or the total is a guess.
       *
       * available + sold was not enough. A unit sitting in ON_HOLD is PAID and
       * already deducted from TikTok's available figure, but it is not revenue
       * — the buyer can still cancel it alone. A unit under a status this app
       * does not recognise is likewise gone from available and unexplained.
       * Leaving either out of the total makes the total smaller than the number
       * of units that have actually existed.
       *
       * Cancelled units are deliberately NOT added: TikTok returns them to
       * stock (Brien, confirmed — cancel an order of 2 and 2 come back), so
       * they are already inside `available` and adding them would count them
       * twice.
       */
      stock_total: st.quantity === null
        ? null
        : st.quantity + (sold || 0) +
          (sale ? (sale.held || 0) + (sale.unknown || 0) + (sale.at_risk || 0) : 0),
      /** Paid, and still cancellable by the buyer alone. Shown, never netted. */
      held: sale ? (sale.held || 0) : null,
      /**
       * The buyer has the money back. NOT added to the total.
       *
       * TikTok returns a refunded unit to stock, exactly as it does a
       * cancellation, so it is already inside `stock_available`. Adding it
       * again would count it twice and make the total larger than the number
       * of units that ever existed — in the direction that overstates what a
       * factory sold.
       */
      refunded: sale ? (sale.refunded || 0) : null,
      /** A return request is open and undecided. Still committed stock. */
      at_risk: sale ? (sale.at_risk || 0) : null,

      /**
       * Sold, from the order line items. Not from stock arithmetic.
       *
       * Order lines are append-only, so no stock write by anybody can move
       * this number. `null` means orders have not been synced for this listing
       * yet, which is a different thing from zero and must stay
       * distinguishable.
       */
      sold: sold,
      /** Ordered then cancelled or unpaid. Shown separately, never netted. */
      cancelled: sale ? sale.unsold : null
    };
  });

  // Everything TikTok has that this app did not list — added in Seller Center,
  // or on another tool. Shown, or the app claims a listing has four variations
  // while listing three, and offers an identifier that is already taken.
  var oursByIdentifier = shownAsOurs_(rows);
  live.skus.forEach(function (s) {
    if (s.sellerSku && oursByIdentifier[String(s.sellerSku)]) return;
    var extSale = salesFor_(sales, s.id, s.sellerSku);
    var extState = variationState_(s.sellerSku, s.id, liveSkus[String(s.sellerSku)], s);
    variants.push({
      identifier: String(s.sellerSku || ''),
      variant: String(s.valueName || ''),
      price: String(s.priceAmount || ''),
      status: 'external',
      external: true,
      tiktok_sku_id: String(s.id || ''),
      image_url: String(s.skuImgUrl || ''),
      created_at: '',
      created_by: '',
      // Seller Centre rows are read from the pending version, like ours, and
      // get the same four-state treatment: buyable only if the live version
      // has them too.
      state: extState.state,
      buyable: extState.buyable,
      on_tiktok: extState.on_tiktok,
      removed: false,
      stock_available: extState.quantity,
      stock_total: extState.quantity === null
        ? null
        : extState.quantity + (extSale
            ? (extSale.units || 0) + (extSale.held || 0) + (extSale.unknown || 0) + (extSale.at_risk || 0)
            : 0),
      held: extSale ? (extSale.held || 0) : null,
      refunded: extSale ? (extSale.refunded || 0) : null,
      at_risk: extSale ? (extSale.at_risk || 0) : null,
      // A variation added in Seller Center still sells, and its line items
      // carry TikTok's sku id, so it can be matched and counted like any
      // other.
      sold: extSale ? extSale.units : null,
      cancelled: extSale ? extSale.unsold : null
    });
  });

  /**
   * The invariant, checked rather than assumed.
   *
   * Every SKU TikTok is showing must be drawn exactly once. Both faults found
   * on 15 Sep broke this silently — the app's own header read 3/100 above a
   * list of one and said nothing about the discrepancy. A mismatch now leaves
   * a line in the log naming the listing, so the next one is found by reading
   * the log rather than by someone noticing two screens disagree.
   */
  var shownLive = variants.filter(function (v) { return !v.removed && v.on_tiktok; }).length;
  if (shownLive !== live.skus.length) {
    warn_('TS-PRD-31', listingId + ': TikTok shows ' + live.skus.length +
      ' variation(s), the app draws ' + shownLive);
  }

  return {
    listing_id: String(listingId),
    title: live.title,
    product_status: live.status,
    audit_reasons: live.auditReasons,
    variations_on_tiktok: live.skus.length,
    max_skus: MAX_SKUS_PER_PRODUCT,
    /**
     * What is ON the listing. Removed variations are counted, not carried.
     *
     * Brien, 15 Sep: 116 removed against 12 live, so ninety per cent of every
     * refresh was history nobody was looking at — over 4G, onto a phone, and
     * then sorted and rendered by it. His own suggestion, and the right one:
     * keep the record for accountability, stop paying for it on every tap.
     *
     * The Removed tab asks for them with `removedVariations` when it is
     * opened, which is the only time anybody wants them.
     */
    variants: variants.filter(function (v) { return !v.removed; }),
    removed_count: variants.filter(function (v) { return v.removed; }).length,
    checked_at: new Date().toISOString()
  };
}

/**
 * Build the payload that adds a variation to an existing product.
 *
 * The single most dangerous fact about TikTok's edit API, quoted from the
 * Partial Edit Product reference:
 *
 *   "You must pass in all existing SKUs. Any existing SKU IDs not listed here
 *    will result in the deletion of those SKUs. For example, if this product
 *    contains 5 SKUs and you only provide 2 SKU IDs, the remaining 3 will be
 *    deleted."
 *
 * So there is no "append" call. Adding the 51st variation means sending all 51
 * — the 50 existing ones carrying their `id`, the new one with its `id` left
 * blank. Send only the new one and the livestream's entire back catalogue is
 * deleted, silently, with a success response.
 *
 * Throws 'LISTING_FULL' when the ceiling is reached, so the caller can offer a
 * continuation listing rather than reporting a failure.
 */
/**
 * Variations we listed that TikTok is not returning, and that may still be
 * under review — the ones any edit of this product must carry forward.
 *
 * Shared by adding and removing, because both rebuild the product from the
 * read and TikTok deletes any SKU absent from the payload. See addVariation_
 * for why each condition is there; the eligibility rule is tested in one
 * place and must not be duplicated.
 */
function pendingToCarry_(listingId, snapshot, excludeIdentifier) {
  var seen = {};
  snapshot.skus.forEach(function (sku) {
    if (sku.sellerSku) seen[String(sku.sellerSku)] = true;
  });
  var cutoff = Date.now() - REVIEW_WINDOW_MS;
  return listSkus_(listingId).filter(function (r) {
    if (String(r.status) !== 'pushed') return false;
    if (excludeIdentifier && String(r.identifier) === String(excludeIdentifier)) return false;
    if (seen[String(r.identifier)]) return false;
    if (!String(r.tiktok_sku_id || '')) return false;
    if (String(r.confirmed_at || '')) return false;
    var pushedAt = Date.parse(isoOf_(r.pushed_at) || isoOf_(r.created_at));
    return !isNaN(pushedAt) && pushedAt >= cutoff;
  }).map(function (r) {
    return {
      id: String(r.tiktok_sku_id),
      sellerSku: String(r.identifier),
      valueName: String(r.variant || ''),
      skuImgUri: String(r.tiktok_image_uri || ''),
      priceAmount: String(r.price),
      quantity: Number(r.stock || 0)
    };
  });
}

/**
 * Every variation that has been taken off this listing.
 *
 * Its own action, because the listing screen refreshes throughout a broadcast
 * and this list only grows: a listing reused across streams carried 116
 * removed rows against 12 live ones, and sending them on every refresh was
 * most of the payload and most of the phone's work.
 *
 * Reads the Sheet only. No TikTok call, because a removed variation is not
 * something TikTok will tell us about any more, and this is a record rather
 * than a live state.
 */
/**
 * The last few removals, newest first, and how many there are altogether.
 *
 * Brien chose this over the full list: *"Only to undo a mistake."* I12 carried
 * 121 removed variations against 32 live ones, and sending them all meant the
 * phone downloading, sorting and drawing four years of a listing's history to
 * answer a question about the last thing somebody deleted. The record is not
 * lost — it is in the Sheet, where it can be filtered and searched properly,
 * which a phone list never could.
 *
 * Ordered by when each was REMOVED rather than when it was listed. Rows from
 * before that was recorded fall back to their creation time, which puts them
 * last: they are the oldest removals anyway, and the alternative is showing an
 * undated row at the top of a list that means "most recent".
 */
function removedVariations_(listingId, limit) {
  var want = Number(limit) > 0 ? Number(limit) : REMOVED_RECENT;
  var all = listSkus_(listingId).filter(function (r) {
    return String(r.status) === 'removed';
  });
  var rows = all.slice().sort(function (a, b) {
    var at = isoOf_(a.removed_at) || isoOf_(a.created_at);
    var bt = isoOf_(b.removed_at) || isoOf_(b.created_at);
    return bt.localeCompare(at);
  }).slice(0, want);

  return {
    listing_id: String(listingId),
    /** Every removal on this listing, so the screen can say what it is not showing. */
    total: all.length,
    showing: rows.length,
    variants: rows.map(function (r) {
      return {
        identifier: String(r.identifier || ''),
        variant: String(r.variant || ''),
        price: String(r.price || ''),
        status: 'removed',
        external: false,
        tiktok_sku_id: String(r.tiktok_sku_id || ''),
        image_url: '',
        created_at: isoOf_(r.created_at),
        created_by: String(r.created_by || ''),
        removed_at: isoOf_(r.removed_at),
        /** Enough recorded to put it back. See restoreVariation_. */
        restorable: Boolean(String(r.price || '') && String(r.identifier || '')),
        state: 'removed',
        buyable: false,
        on_tiktok: false,
        removed: true,
        stock_available: null,
        stock_total: null,
        held: null,
        refunded: null,
        at_risk: null,
        sold: null,
        cancelled: null
      };
    }),
    checked_at: new Date().toISOString()
  };
}

/**
 * The payload that removes exactly one variation.
 *
 * TikTok deletes any SKU absent from a partial_edit payload. That is the
 * hazard every append defends against — and here it is the mechanism, used on
 * purpose. So the shape is the append payload without the addition and
 * without the target, and the guard is inverted: every id in the snapshot
 * except the one being removed must survive, or nothing is sent.
 */
function buildRemovePayload_(snapshot, alsoKeep, removeId) {
  var target = null;
  for (var i = 0; i < snapshot.skus.length; i++) {
    if (String(snapshot.skus[i].id) === String(removeId)) target = snapshot.skus[i];
  }
  if (!target) {
    throw fail_('TS-PRD-04', 'That variation is not on the listing right now. If it was just added it ' +
      'may still be under review; check again in a few minutes.');
  }

  var remaining = snapshot.skus.filter(function (sku) { return String(sku.id) !== String(removeId); });
  if (remaining.length + (alsoKeep || []).length === 0) {
    throw fail_('TS-PRD-05', 'This is the only variation on the listing. TikTok requires at least one, ' +
      'so remove the listing itself in Seller Center instead.');
  }

  for (var k = 0; k < remaining.length; k++) {
    if (!remaining[k].id || !remaining[k].warehouseId) {
      throw fail_('TS-PRD-06', 'TikTok returned an incomplete variation. Editing now could drop it, ' +
        'so nothing was sent. Try again in a moment.');
    }
  }

  var first = remaining[0] || snapshot.skus[0];
  var warehouseId = first.warehouseId;
  var skus = remaining.map(function (sku) {
    var attribute = sku.attributeId ? { id: sku.attributeId }
                                    : { name: sku.attributeName || VARIANT_ATTRIBUTE_NAME };
    if (sku.valueId) attribute.value_id = sku.valueId; else attribute.value_name = sku.valueName;
    if (sku.skuImgUri) attribute.sku_img = { uri: sku.skuImgUri };
    return {
      id: sku.id,
      seller_sku: sku.sellerSku || undefined,
      price: { amount: sku.priceAmount, currency: CURRENCY },
      inventory: [{ warehouse_id: sku.warehouseId, quantity: sku.quantity }],
      sales_attributes: [attribute]
    };
  });

  (alsoKeep || []).forEach(function (keep) {
    if (!keep.id || String(keep.id) === String(removeId)) return;
    var attribute = first.attributeId ? { id: first.attributeId }
                                      : { name: first.attributeName || VARIANT_ATTRIBUTE_NAME };
    attribute.value_name = keep.valueName;
    if (keep.skuImgUri) attribute.sku_img = { uri: keep.skuImgUri };
    skus.push({
      id: keep.id, seller_sku: keep.sellerSku || undefined,
      price: { amount: keep.priceAmount, currency: CURRENCY },
      inventory: [{ warehouse_id: warehouseId, quantity: keep.quantity }],
      sales_attributes: [attribute]
    });
  });

  // Inverted guard: exactly one thing may disappear, and it is the target.
  var kept = {};
  skus.forEach(function (x) { if (x.id) kept[x.id] = true; });
  for (var j = 0; j < snapshot.skus.length; j++) {
    var id = snapshot.skus[j].id;
    if (String(id) !== String(removeId) && !kept[id]) {
      throw fail_('TS-PRD-07', 'Refusing to edit: variation ' + (snapshot.skus[j].sellerSku || id) +
        ' would also have been deleted. This is a bug — nothing was sent to TikTok.');
    }
  }
  if (kept[removeId]) {
    throw fail_('TS-PRD-08', 'Refusing to edit: the variation to remove is still in the payload. ' +
      'This is a bug — nothing was sent to TikTok.');
  }

  // The same rule applies to a removal: the edit carries every remaining SKU,
  // so one of them without a photo fails the whole thing.
  withVariantImages_(skus, snapshot.mainImageUri, String(snapshot.productId || ''));

  return { skus: skus, removed: target };
}

/**
 * Remove one variation from a listing, on TikTok and in our records.
 *
 * Any edit sends the product back for review, so the remaining variations go
 * through it again — they stay buyable meanwhile. Orders already placed for
 * the removed variation are unaffected: they are orders, not SKUs.
 *
 * The row is marked removed rather than deleted. It sold things; the orders
 * export needs to know what "B3" was.
 */
function removeVariation_(listingId, tiktokSkuId, user) {
  var rows = listSkus_(listingId);
  var shopId = rows.length ? String(rows[0].shop_id) : '';
  if (!shopId) {
    var listing = readAll_(TAB_LISTINGS).filter(function (l) {
      return String(l.listing_id) === String(listingId);
    })[0];
    shopId = listing ? String(listing.shop_id) : '';
  }
  if (!shopId) throw fail_('TS-PRD-09', 'Unknown listing: ' + listingId);
  var shop = shopById_(shopId);

  var snapshot = ttGetProduct_(shopId, String(listingId));
  var ours = rows.filter(function (r) { return String(r.tiktok_sku_id || '') === String(tiktokSkuId); })[0];
  var alsoKeep = pendingToCarry_(listingId, snapshot, ours ? ours.identifier : null);
  var built = buildRemovePayload_(snapshot, alsoKeep, tiktokSkuId);

  var r = ttFetch_(shopId, 'post',
    '/product/202509/products/' + listingId + '/partial_edit', {}, { skus: built.skus });
  if (r.code !== 0) {
    logEvent_(user.name, 'remove_variation_failed', shop.brand,
      (built.removed.sellerSku || tiktokSkuId) + ': ' + ttReason_(r), 'error');
    throw fail_('TS-PRD-10', ttReason_(r) || 'TikTok refused the removal.');
  }

  if (ours) {
    markSkus_([{ sku_id: String(ours.sku_id), status: 'removed',
                 error: 'Removed from TikTok by ' + user.name,
                 removed_at: new Date().toISOString() }]);
  }
  var label = built.removed.sellerSku || built.removed.valueName || tiktokSkuId;
  logEvent_(user.name, 'remove_variation', shop.brand,
    label + ' from ' + listingId + ' (' + built.skus.length + ' remain)', 'ok');

  return {
    removed: label,
    listing_id: String(listingId),
    variations_now: built.skus.length,
    audit: 'pending'
  };
}

function buildAppendPayload_(snapshot, addition, alsoKeep) {
  if (!snapshot.skus.length) {
    throw fail_('TS-PRD-11', 'This listing has no variations to extend. TikTok requires at least one ' +
      'sales attribute on a product, so the first variation has to be created with the product.');
  }
  for (var i = 0; i < snapshot.skus.length; i++) {
    // Without an id we cannot say "keep this one", and TikTok would treat it as
    // a new SKU — duplicating it while deleting the original.
    if (!snapshot.skus[i].id) {
      throw fail_('TS-PRD-12', 'TikTok returned a variation without an ID for this listing. Adding to ' +
        'it now would duplicate it, so nothing was sent. Try again in a moment.');
    }
    // 12052533: "Removal, addition, and change of warehouses are not
    // permitted. Please specify the original warehouses for the SKUs."
    if (!snapshot.skus[i].warehouseId) {
      throw fail_('TS-PRD-13', 'TikTok did not return a warehouse for every existing variation. ' +
        'Editing this listing would drop their stock, so nothing was sent.');
    }
  }
  // Counts what will actually be on the product, restored ones included.
  if (snapshot.skus.length + (alsoKeep || []).length + 1 > MAX_SKUS_PER_PRODUCT) {
    throw new Error('LISTING_FULL');
  }

  var first = snapshot.skus[0];
  // "Provide either a built-in ID or a custom name; if both are provided, the
  // ID takes priority." So sending our own name against an established id
  // would be silently ignored.
  var identity = first.attributeId
    ? { id: first.attributeId }
    : { name: first.attributeName || VARIANT_ATTRIBUTE_NAME };
  var warehouseId = first.warehouseId;

  var valueName = variantValueName_(addition.identifier, addition.variantName);
  var taken = {};
  var skus = snapshot.skus.map(function (sku) {
    if (sku.valueName) taken[String(sku.valueName).toLowerCase()] = true;
    var attribute = sku.attributeId ? { id: sku.attributeId }
                                    : { name: sku.attributeName || VARIANT_ATTRIBUTE_NAME };
    if (sku.valueId) {
      // Re-sending value_name for a value that already has an id would create
      // a second value rather than reference the existing one.
      attribute.value_id = sku.valueId;
    } else {
      attribute.value_name = sku.valueName;
    }
    // An image is mandatory for every value of the primary attribute, so
    // dropping one existing photo fails the whole edit.
    if (sku.skuImgUri) attribute.sku_img = { uri: sku.skuImgUri };
    return {
      id: sku.id,
      seller_sku: sku.sellerSku || undefined,
      price: { amount: sku.priceAmount, currency: CURRENCY },
      inventory: [{ warehouse_id: sku.warehouseId, quantity: sku.quantity }],
      sales_attributes: [attribute]
    };
  });

  /**
   * Restate the ones TikTok did not return, by id.
   *
   * Placed before the duplicate check on purpose: these occupy their value
   * names, so a repeated identifier is still caught.
   */
  (alsoKeep || []).forEach(function (keep) {
    if (!keep.id) return;
    if (taken[String(keep.valueName).toLowerCase()]) return;
    taken[String(keep.valueName).toLowerCase()] = true;

    var attribute = first.attributeId
      ? { id: first.attributeId }
      : { name: first.attributeName || VARIANT_ATTRIBUTE_NAME };
    // Its value_id was never read back — the variation was invisible — so the
    // name is sent. TikTok matches an existing value by name rather than
    // creating a second one with the same name.
    attribute.value_name = keep.valueName;
    if (keep.skuImgUri) attribute.sku_img = { uri: keep.skuImgUri };

    skus.push({
      id: keep.id,
      seller_sku: keep.sellerSku || undefined,
      price: { amount: keep.priceAmount, currency: CURRENCY },
      inventory: [{ warehouse_id: warehouseId, quantity: keep.quantity }],
      sales_attributes: [attribute]
    });
  });

  // "No duplicates allowed under the same attribute." The identifier makes
  // this all but impossible, so hitting it means an identifier repeated.
  if (taken[valueName.toLowerCase()]) {
    throw fail_('TS-PRD-14', 'A variation called "' + valueName + '" is already on this listing. ' +
      'Identifier ' + addition.identifier + ' looks to have been used twice.');
  }

  /**
   * The same guard on the identifier itself, which is the one that matters.
   *
   * The check above compares VALUE NAMES, and a value name is the identifier
   * followed by the product name — so "B74 4 tier" and "B74 Set of 10 - Whirl
   * bowl" are different values and sailed straight through it. TikTok accepted
   * both, and the listing ended up with two live SKUs both carrying
   * seller_sku B74 (15 Sep, two phones on I12).
   *
   * That breaks the one assumption everything else rests on: seller_sku is the
   * key this app and TikTok agree on. With two, a stock change cannot say which
   * one it means, the sold count matches both, and the screen draws two rows
   * against one number.
   *
   * So it is refused, and refused rather than silently renamed: the host said
   * "B74" out loud on the broadcast, and quietly listing it as something else
   * would be worse than saying so. The message names the next free number.
   */
  var takenSku = {};
  skus.forEach(function (existing) {
    if (existing.seller_sku) takenSku[String(existing.seller_sku).toLowerCase()] = true;
  });
  if (takenSku[String(addition.identifier).toLowerCase()]) {
    throw fail_('TS-PRD-32', 'Identifier ' + addition.identifier + ' is already on this listing, on a ' +
      'different variation. Two phones have reached the same number. Nothing was sent — ' +
      'refresh to pick up the next free identifier and list it again under that.');
  }

  var added = {
    // No `id`: "To create new SKUs, leave the SKU ID blank and complete the
    // other fields."
    seller_sku: addition.identifier,
    price: { amount: String(addition.price), currency: CURRENCY },
    inventory: [{ warehouse_id: warehouseId, quantity: Number(addition.stock) }],
    sales_attributes: [{
      name: identity.name, id: identity.id,
      value_name: valueName,
      sku_img: { uri: addition.imageUri }
    }]
  };
  // Drop the undefined half of the identity so TikTok sees one or the other.
  if (!added.sales_attributes[0].id) delete added.sales_attributes[0].id;
  if (!added.sales_attributes[0].name) delete added.sales_attributes[0].name;
  skus.push(added);

  // Last line of defence. Everything above is meant to guarantee this, so a
  // failure here is a bug — but the cost of being wrong is a deleted
  // livestream, so it is checked anyway.
  var kept = {};
  skus.forEach(function (s) { if (s.id) kept[s.id] = true; });
  for (var j = 0; j < snapshot.skus.length; j++) {
    if (!kept[snapshot.skus[j].id]) {
      throw fail_('TS-PRD-15', 'Refusing to edit: variation ' +
        (snapshot.skus[j].sellerSku || snapshot.skus[j].id) +
        ' would have been deleted. This is a bug — nothing was sent to TikTok.');
    }
  }

  // Every variant TikTok will see must carry a photo, including ones added in
  // Seller Center without one. See withVariantImages_ — TikTok 12052522.
  withVariantImages_(skus, snapshot.mainImageUri, String(snapshot.productId || ''));

  return { skus: skus, category_version: CATEGORY_VERSION };
}

function ttRecommendCategory_(prefix, title, imageUri) {
  var r = ttFetch_(prefix, 'post', '/product/202309/categories/recommend', {}, {
    product_title: title,
    images: [{ uri: imageUri }],
    category_version: CATEGORY_VERSION
  });
  if (r.code !== 0 || !r.data || !r.data.leaf_category_id) {
    throw fail_('TS-PRD-16', 'Could not resolve a category: ' + ttReason_(r));
  }
  return r.data.leaf_category_id;
}

/**
 * Mandatory attributes for a category, filled with the first allowed value.
 *
 * NOTE the flag is `is_requried` — TikTok's own schema misspells it. Reading
 * `is_required` returns undefined, silently skips every required attribute,
 * and the listing then fails at create with an unhelpful error.
 *
 * Taking the first value is a deliberate simplification: these are fields like
 * "Material" that TikTok insists on but nobody wants to answer 200 times
 * mid-livestream, and they stay editable in Seller Center.
 */
function ttRequiredAttributes_(prefix, categoryId) {
  var r = ttFetch_(prefix, 'get',
    '/product/202309/categories/' + categoryId + '/attributes',
    { category_version: CATEGORY_VERSION }, null);
  if (r.code !== 0 || !r.data) return [];
  return (r.data.attributes || []).filter(function (a) {
    return a.type === 'PRODUCT_PROPERTY' && a.is_requried === true &&
      a.values && a.values.length;
  }).map(function (a) {
    return { id: a.id, values: [{ id: a.values[0].id }] };
  });
}

/** A sales warehouse id, required on every SKU's inventory. */
function ttWarehouseId_(prefix) {
  var cached = prop_(prefix + '_WAREHOUSE_ID');
  if (cached) return cached;
  var r = ttFetch_(prefix, 'get', '/logistics/202309/warehouses', {}, null);
  if (r.code !== 0) throw fail_('TS-PRD-17', 'Could not read warehouses: ' + ttReason_(r));
  var usable = (r.data.warehouses || []).filter(function (w) {
    return w.type === 'SALES_WAREHOUSE' && w.effect_status === 'ENABLED';
  });
  var chosen = usable.filter(function (w) { return w.is_default; })[0] || usable[0];
  if (!chosen) {
    throw fail_('TS-PRD-18', 'No enabled sales warehouse for this shop. Set one up in Seller Center first.');
  }
  var set = {}; set[prefix + '_WAREHOUSE_ID'] = chosen.id; setProps_(set);
  return chosen.id;
}

function buildPayload_(input, categoryId, warehouseId, attributes) {
  var payload = {
    title: input.title,
    // Mandatory, HTML, English. Derived from the title because nobody writes
    // a description mid-livestream.
    description: '<p>' + String(input.title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>',
    category_id: categoryId,
    category_version: CATEGORY_VERSION,
    main_images: [{ uri: input.imageUri }],
    package_weight: { value: input.weightKg || DEFAULT_WEIGHT_KG, unit: WEIGHT_UNIT },
    package_dimensions: {
      length: DEFAULT_DIMS.length, width: DEFAULT_DIMS.width,
      height: DEFAULT_DIMS.height, unit: DIMENSION_UNIT
    },
    skus: [{
      seller_sku: input.identifier,
      price: { amount: String(input.price), currency: CURRENCY },
      inventory: [{ warehouse_id: warehouseId, quantity: Number(input.stock) }],
      // The sales attribute every later variation joins. Named rather than
      // referenced by id, because a custom attribute has no id until TikTok
      // generates one on create.
      //
      // This is the step that makes the rest of the stream possible: a product
      // created without a sales attribute can never gain one, since "You must
      // retain at least 1 sales attribute" cuts both ways.
      sales_attributes: [{
        name: VARIANT_ATTRIBUTE_NAME,
        value_name: variantValueName_(input.identifier, input.variantName),
        sku_img: { uri: input.attributeImageUri || input.imageUri }
      }]
    }],
    save_mode: 'LISTING',
    // Makes a timed-out create safe to retry without duplicating the product.
    idempotency_key: input.idempotencyKey
  };
  if (attributes && attributes.length) payload.product_attributes = attributes;
  return payload;
}

/**
 * Push one SKU into a livestream.
 *
 * A factory stream is ONE TikTok product, and each SKU called out on air is a
 * *variation* of it. So the normal path is not "create a product", it is "add a
 * variation to the product this stream lists against". Creating a product
 * happens twice in a stream at most: once at the start, and again if the run
 * outgrows Singapore's 100-variation ceiling.
 *
 * Everything runs under the script lock. Adding a variation is a
 * read-modify-write of the product's whole SKU list, and two of those at once
 * is a lost update whose consequence is a *deleted* variation rather than an
 * overwritten one — TikTok returns success to both callers. LockService makes
 * that unreachable.
 *
 * Validation runs here as well as in the browser: the client checks are for
 * fast feedback, these are the ones that actually protect the shop.
 */
function pushSku_(body, user) {
  var prefix = String(body.shop_id || '').toUpperCase();
  var shop = shopById_(prefix);
  if (!shop) throw fail_('TS-PRD-19', 'Unknown shop: ' + body.shop_id);

  if (!body.identifier || /\s/.test(body.identifier)) {
    throw fail_('TS-PRD-20', 'SKU identifier is required and cannot contain spaces.');
  }
  if (!(Number(body.price) > 0)) throw fail_('TS-PRD-21', 'Price must be more than zero.');
  var stock = Number(body.stock);
  if (!(stock >= 1 && stock <= 99999)) throw fail_('TS-PRD-22', 'Stock must be between 1 and 99,999.');
  if (!body.photo_base64 && !body.tiktok_image_uri) throw fail_('TS-PRD-23', 'A photo is required.');

  // The variant name is the ONLY text a SKU contributes. The product title
  // belongs to the listing and is set once, so it is validated only on the
  // path that creates one — holding a variation to a product title's
  // 25-character floor rejected every short variant name.
  var variantProblem = validateVariantName_(variantValueName_(body.identifier, body.variant_name));
  if (variantProblem) throw fail_('TS-PRD-24', variantProblem);

  if (!body.listing_id) {
    var titleProblem = validateTitle_(body.title);
    if (titleProblem) throw fail_('TS-PRD-25', titleProblem);
  }

  // NO LOCK IS TAKEN HERE, deliberately.
  //
  // `pushSku` is in Api.gs's WRITE_ACTIONS, so the router already holds the
  // script lock for the whole call. Apps Script locks are not re-entrant —
  // LockService.getScriptLock() hands back a fresh Lock object, and a second
  // tryLock inside the same execution contends with the one the router holds
  // and fails. Locking again here would make every push report itself busy.
  //
  // The router's lock is what makes the read-modify-write below safe: adding a
  // variation reads the product's whole SKU list and sends it back, and two of
  // those at once is a lost update whose consequence is a *deleted* variation
  // rather than an overwritten one, with TikTok returning success to both. If
  // this function is ever called from somewhere that is not the router, that
  // caller must take the script lock itself.
  {
    // A retry after a timeout arrives with the same key. Returning the original
    // product is what makes the offline queue safe.
    if (body.idempotency_key) {
      var prior = findByIdempotencyKey_(body.idempotency_key);
      if (prior) {
        return {
          mode: prior.tiktok_product_id === body.listing_id ? 'variation_added' : 'listing_created',
          listing_id: prior.tiktok_product_id,
          product_id: prior.tiktok_product_id,
          deduplicated: true
        };
      }
    }

    // Archive the photo under the creator's name, then hand copies to TikTok —
    // it refuses external image URLs, so it needs its own uploads.
    var photoUrl = '';
    var imageUri = body.tiktok_image_uri || '';
    var attributeImageUri = body.tiktok_attribute_image_uri || '';
    /** The product, when it was read alongside the image upload. */
    var prefetchedSnapshot = null;
    if (body.photo_base64) {
      // Optional on purpose: a Drive wobble must never stop a product going
      // live. See savePhotoOptional_ — WX11 and WX12, 16 Sep.
      photoUrl = savePhotoOptional_(prefix, body.identifier, body.photo_base64,
                                    body.photo_mime || 'image/jpeg', user.name);
      // The small copy for the purchase order, filed beside the photo. Made
      // by the phone; the backend cannot resize. Carried on `body` so the row
      // writer, three calls down, can record it without a new parameter on
      // every function in between.
      body.photo_thumb_url = body.thumb_base64
        ? savePhotoOptional_(prefix, body.identifier + ' - thumb', body.thumb_base64, 'image/jpeg', user.name)
        : '';
      var photoBytes = Utilities.base64Decode(body.photo_base64);
      var photoMime = body.photo_mime || 'image/jpeg';
      var blob = Utilities.newBlob(photoBytes, photoMime, 'product.jpg');
      /**
       * Independent TikTok calls go out together, in one round trip.
       *
       * The push made them strictly in sequence — upload the image, THEN
       * read the product, THEN edit it — though the first two need nothing
       * from each other. They are now sent as one parallel batch, and only
       * the edit, which needs both answers, waits.
       *
       * Errors surface exactly as before: the image answer is read first, so
       * a failed upload still reports TS-PRD-01, and a failed read TS-PRD-02.
       *
       * Only the SKU that creates a listing needs a MAIN_IMAGE; every other
       * one is a variation and needs only the attribute image.
       */
      if (body.listing_id) {
        var appended = appendAssets_(prefix, blob, String(body.listing_id));
        attributeImageUri = appended.attributeImageUri;
        prefetchedSnapshot = appended.snapshot;
        if (!imageUri) imageUri = attributeImageUri;
      } else {
        var fresh = newListingAssets_(prefix, photoBytes, photoMime);
        attributeImageUri = fresh.attributeImageUri;
        imageUri = fresh.imageUri;
      }
    }

    var addition = {
      identifier: body.identifier,
      variantName: body.variant_name || '',
      price: body.price,
      stock: stock,
      imageUri: attributeImageUri || imageUri
    };

    return body.listing_id
      ? addVariation_(body, user, prefix, shop, addition, photoUrl, prefetchedSnapshot)
      : startNewListing_(body, user, prefix, shop, addition, imageUri, attributeImageUri, photoUrl);
  }
}

/**
 * What an append needs from TikTok before it can edit: the uploaded image,
 * and the product as it stands. One round trip for both.
 */
function appendAssets_(prefix, blob, listingId) {
  var both = ttFetchAll_([
    ttImageRequest_(prefix, blob, 'ATTRIBUTE_IMAGE'),
    ttProductRequest_(prefix, listingId, true)
  ]);
  // Image first, so a failed upload still reports TS-PRD-01 as it always did.
  var attributeImageUri = ttImageFrom_(both[0]);
  return { attributeImageUri: attributeImageUri, snapshot: ttProductFrom_(both[1], listingId) };
}

/**
 * A new listing uploads the photo twice, for two uses. One round trip for both,
 * and two blobs so the parallel requests never share one.
 */
function newListingAssets_(prefix, photoBytes, photoMime) {
  var ups = ttFetchAll_([
    ttImageRequest_(prefix, Utilities.newBlob(photoBytes, photoMime, 'product.jpg'), 'ATTRIBUTE_IMAGE'),
    ttImageRequest_(prefix, Utilities.newBlob(photoBytes, photoMime, 'product.jpg'), 'MAIN_IMAGE')
  ]);
  return { attributeImageUri: ttImageFrom_(ups[0]), imageUri: ttImageFrom_(ups[1]) };
}

/** Add a variation to the listing this stream is already using. */
function addVariation_(body, user, prefix, shop, addition, photoUrl, prefetched) {
  var listingId = String(body.listing_id);
  // Already read in parallel with the image upload when a photo came with the
  // push; read here only when it did not.
  var snapshot = prefetched || ttGetProduct_(prefix, listingId);

  /**
   * Has this identifier already been added?
   *
   * TikTok's `idempotency_key` only exists on Create Product, so an append
   * whose reply is lost has no server-side guard and the question has to be
   * answered here. It used to be answered from the snapshot alone, on the
   * belief that "the product itself records whether this identifier is already
   * a variation, and that answer is authoritative".
   *
   * That belief was wrong, and in the same way that cost a variation: a SKU
   * still under review is absent from Get Product. So a retry of a pending
   * push found nothing, decided it was new, and tried to add a second copy —
   * which the duplicate-value check then refused with a message about a
   * repeated identifier. Safe, but a wasted push and a misleading reason.
   *
   * Both sources are consulted now. TikTok's read settles it when the
   * variation is visible; our own row settles it when TikTok is not showing
   * one it has already issued an id for.
   */
  for (var i = 0; i < snapshot.skus.length; i++) {
    if (snapshot.skus[i].sellerSku === addition.identifier) {
      return {
        mode: 'variation_added', deduplicated: true,
        listing_id: listingId, product_id: snapshot.productId,
        sku_id: snapshot.skus[i].id,
        variations_now: snapshot.skus.length,
        remaining: MAX_SKUS_PER_PRODUCT - snapshot.skus.length
      };
    }
  }
  var alreadyOurs = listSkus_(listingId).filter(function (r) {
    return String(r.identifier) === addition.identifier &&
      String(r.status) === 'pushed' &&
      String(r.tiktok_sku_id || '');
  })[0];
  if (alreadyOurs) {
    return {
      mode: 'variation_added', deduplicated: true, audit: 'pending',
      listing_id: listingId, product_id: snapshot.productId,
      sku_id: String(alreadyOurs.tiktok_sku_id),
      variations_now: snapshot.skus.length,
      remaining: MAX_SKUS_PER_PRODUCT - snapshot.skus.length
    };
  }

  /**
   * Variations we listed that TikTok is not returning yet.
   *
   * A variation still under review is absent from Get Product. Since the
   * append payload is built from that read, adding the next variation
   * REBUILDS the product without it — and TikTok deletes any SKU whose id is
   * not in the payload. That is what happened to B1: it was pushed, it was
   * under review eighteen minutes later when B2 went up, and B2's edit wrote
   * the product back without it.
   *
   * Nothing detected it. The guard compares the payload against the snapshot,
   * and a variation missing from the snapshot is missing from both sides.
   *
   * So they are carried forward by TikTok's own sku id, which is what says
   * "keep this one". Everything needed to restate them is already recorded at
   * push time — the id, the price, the stock, the image and the value name.
   *
   * If TikTok refuses the reconstruction the whole edit fails and nothing is
   * written, which is the safe direction: a refused append loses a minute, and
   * a silent one loses a SKU nobody notices until the factory is paid.
   */
  var alsoKeep = pendingToCarry_(listingId, snapshot, addition.identifier);

  if (alsoKeep.length) {
    logEvent_(user.name, 'variations_preserved', shop.brand,
      'Carried forward while under review, adding ' + addition.identifier + ': ' +
      alsoKeep.map(function (k) { return k.sellerSku; }).join(', '), 'ok');
  }

  var payload;
  try {
    payload = buildAppendPayload_(snapshot, addition, alsoKeep);
  } catch (e) {
    if (String(e.message) === 'LISTING_FULL') {
      // Not a failure — the run has outgrown one product. Say so in a way the
      // client can act on, and record nothing: the SKU is still to be listed.
      var full = new Error('This listing is full at ' + MAX_SKUS_PER_PRODUCT +
        ' variations, which is TikTok\'s limit for Singapore. Start a continuation ' +
        'listing to carry on.');
      full.code = 'LISTING_FULL';
      full.listingId = listingId;
      full.skuCount = snapshot.skus.length;
      throw full;
    }
    throw e;
  }

  var edited = ttFetch_(prefix, 'post',
    '/product/202509/products/' + listingId + '/partial_edit', {}, payload);
  if (edited.code !== 0) {
    recordFailure_(body, user, prefix, shop, photoUrl, addition.imageUri, '', edited.message);
    // TikTok's own wording, verbatim. "You haven't set the return warehouse" is
    // actionable; "push failed" is not.
    throw fail_('TS-PRD-26', ttReason_(edited) || 'TikTok refused the variation.');
  }

  var skuId = '';
  var returned = (edited.data && edited.data.skus) || [];
  for (var j = 0; j < returned.length; j++) {
    if (returned[j].seller_sku === addition.identifier) skuId = returned[j].id || '';
  }

  /**
   * Warn when a variation we pushed is not in what TikTok just returned.
   *
   * The append payload is built entirely from the snapshot, so any variation
   * TikTok omits is dropped from the product without a word. The guard in the
   * variants engine cannot catch this: it compares the payload against the
   * same snapshot, and something absent from the snapshot is absent from both.
   *
   * This is not hypothetical. B1 was pushed and recorded as pushed; the next
   * push eighteen minutes later read the product and found two variations, not
   * three, and wrote back a payload without it. The only reason anyone noticed
   * is that the status check later reported it Missing.
   *
   * Recorded rather than refused, because the cause is not established — a
   * variation invisible while under review and one that never persisted look
   * identical from here, and blocking a livestream on a guess about which is
   * worse than a warning that names the SKU. The count is our own arithmetic
   * either way, which is why it agreed with itself while being wrong.
   */

  // Counts the restored ones too, or the number shrinks every time one is
  // carried forward — which is how the old count agreed with itself while
  // being wrong.
  var variationsNow = snapshot.skus.length + alsoKeep.length + 1;
  recordSku_(skuRow_(body, user, prefix, shop, addition, photoUrl, '', snapshot.productId, skuId));
  logEvent_(user.name, 'add_variation', shop.brand,
    addition.identifier + ' -> ' + listingId + ' (' + variationsNow + '/' +
    MAX_SKUS_PER_PRODUCT + ')', 'ok');

  return {
    mode: 'variation_added',
    listing_id: listingId, product_id: snapshot.productId, sku_id: skuId,
    variant_name: variantValueName_(addition.identifier, addition.variantName),
    variations_now: variationsNow,
    remaining: MAX_SKUS_PER_PRODUCT - variationsNow,
    // Adding a variation resends the product for review. The existing
    // variations stay live and buyable throughout — "If the audit passes, v2 is
    // published to the shop, otherwise the existing product stays live and
    // remains unchanged" — but the new one is not purchasable until it clears.
    // Saying so is the difference between a confusing wait and an expected one.
    audit: 'pending'
  };
}

/**
 * Create the listing this stream will add variations to.
 *
 * Order of operations matters — it is what avoids the two commonest failures:
 *   1. resolve a LEAF category (products cannot be created in a branch),
 *   2. fetch that category's mandatory attributes and fill them,
 *   3. dry-run with listing_check, so problems are named before they cost a
 *      slot against the daily upload cap,
 *   4. create.
 */
function startNewListing_(body, user, prefix, shop, addition, imageUri, attributeImageUri, photoUrl) {
  // A continuation listing takes its title from the listing it continues, read
  // from TikTok rather than from the client — authoritative, and it means
  // nobody has to invent a product name mid-broadcast.
  var title = String(body.title || '').trim();
  if (body.continues_from) {
    var parent = ttGetProduct_(prefix, body.continues_from);
    if (!parent.title) {
      throw fail_('TS-PRD-27', 'Could not read the title of the listing this continues, so the new one ' +
        'cannot be named. Try again in a moment.');
    }
    title = continuationTitle_(parent.title);
  }
  var titleProblem = validateTitle_(title);
  if (titleProblem) throw fail_('TS-PRD-28', titleProblem);

  var input = {
    title: title,
    identifier: addition.identifier,
    variantName: addition.variantName,
    price: addition.price,
    stock: addition.stock,
    weightKg: body.weight_kg || DEFAULT_WEIGHT_KG,
    imageUri: imageUri,
    attributeImageUri: attributeImageUri,
    idempotencyKey: body.idempotency_key || Utilities.getUuid()
  };

  var categoryId = ttRecommendCategory_(prefix, input.title, input.imageUri);
  var attributes = ttRequiredAttributes_(prefix, categoryId);
  var warehouseId = ttWarehouseId_(prefix);
  var payload = buildPayload_(input, categoryId, warehouseId, attributes);

  // Dry run first: a rejection at create time still counts against the daily
  // allowance, and during a livestream that allowance is the scarce resource.
  var check = ttFetch_(prefix, 'post', '/product/202309/products/listing_check', {}, payload);
  if (check.code !== 0) {
    recordFailure_(body, user, prefix, shop, photoUrl, input.imageUri, categoryId, check.message);
    throw fail_('TS-PRD-29', ttReason_(check) || 'Listing check failed.');
  }

  var created = ttFetch_(prefix, 'post', '/product/202309/products', {}, payload);
  if (created.code !== 0 || !created.data || !created.data.product_id) {
    recordFailure_(body, user, prefix, shop, photoUrl, input.imageUri, categoryId,
      ttReason_(created) || 'no product id returned');
    throw fail_('TS-PRD-30', ttReason_(created) || 'TikTok returned no product ID.');
  }

  var productId = created.data.product_id;
  recordSku_(skuRow_(body, user, prefix, shop, addition, photoUrl, categoryId, productId));
  // Register the new product as this stream's listing, so it appears in the
  // picker and every later SKU can be appended to it.
  addListing_(prefix, productId, user.name);
  logEvent_(user.name, 'create_listing', shop.brand,
    input.identifier + ' ' + input.title + ' -> ' + productId, 'ok');

  return {
    mode: 'listing_created',
    // The new product id IS the listing id for everything that follows, which
    // is why it is returned under both names: the client stores it as the
    // stream's listing, and every later SKU appends to it.
    listing_id: productId, product_id: productId,
    variant_name: variantValueName_(input.identifier, input.variantName),
    variations_now: 1, remaining: MAX_SKUS_PER_PRODUCT - 1,
    photo_url: photoUrl, audit: 'pending'
  };
}

/** One SKU row for the Sheet, so the two success paths cannot drift. */
function skuRow_(body, user, prefix, shop, addition, photoUrl, categoryId, productId,
                 tiktokSkuId) {
  var now = new Date().toISOString();
  return {
    sku_id: Utilities.getUuid(),
    listing_id: productId, shop_id: prefix, brand: shop.brand,
    identifier: addition.identifier, title: String(body.title).trim(),
    variant: variantValueName_(addition.identifier, addition.variantName),
    price: addition.price, stock: addition.stock,
    weight_kg: body.weight_kg || DEFAULT_WEIGHT_KG,
    dims_cm: DEFAULT_DIMS.length + 'x' + DEFAULT_DIMS.width + 'x' + DEFAULT_DIMS.height,
    tiktok_image_uri: addition.imageUri, photo_url: photoUrl,
    photo_thumb_url: String(body.photo_thumb_url || ''),
    category_id: categoryId || '',
    status: 'pushed', error: '', tiktok_product_id: productId,
    /**
     * TikTok's own id for this variation.
     *
     * The one field that makes a variation recoverable. It was being computed
     * from the edit response and then discarded, which left nothing able to
     * say "keep this one" — and a variation TikTok does not return cannot be
     * kept by name.
     */
    tiktok_sku_id: tiktokSkuId || '',
    idempotency_key: body.idempotency_key || '',
    created_at: now, pushed_at: now, created_by: user.name
  };
}

/** Record a rejection, so the SKU is not lost and the reason is visible. */
function recordFailure_(body, user, prefix, shop, photoUrl, imageUri, categoryId, message) {
  recordSku_({
    sku_id: Utilities.getUuid(), listing_id: body.listing_id, shop_id: prefix,
    brand: shop.brand, identifier: body.identifier, title: body.title,
    variant: body.variant_name || '', price: body.price, stock: body.stock,
    weight_kg: body.weight_kg || DEFAULT_WEIGHT_KG,
    dims_cm: DEFAULT_DIMS.length + 'x' + DEFAULT_DIMS.width + 'x' + DEFAULT_DIMS.height,
    tiktok_image_uri: imageUri, photo_url: photoUrl, category_id: categoryId,
    status: 'failed', error: String(message).slice(0, 500), tiktok_product_id: '',
    idempotency_key: body.idempotency_key || '',
    created_at: new Date().toISOString(), pushed_at: '',
    created_by: user.name
  });
  logEvent_(user.name, 'push_sku', shop.brand, body.identifier + ' — ' + message, 'failed');
}


/**
 * Every identifier already in use on a listing, from both records.
 *
 * The client seeds the A1/A2 sequence from this. It used to return raw Sheet
 * rows, whose field is `identifier`, to a client reading `seller_sku` — so a
 * fresh device saw nothing usable and restarted the sequence at 1. The same
 * device never noticed because its local drafts filled the gap.
 *
 * TikTok's own list is merged in, so a variation added in Seller Center under
 * B4 means the app offers B5, not a second B4.
 */
function listedSkusForClient_(listingId) {
  var out = [];
  var seen = {};
  listSkus_(listingId).forEach(function (r) {
    if (String(r.status) !== 'pushed') return;
    var id = String(r.identifier || '');
    if (!id || seen[id]) return;
    seen[id] = true;
    out.push({ seller_sku: id, title: String(r.variant || r.title || '') });
  });
  try {
    var rows = listSkus_(listingId);
    var shopId = rows.length ? String(rows[0].shop_id) : '';
    if (!shopId) {
      var listing = readAll_(TAB_LISTINGS).filter(function (l) {
        return String(l.listing_id) === String(listingId);
      })[0];
      shopId = listing ? String(listing.shop_id) : '';
    }
    if (shopId) {
      ttGetProduct_(shopId, String(listingId)).skus.forEach(function (s) {
        var id = String(s.sellerSku || '');
        if (!id || seen[id]) return;
        seen[id] = true;
        out.push({ seller_sku: id, title: String(s.valueName || '') });
      });
    }
  } catch (e) {
    // TikTok unreachable is not a reason to refuse the listing screen; the
    // Sheet half is still the better seed than nothing.
    logEvent_('system', 'listed_skus_live_read_failed', '', String(e), 'warn');
  }
  return out;
}

/**
 * The variation to change stock on, or a refusal that says why.
 *
 * Shared by the stock write and the semantics diagnostic. One home per check,
 * because the error registry allows a code at exactly one site — which is the
 * point: `TS-STK-02` has to mean one thing, or a photographed banner cannot be
 * looked up.
 */
function skuForStock_(live, identifier, tiktokSkuId) {
  var sku = null;
  for (var i = 0; i < live.skus.length; i++) {
    var s = live.skus[i];
    // TikTok's own id first, because a variation added in Seller Center has no
    // seller_sku of ours to match on — and that is most of what is on a
    // listing the team has been running for a while. Brien, 15 Sep: "how about
    // items that were not created on the app? can we update the qty?"
    if (tiktokSkuId && String(s.id) === String(tiktokSkuId)) { sku = s; break; }
    if (!tiktokSkuId && String(s.sellerSku) === String(identifier)) { sku = s; break; }
  }
  if (!sku) {
    throw fail_('TS-STK-02',
      (identifier || tiktokSkuId || 'That variation') +
      ' is not one of the variations TikTok is returning for this listing. ' +
      'A variation still under review is not returned, so wait for it to go live before changing its stock.');
  }
  if (!sku.warehouseId && !(sku.inventories && sku.inventories.length)) {
    throw fail_('TS-STK-03',
      (identifier || tiktokSkuId || 'That variation') +
      ' has no warehouse on TikTok, so its stock cannot be changed.');
  }
  return sku;
}

/**
 * TikTok's documented range, checked before anything is sent.
 *
 * The floor is 1, not 0, so there is no way to zero a variation from here.
 * Said plainly rather than clamped: a clamp to 1 leaves one phantom unit
 * sellable on something meant to be off sale.
 */
function checkStockTotal_(want) {
  if (!isFinite(want) || Math.floor(want) !== want || want < 1 || want > 99999) {
    throw fail_('TS-STK-04',
      'Stock has to be a whole number between 1 and 99,999, and ' + want + ' is not.' +
      (want < 1 ? ' TikTok cannot set a variation to zero from here — remove the variation instead.' : ''));
  }
  return want;
}

/**
 * Does TikTok's inventory endpoint SET the quantity, or ADD to it?
 *
 * The one fact standing between the app and a "top up this variation" button,
 * and TikTok documents it nowhere. Their page never uses the words absolute,
 * relative, replace, overwrite, delta or increment. The field description ("The
 * total SKU quantity available in the warehouse") and error 12052393 ("stock
 * can't be updated below current stock") both point at SET, but that is an
 * inference, and backwards it doubles a variation's stock the first time
 * somebody presses the button during a broadcast.
 *
 * Brien's Seller Center test on 8 Sep — 1, then 11, then 21 by adding ten each
 * time — proves the read path works and proves nothing about this endpoint.
 * Seller Center is a web UI on TikTok's own internal API, not this one.
 *
 * So: two writes of the SAME value, reading back after each.
 *
 *   SET  →  V, then V
 *   ADD  →  N+V, then N+2V
 *
 * Two writes rather than one, because a single write cannot tell them apart
 * when V happens to equal the result.
 *
 * DELIBERATELY AWKWARD TO RUN. It writes to a real shop, so it refuses until
 * three Script Properties name exactly what it may touch, and it will not
 * choose a variation for you. Point it at something disposable.
 */
function checkStockSemantics() {
  var shopId = prop_('STOCK_TEST_SHOP');
  var listingId = prop_('STOCK_TEST_LISTING');
  var identifier = prop_('STOCK_TEST_IDENTIFIER');

  if (!shopId || !listingId || !identifier) {
    Logger.log([
      '',
      'checkStockSemantics — not run. Nothing was written.',
      '',
      'It writes real stock to a real shop twice, so it will only touch a',
      'variation you name. In Project Settings → Script Properties, add:',
      '',
      '  STOCK_TEST_SHOP        HZ, TM or PM',
      '  STOCK_TEST_LISTING     the listing id (the long number)',
      '  STOCK_TEST_IDENTIFIER  the variation, e.g. B15',
      '',
      'Pick something disposable. Whatever its stock is now, this leaves it at',
      'a different number and tells you how to put it back.',
      ''
    ].join('\n'));
    return;
  }

  var sku = skuForStock_(ttGetProduct_(shopId, listingId), identifier, '');

  var before = Number(sku.quantity || 0);
  // Distinct from the current level and from double it, so neither reading can
  // be mistaken for the other.
  var v = (before === 5 || before === 10) ? 7 : 5;

  var lines = ['', 'STOCK SEMANTICS — ' + identifier + ' on ' + shopId, ''];
  lines.push('before        ' + before);
  lines.push('writing       ' + v + ', twice');
  lines.push('');

  var first = writeStockOnce_(shopId, listingId, sku, v);
  lines.push('after write 1 ' + first);
  var second = writeStockOnce_(shopId, listingId, sku, v);
  lines.push('after write 2 ' + second);
  lines.push('');

  if (first === v && second === v) {
    lines.push('VERDICT: SET. The number sent replaces the stock.');
    lines.push('So a top-up must read the current level and write current + n.');
  } else if (first === before + v && second === before + 2 * v) {
    lines.push('VERDICT: ADD. The number sent is added to the stock.');
    lines.push('So a top-up writes n directly, and must never write a computed total.');
  } else {
    lines.push('VERDICT: NEITHER, and that is the most important possible result.');
    lines.push('Expected ' + v + '/' + v + ' for SET or ' + (before + v) + '/' + (before + 2 * v) + ' for ADD.');
    lines.push('Do not build a stock button on a guess. Send these numbers to Claude.');
  }
  lines.push('');
  lines.push('Put it back: set ' + identifier + ' to ' + before + ' in Seller Center.');
  lines.push('');
  Logger.log(lines.join('\n'));
  return { before: before, wrote: v, after_1: first, after_2: second };
}

/**
 * One inventory write, then a fresh read of what TikTok actually holds.
 *
 * Returns the RE-READ number, never the intended one. A write that reports
 * success and did something else is exactly what this is looking for, so
 * trusting the request would defeat the purpose.
 *
 * Two traps handled here because they apply to every future stock write:
 *
 *   The whole warehouse array must be echoed back. TikTok's rule is "You must
 *   include all warehouse IDs assigned to this SKU, along with the respective
 *   quantity. Do not omit any or add unrelated warehouses."
 *
 *   Per-SKU failures arrive INSIDE a success envelope: HTTP 200, code 0,
 *   message "Success", with the real problem in data.errors[]. The usual
 *   `if (r.code !== 0) throw` misses them entirely.
 */
function writeStockOnce_(shopId, listingId, sku, quantity) {
  checkStockTotal_(quantity);

  /**
   * One warehouse only, and it refuses rather than guesses.
   *
   * With two warehouses each holding stock, "set the total to 25" has no
   * single answer: it could be 25 and 0, or 12 and 13, and picking silently
   * would move real inventory between locations. Singapore listings here have
   * one warehouse, so this is a guard rather than a limitation — and if it
   * ever fires, the right response is a decision, not a default.
   */
  var inventories = sku.inventories && sku.inventories.length
    ? sku.inventories
    : [{ warehouse_id: String(sku.warehouseId), quantity: Number(sku.quantity || 0) }];
  if (inventories.length > 1) {
    throw fail_('TS-STK-09',
      'This variation stocks in ' + inventories.length + ' warehouses, so there is no single total to set. ' +
      'Change it in Seller Center, per warehouse.');
  }

  var r = ttFetch_(shopId, 'post',
    '/product/202309/products/' + listingId + '/inventory/update', {},
    { skus: [{ id: String(sku.id), inventory: [{ warehouse_id: String(inventories[0].warehouse_id), quantity: quantity }] }] });

  if (r.code !== 0) {
    throw fail_('TS-STK-05', 'TikTok refused the stock change: ' + ttReason_(r));
  }
  // The envelope said success. Ask the rows.
  var errors = (r.data && r.data.errors) || [];
  if (errors.length) {
    var first = errors[0] || {};
    var extra = ((first.detail && first.detail.extra_errors) || [])[0] || {};
    // Its own code, because it is a different situation from the call being
    // refused: the envelope said success, so anything checking only the
    // envelope has already recorded this as done.
    throw fail_('TS-STK-08',
      'TikTok reported success but refused this SKU: ' +
      (extra.message || first.message || 'no reason given') +
      (extra.code ? ' (' + extra.code + ')' : ''));
  }

  var after = ttGetProduct_(shopId, listingId);
  for (var i = 0; i < after.skus.length; i++) {
    if (String(after.skus[i].id) === String(sku.id)) return Number(after.skus[i].quantity || 0);
  }
  throw fail_('TS-STK-06',
    'The variation is no longer returned by TikTok after the write, so its stock cannot be confirmed. ' +
    'Nothing further was sent.');
}

/**
 * Change one variation's stock on TikTok, and report what TikTok then holds.
 *
 * Established by `checkStockSemantics` against the real endpoint on 8 Sep:
 * **the quantity sent REPLACES the stock.** B15 was at 21, two writes of 5
 * left it at 5 both times. So a top-up is read-modify-write, and the read has
 * to be fresh.
 *
 * `delta` adds to whatever TikTok holds right now; `absolute` sets it outright.
 * The app sends a delta for "add 10 more", which is the case that matters: it
 * means two people topping up during a broadcast add 10 and 10 rather than
 * both writing the same stale total and one silently undoing the other.
 *
 * There is no ETag, no version field and no idempotency key on this endpoint,
 * so this is an unguarded read-modify-write. A buyer's order landing between
 * the read and the write is the likely case during a stream, not the edge
 * case, and it would be erased into real oversell. Two things narrow it: the
 * whole sequence is one call with nothing in between, and it is taken under
 * the same script lock as every other write, so two phones cannot interleave.
 *
 * What it returns is the RE-READ figure, never the intended one. A write that
 * reports success and does something else is the failure worth catching.
 */
function setVariationStock_(listingId, identifier, tiktokSkuId, delta, absolute, actor) {
  if (!listingId || (!identifier && !tiktokSkuId)) {
    throw fail_('TS-STK-10', 'A stock change needs a listing and a variation.');
  }

  // The shop comes from the listing, as it does for a removal: the phone knows
  // which listing it is looking at, and one fewer field to pass is one fewer
  // field to get wrong.
  var rows = listSkus_(listingId);
  var shopId = rows.length ? String(rows[0].shop_id) : '';
  if (!shopId) {
    var listing = readAll_(TAB_LISTINGS).filter(function (l) {
      return String(l.listing_id) === String(listingId);
    })[0];
    shopId = listing ? String(listing.shop_id) : '';
  }
  if (!shopId) throw fail_('TS-STK-11', 'Unknown listing: ' + listingId);

  var live;
  try {
    live = ttGetProduct_(shopId, String(listingId));
  } catch (e) {
    throw fail_('TS-STK-01',
      'Could not read the listing before changing stock, so nothing was sent. ' + (e && e.message ? e.message : e));
  }

  var sku = skuForStock_(live, identifier, tiktokSkuId);
  var before = Number(sku.quantity || 0);
  var want = (absolute === null || absolute === undefined || absolute === '')
    ? before + Number(delta || 0)
    : Number(absolute);

  checkStockTotal_(want);

  var after = writeStockOnce_(shopId, listingId, sku, want);

  if (after !== want) {
    // Not corrected automatically. A second write on top of an outcome we do
    // not understand is how one wrong number becomes two.
    throw fail_('TS-STK-07',
      'TikTok accepted the change for ' + identifier + ' but is now reporting ' + after +
      ' rather than ' + want + '. Nothing further was sent. Check Seller Center before trying again.');
  }

  // The Sheet's `stock` column means "the total currently listed", so keeping
  // it in step is what lets the app show "N left of M" honestly again after an
  // in-app change. An edit made in Seller Center still leaves it stale, which
  // is why the screen hides the denominator when it cannot be true.
  // Only if we have a row for it. A variation added in Seller Center has none,
  // and its stock still changes on TikTok — there is simply nothing of ours to
  // keep in step.
  rows = listSkus_(listingId);
  for (var j = 0; j < rows.length; j++) {
    if (identifier && String(rows[j].identifier) === String(identifier)) {
      markSkus_([{ sku_id: String(rows[j].sku_id), stock: after }]);
      break;
    }
  }

  logEvent_(actor && actor.name, 'set_stock', String(listingId),
    (identifier || sku.valueName || tiktokSkuId) + ': ' + before + ' -> ' + after, 'ok');

  return {
    identifier: String(identifier || sku.valueName || ''),
    before: before,
    after: after,
    requested: want
  };
}

/**
 * Hand out the next identifier for a listing, so two phones cannot pick the same one.
 *
 * Brien, 15 Sep: "how can we ensure that at least 2 phones can use the app
 * consecutively on one listing during an actual livestream?"
 *
 * Pushes were already safe — every write takes the script lock, so they
 * serialise and cannot corrupt each other. The gap was earlier and quieter:
 * each phone worked out the next number from what IT could see, so two phones
 * looking at a listing ending at B74 both showed B75, and both operators said
 * "B75" on air. TikTok would have taken both, and the purchase order would
 * have merged two different products into one row.
 *
 * It has to be settled BEFORE the number is spoken, not at push time. An
 * identifier that changes after somebody has said it and written it on the box
 * is worse than a collision, because nobody finds out.
 *
 * A Script Property counter rather than a row, because a reservation row would
 * have to be reconciled with the push path and a half-filled SKU row is its
 * own kind of mess. Seeded from the Sheet the first time a prefix is used, so
 * a listing mid-stream carries on from where it is rather than restarting.
 *
 * Abandoned reservations leave a gap in the numbering. That is the deliberate
 * trade: a gap is confusing for a second, a duplicate is wrong forever.
 */
function reserveIdentifier_(listingId, prefix) {
  var want = String(prefix || 'A').trim().toUpperCase() || 'A';
  if (!listingId) throw fail_('TS-SEQ-01', 'An identifier has to be reserved against a listing.');

  var key = 'SEQ_' + String(listingId) + '_' + want;

  return withScriptLock_(20000, function () {
    var current = Number(prop_(key) || 0);

    if (!current) {
      // First use of this prefix on this listing: start from whatever is
      // already there, so a stream that has done B1 to B74 by hand continues
      // at B75 rather than colliding all the way back up.
      listSkus_(listingId).forEach(function (r) {
        var seq = seqOf_(String(r.identifier || ''), want);
        if (seq > current) current = seq;
      });
    }

    var next = current + 1;
    PropertiesService.getScriptProperties().setProperty(key, String(next));
    return { identifier: want + next, prefix: want, seq: next };
  });
}

/**
 * The number part of an identifier, if it belongs to this prefix.
 *
 * Whole-prefix match only: "B" must not claim "BX7", or switching prefix
 * mid-stream would drag the old series along with it.
 */
function seqOf_(identifier, prefix) {
  var id = String(identifier || '').trim().toUpperCase();
  var want = String(prefix || '').trim().toUpperCase();
  if (!id || !want || id.indexOf(want) !== 0) return 0;
  var rest = id.slice(want.length);
  if (!/^\d+$/.test(rest)) return 0;
  return Number(rest);
}

/**
 * Put a removed variation back on the listing.
 *
 * Brien's undo. The row still holds everything TikTok needs — identifier,
 * name, price, stock and the image uri it was listed with — so this is an
 * ordinary append built from a record rather than from a form.
 *
 * Deliberately NOT a reversal of the delete. TikTok has no undelete; the SKU
 * is gone and its id with it. This creates a new variation carrying the same
 * identifier, which is why it goes through the same duplicate guard as any
 * push: if somebody has reused that identifier in the meantime, it is refused
 * rather than making a second B74.
 *
 * The stock restored is the stock that was RECORDED, not what was left when it
 * was removed. Those differ once anything sold, and re-listing with the
 * original figure would put units back on sale that were already bought. So it
 * asks for the number, defaulting to what remains sellable, rather than
 * guessing.
 */
function restoreVariation_(listingId, identifier, stock, user) {
  var rows = listSkus_(listingId).filter(function (r) {
    return String(r.identifier) === String(identifier) && String(r.status) === 'removed';
  });
  var row = rows.sort(function (a, b) {
    return (isoOf_(b.removed_at) || isoOf_(b.created_at))
      .localeCompare(isoOf_(a.removed_at) || isoOf_(a.created_at));
  })[0];
  if (!row) throw fail_('TS-PRD-34', identifier + ' is not a removed variation on this listing.');

  var shopId = String(row.shop_id || '');
  var shop = shopById_(shopId);
  if (!shop) throw fail_('TS-PRD-35', 'Unknown shop on ' + identifier + ': ' + shopId);

  var want = Number(stock);
  if (!isFinite(want) || want <= 0) want = Number(row.stock || 0);
  checkStockTotal_(want);

  var imageUri = String(row.tiktok_image_uri || '');
  if (!imageUri) {
    throw fail_('TS-PRD-36', identifier + ' has no photo on record, and TikTok requires one on ' +
      'every variation. List it again from the app instead.');
  }

  var snapshot = ttGetProduct_(shopId, String(listingId));
  var addition = {
    identifier: String(row.identifier),
    // The stored variant name already carries the identifier, which
    // variantValueName_ would add a second time.
    variantName: strippedVariantName_(String(row.variant || ''), String(row.identifier)),
    price: String(row.price),
    stock: want,
    imageUri: imageUri
  };

  var payload = buildAppendPayload_(snapshot, addition,
    pendingToCarry_(listingId, snapshot, addition.identifier));

  var edited = ttFetch_(shopId, 'post',
    '/product/202509/products/' + listingId + '/partial_edit', {}, payload);
  if (edited.code !== 0) {
    throw fail_('TS-PRD-37', ttReason_(edited) || 'TikTok refused the restore.');
  }

  var skuId = '';
  ((edited.data && edited.data.skus) || []).forEach(function (s) {
    if (s.seller_sku === addition.identifier) skuId = s.id || '';
  });

  markSkus_([{
    sku_id: String(row.sku_id),
    status: 'pushed',
    error: '',
    removed_at: '',
    // A new SKU, so a new id — and the old confirmed_at described a variation
    // that no longer exists. Cleared, so the removal rule judges this one on
    // its own sighting rather than on its predecessor's.
    confirmed_at: '',
    tiktok_sku_id: String(skuId || ''),
    stock: want
  }]);

  logEvent_(user.name, 'restore_variation', shop.brand,
    identifier + ' back on ' + listingId + ' with ' + want + ' in stock', 'ok');

  return {
    identifier: identifier,
    listing_id: String(listingId),
    stock: want,
    sku_id: String(skuId || ''),
    audit: 'pending'
  };
}
