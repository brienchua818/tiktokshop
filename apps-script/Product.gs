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
  // Anything outside Latin-1 plus common punctuation: catches Chinese, which
  // TikTok refuses in product names, and emoji.
  if (/[^\u0020-\u024F\u2018\u2019\u201C\u201D\u2013\u2014]/.test(t)) {
    return 'Title must be English. TikTok rejects Chinese characters and emoji in product names.';
  }
  if (!/[a-zA-Z0-9]/.test(t)) return 'Title cannot be only symbols.';
  if (/(.)\1{9,}/.test(t)) return 'Title repeats one character more than nine times in a row.';
  return '';
}

function ttUploadImage_(prefix, blob) {
  var r = ttFetch_(prefix, 'post', '/product/202309/images/upload', { use_case: 'MAIN_IMAGE' }, blob);
  if (r.code !== 0) throw new Error('Image upload failed: ' + (r.message || r.code));
  return r.data.uri;
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
      inventory: [{ warehouse_id: warehouseId, quantity: Number(input.stock) }]
    }],
    save_mode: 'LISTING',
    // Makes a timed-out create safe to retry without duplicating the product.
    idempotency_key: input.idempotencyKey
  };
  if (attributes && attributes.length) payload.product_attributes = attributes;
  return payload;
}

/**
 * Push one SKU. Validates, files the photo, lists, records and logs.
 *
 * Validation runs here as well as in the browser: the client checks are for
 * fast feedback, these are the ones that actually protect the shop.
 */
function pushSku_(body, user) {
  var prefix = String(body.shop_id || '').toUpperCase();
  var shop = shopById_(prefix);
  if (!shop) throw new Error('Unknown shop: ' + body.shop_id);

  var titleProblem = validateTitle_(body.title);
  if (titleProblem) throw new Error(titleProblem);
  if (!body.identifier || /\s/.test(body.identifier)) {
    throw new Error('SKU identifier is required and cannot contain spaces.');
  }
  if (!(Number(body.price) > 0)) throw new Error('Price must be more than zero.');
  var stock = Number(body.stock);
  if (!(stock >= 1 && stock <= 99999)) throw new Error('Stock must be between 1 and 99,999.');
  if (!body.photo_base64 && !body.tiktok_image_uri) throw new Error('A photo is required.');

  // A retry after a timeout arrives with the same key. Returning the original
  // product is what makes the offline queue safe.
  if (body.idempotency_key) {
    var prior = findByIdempotencyKey_(body.idempotency_key);
    if (prior) {
      return { product_id: prior.tiktok_product_id, deduplicated: true };
    }
  }

  // Archive the photo under the creator's name, then hand a copy to TikTok —
  // it refuses external image URLs, so it needs its own upload.
  var photoUrl = '';
  var imageUri = body.tiktok_image_uri || '';
  if (body.photo_base64) {
    photoUrl = savePhoto_(prefix, body.identifier, body.photo_base64,
                          body.photo_mime || 'image/jpeg', user.name);
    var blob = Utilities.newBlob(
      Utilities.base64Decode(body.photo_base64),
      body.photo_mime || 'image/jpeg', 'product.jpg'
    );
    imageUri = ttUploadImage_(prefix, blob);
  }

  var input = {
    title: String(body.title).trim(),
    identifier: body.identifier,
    price: body.price,
    stock: stock,
    weightKg: body.weight_kg || DEFAULT_WEIGHT_KG,
    imageUri: imageUri,
    idempotencyKey: body.idempotency_key || Utilities.getUuid()
  };

  var categoryId = ttRecommendCategory_(prefix, input.title, imageUri);
  var attributes = ttRequiredAttributes_(prefix, categoryId);
  var warehouseId = ttWarehouseId_(prefix);
  var payload = buildPayload_(input, categoryId, warehouseId, attributes);

  // Dry run first: a rejection at create time still counts against the daily
  // allowance, and during a livestream that allowance is the scarce resource.
  var check = ttFetch_(prefix, 'post', '/product/202309/products/listing_check', {}, payload);
  if (check.code !== 0) {
    recordFailure_(body, user, prefix, shop, photoUrl, imageUri, categoryId, check.message);
    throw new Error(check.message || 'Listing check failed.');
  }

  var created = ttFetch_(prefix, 'post', '/product/202309/products', {}, payload);
  if (created.code !== 0 || !created.data || !created.data.product_id) {
    recordFailure_(body, user, prefix, shop, photoUrl, imageUri, categoryId,
      created.message || 'no product id returned');
    // TikTok's own wording, verbatim. "You haven't set the return warehouse"
    // is actionable; "push failed" is not.
    throw new Error(created.message || 'TikTok returned no product ID.');
  }

  recordSku_({
    sku_id: Utilities.getUuid(), listing_id: body.listing_id, shop_id: prefix,
    brand: shop.brand, identifier: input.identifier, title: input.title,
    variant: body.variant_name || '', price: input.price, stock: input.stock,
    weight_kg: input.weightKg,
    dims_cm: DEFAULT_DIMS.length + 'x' + DEFAULT_DIMS.width + 'x' + DEFAULT_DIMS.height,
    tiktok_image_uri: imageUri, photo_url: photoUrl, category_id: categoryId,
    status: 'pushed', error: '', tiktok_product_id: created.data.product_id,
    idempotency_key: input.idempotencyKey,
    created_at: new Date().toISOString(), pushed_at: new Date().toISOString(),
    created_by: user.name
  });

  logEvent_(user.name, 'push_sku', shop.brand,
    input.identifier + ' ' + input.title + ' -> ' + created.data.product_id, 'ok');

  return { product_id: created.data.product_id, photo_url: photoUrl };
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
