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
  var r = ttFetch_(prefix, 'post', '/product/202309/images/upload',
    { use_case: useCase || 'MAIN_IMAGE' }, blob);
  if (r.code !== 0) throw new Error('Image upload failed: ' + (r.message || r.code));
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
function ttGetProduct_(prefix, productId) {
  var r = ttFetch_(prefix, 'get', '/product/202309/products/' + productId,
    { category_version: CATEGORY_VERSION }, null);
  if (r.code !== 0 || !r.data) {
    throw new Error('Could not read the listing: ' + (r.message || r.code));
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
      priceAmount: String((raw.price && (raw.price.sale_price || raw.price.amount)) || ''),
      quantity: Number(inventory.quantity || 0),
      warehouseId: inventory.warehouse_id || ''
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
    skus: skus
  };
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
function listingState_(listingId) {
  var rows = listSkus_(listingId);
  var shopId = rows.length ? String(rows[0].shop_id) : '';
  if (!shopId) {
    var listing = readAll_(TAB_LISTINGS).filter(function (r) {
      return String(r.listing_id) === String(listingId);
    })[0];
    shopId = listing ? String(listing.shop_id) : '';
  }
  if (!shopId) throw new Error('Unknown listing: ' + listingId);

  var live = ttGetProduct_(shopId, String(listingId));

  /**
   * Heal rows written before TikTok's sku id was being kept.
   *
   * Those rows cannot be carried forward if they go under review, because
   * there is nothing to keep them by. Every time one is visible here its id is
   * available, so it is recorded — which quietly repairs the listings that
   * existed before that field did, without anyone re-pushing.
   */
  var repairs = [];
  listSkus_(listingId).forEach(function (r) {
    if (String(r.status) !== 'pushed' || String(r.tiktok_sku_id || '')) return;
    var found = live.skus.filter(function (s) {
      return String(s.sellerSku) === String(r.identifier);
    })[0];
    if (found && found.id) {
      repairs.push({ sku_id: String(r.sku_id), tiktok_sku_id: String(found.id) });
    }
  });
  if (repairs.length) backfillSkuIds_(repairs);

  // Keyed by seller_sku, which is the identifier the app assigns and the only
  // field both sides agree on — a TikTok sku id is not known until after the
  // push, and a row pushed from another device would not have it locally.
  var bySellerSku = {};
  live.skus.forEach(function (s) {
    if (s.sellerSku) bySellerSku[String(s.sellerSku)] = s;
  });

  var variants = rows.map(function (r) {
    var match = bySellerSku[String(r.identifier)];
    var set = Number(r.stock || 0);
    var available = match ? Number(match.quantity || 0) : null;
    return {
      identifier: String(r.identifier || ''),
      variant: String(r.variant || ''),
      price: String(r.price || ''),
      status: String(r.status || ''),
      on_tiktok: Boolean(match),
      /**
       * TikTok acknowledged this variation, but is not returning it.
       *
       * Get Product omits a variation still under review, so absence alone
       * does not mean gone — B5 read as missing and went live shortly after.
       * Having TikTok's own sku id is the difference: it was issued when the
       * variation was created, so it proves TikTok took it. Without one, the
       * variation really is unaccounted for.
       */
      under_review: !match && Boolean(String(r.tiktok_sku_id || '')),
      /**
       * Not returned, and we have no id to prove TikTok ever took it.
       *
       * Genuinely ambiguous: under review and never created look identical
       * from here. It must not be reported as lost, because telling someone to
       * retry a variation that is merely pending adds a second copy — and it
       * must not be reported as fine either. Rows written before the id was
       * kept all land here, which is why this state exists at all.
       */
      unaccounted: !match && !String(r.tiktok_sku_id || ''),
      stock_set: set,
      stock_available: available,
      // Never negative: someone raising stock in Seller Center would otherwise
      // read as negative sales, which is worse than showing nothing.
      sold: available === null ? null : Math.max(0, set - available)
    };
  });

  return {
    listing_id: String(listingId),
    title: live.title,
    product_status: live.status,
    audit_reasons: live.auditReasons,
    variations_on_tiktok: live.skus.length,
    max_skus: MAX_SKUS_PER_PRODUCT,
    variants: variants,
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
function buildAppendPayload_(snapshot, addition, alsoKeep) {
  if (!snapshot.skus.length) {
    throw new Error('This listing has no variations to extend. TikTok requires at least one ' +
      'sales attribute on a product, so the first variation has to be created with the product.');
  }
  for (var i = 0; i < snapshot.skus.length; i++) {
    // Without an id we cannot say "keep this one", and TikTok would treat it as
    // a new SKU — duplicating it while deleting the original.
    if (!snapshot.skus[i].id) {
      throw new Error('TikTok returned a variation without an ID for this listing. Adding to ' +
        'it now would duplicate it, so nothing was sent. Try again in a moment.');
    }
    // 12052533: "Removal, addition, and change of warehouses are not
    // permitted. Please specify the original warehouses for the SKUs."
    if (!snapshot.skus[i].warehouseId) {
      throw new Error('TikTok did not return a warehouse for every existing variation. ' +
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
    throw new Error('A variation called "' + valueName + '" is already on this listing. ' +
      'Identifier ' + addition.identifier + ' looks to have been used twice.');
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
      throw new Error('Refusing to edit: variation ' +
        (snapshot.skus[j].sellerSku || snapshot.skus[j].id) +
        ' would have been deleted. This is a bug — nothing was sent to TikTok.');
    }
  }

  return { skus: skus, category_version: CATEGORY_VERSION };
}

function ttRecommendCategory_(prefix, title, imageUri) {
  var r = ttFetch_(prefix, 'post', '/product/202309/categories/recommend', {}, {
    product_title: title,
    images: [{ uri: imageUri }],
    category_version: CATEGORY_VERSION
  });
  if (r.code !== 0 || !r.data || !r.data.leaf_category_id) {
    throw new Error('Could not resolve a category: ' + (r.message || r.code));
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
  if (r.code !== 0) throw new Error('Could not read warehouses: ' + r.message);
  var usable = (r.data.warehouses || []).filter(function (w) {
    return w.type === 'SALES_WAREHOUSE' && w.effect_status === 'ENABLED';
  });
  var chosen = usable.filter(function (w) { return w.is_default; })[0] || usable[0];
  if (!chosen) {
    throw new Error('No enabled sales warehouse for this shop. Set one up in Seller Center first.');
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
  if (!shop) throw new Error('Unknown shop: ' + body.shop_id);

  if (!body.identifier || /\s/.test(body.identifier)) {
    throw new Error('SKU identifier is required and cannot contain spaces.');
  }
  if (!(Number(body.price) > 0)) throw new Error('Price must be more than zero.');
  var stock = Number(body.stock);
  if (!(stock >= 1 && stock <= 99999)) throw new Error('Stock must be between 1 and 99,999.');
  if (!body.photo_base64 && !body.tiktok_image_uri) throw new Error('A photo is required.');

  // The variant name is the ONLY text a SKU contributes. The product title
  // belongs to the listing and is set once, so it is validated only on the
  // path that creates one — holding a variation to a product title's
  // 25-character floor rejected every short variant name.
  var variantProblem = validateVariantName_(variantValueName_(body.identifier, body.variant_name));
  if (variantProblem) throw new Error(variantProblem);

  if (!body.listing_id) {
    var titleProblem = validateTitle_(body.title);
    if (titleProblem) throw new Error(titleProblem);
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
    if (body.photo_base64) {
      photoUrl = savePhoto_(prefix, body.identifier, body.photo_base64,
                            body.photo_mime || 'image/jpeg', user.name);
      var blob = Utilities.newBlob(
        Utilities.base64Decode(body.photo_base64),
        body.photo_mime || 'image/jpeg', 'product.jpg'
      );
      // Only the SKU that creates a listing needs a MAIN_IMAGE; every other
      // one is a variation and needs only the attribute image. Uploading just
      // what is needed halves the calls on the common path.
      attributeImageUri = ttUploadImage_(prefix, blob, 'ATTRIBUTE_IMAGE');
      if (!body.listing_id) imageUri = ttUploadImage_(prefix, blob, 'MAIN_IMAGE');
      else if (!imageUri) imageUri = attributeImageUri;
    }

    var addition = {
      identifier: body.identifier,
      variantName: body.variant_name || '',
      price: body.price,
      stock: stock,
      imageUri: attributeImageUri || imageUri
    };

    return body.listing_id
      ? addVariation_(body, user, prefix, shop, addition, photoUrl)
      : startNewListing_(body, user, prefix, shop, addition, imageUri, attributeImageUri, photoUrl);
  }
}

/** Add a variation to the listing this stream is already using. */
function addVariation_(body, user, prefix, shop, addition, photoUrl) {
  var listingId = String(body.listing_id);
  var snapshot = ttGetProduct_(prefix, listingId);

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
  var seen = {};
  snapshot.skus.forEach(function (sku) {
    if (sku.sellerSku) seen[String(sku.sellerSku)] = true;
  });
  var alsoKeep = listSkus_(listingId).filter(function (r) {
    return String(r.status) === 'pushed' &&
      String(r.identifier) !== addition.identifier &&
      !seen[String(r.identifier)] &&
      // Without TikTok's id there is nothing to keep it BY, and sending it
      // without one would create a duplicate rather than preserve the
      // original. Rows from before this was recorded fall here.
      String(r.tiktok_sku_id || '');
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
    throw new Error(edited.message || 'TikTok refused the variation.');
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
      throw new Error('Could not read the title of the listing this continues, so the new one ' +
        'cannot be named. Try again in a moment.');
    }
    title = continuationTitle_(parent.title);
  }
  var titleProblem = validateTitle_(title);
  if (titleProblem) throw new Error(titleProblem);

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
    throw new Error(check.message || 'Listing check failed.');
  }

  var created = ttFetch_(prefix, 'post', '/product/202309/products', {}, payload);
  if (created.code !== 0 || !created.data || !created.data.product_id) {
    recordFailure_(body, user, prefix, shop, photoUrl, input.imageUri, categoryId,
      created.message || 'no product id returned');
    throw new Error(created.message || 'TikTok returned no product ID.');
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
