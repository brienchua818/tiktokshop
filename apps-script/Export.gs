/**
 * Exports and photo filing, into dated folders in the shared drive.
 *
 * Structure, created on demand:
 *
 *   TikTok Livestream Buddy/
 *     Exports/2026/2026-09/2026-09-04/
 *       HOUZE - Katrin BJ Live - Brien Chua - 2026-09-04 1432.xlsx
 *     Product Photos/2026-09-04/HZ/
 *       A1 - Brien Chua - 1730.jpg
 *
 * Year and month levels exist so the folder list stays navigable — a flat
 * folder of dated exports is unusable after a few months of daily streams.
 * The creator's name is in the filename because Brien asked for files to carry
 * who made them, and a name in the filename survives being downloaded or
 * moved in a way that Drive metadata does not.
 */

function sgtDate_(d) {
  return Utilities.formatDate(d || new Date(), 'Asia/Singapore', 'yyyy-MM-dd');
}
function sgtStamp_(d) {
  return Utilities.formatDate(d || new Date(), 'Asia/Singapore', 'yyyy-MM-dd HHmm');
}

/**
 * The export naming convention, in one place so every file in the folder
 * sorts and reads the same way:
 *
 *     <what> - requested 2026-09-06 2359 by Brien Chua (brienchua@sheldonglobal.com).xlsx
 *
 * When it was produced and who asked for it are both in the name, because a
 * purchase order is something a factory is paid against, and "which one" and
 * "who sent it" are the two questions asked about it afterwards.
 */
function exportFilename_(what, requester) {
  return fileSafe_(what) + ' - requested ' + sgtStamp_() + ' by ' +
    fileSafe_(requester || 'unknown') + '.xlsx';
}

/**
 * Strip only what a filename cannot hold. Unlike safeName_, this keeps "@",
 * "." and brackets, so an email address survives into the name.
 */
function fileSafe_(text) {
  return String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Exports/2026/2026-09/2026-09-06" — where the file went, for the screen. */
function folderPath_(folder) {
  var parts = [];
  var f = folder;
  var guard = 0;
  while (f && guard++ < 6) {
    parts.unshift(f.getName());
    if (f.getId() === EXPORTS_FOLDER_ID) break;
    var it = f.getParents();
    f = it.hasNext() ? it.next() : null;
  }
  return parts.join('/');
}

/**
 * Photo size in the purchase order, in pixels, as Excel draws it at 100%.
 *
 * 128 px is about 3.4 cm on screen: large enough to tell two similar bowls
 * apart without zooming, which is the whole point of the column. The row is
 * made a little taller than the picture so nothing is clipped.
 */
var PHOTO_PX = 128;
var PHOTO_ROW_PX = PHOTO_PX + 10;
var PHOTO_COL_PX = PHOTO_PX + 14;

/**
 * What Sheets will accept as an inserted image. Both limits are enforced by
 * insertImage and both are documented; the export on 7 Sep failed on the
 * second one with a 1600x1600 photo (2.56 million pixels) that was well under
 * the byte limit. So every candidate is measured before it is offered.
 *
 *   https://developers.google.com/apps-script/reference/spreadsheet/sheet#insertimageblob,-column,-row
 */
var SHEETS_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
var SHEETS_IMAGE_MAX_PIXELS = 1000000;

/** Side length asked of Drive when it resizes a photo for the export. */
var PHOTO_FETCH_PX = 400;

/** The file id inside a Drive link, in either of the two shapes Drive issues. */
function driveFileId_(url) {
  var m = String(url || '').match(/\/d\/([A-Za-z0-9_-]+)/) ||
    String(url || '').match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Width and height of a PNG, JPEG or GIF from its bytes, or null if the format
 * is not one of those. Pure, and tested with hand-built headers.
 *
 * Apps Script has no image API, so the dimensions come from the file header:
 * PNG keeps them at a fixed offset, GIF too, and a JPEG holds them in its first
 * start-of-frame marker. Anything else is "unknown", and unknown is treated as
 * too big — the cost of a wrong guess is a failed export, the cost of a
 * cautious one is a resized copy.
 */
function imageDims_(bytes) {
  if (!bytes || bytes.length < 24) return null;
  var b = function (i) { return bytes[i] & 0xff; };
  // PNG: 8-byte signature, then IHDR with width and height as big-endian u32.
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) {
    return {
      width: (b(16) << 24 | b(17) << 16 | b(18) << 8 | b(19)) >>> 0,
      height: (b(20) << 24 | b(21) << 16 | b(22) << 8 | b(23)) >>> 0
    };
  }
  // GIF: "GIF8", then width and height as little-endian u16.
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) {
    return { width: b(6) | b(7) << 8, height: b(8) | b(9) << 8 };
  }
  // JPEG: walk the segments to the first SOFn marker.
  if (b(0) === 0xff && b(1) === 0xd8) {
    var i = 2;
    while (i + 9 < bytes.length) {
      if (b(i) !== 0xff) { i++; continue; }
      var marker = b(i + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      var len = b(i + 2) << 8 | b(i + 3);
      var isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { width: b(i + 7) << 8 | b(i + 8), height: b(i + 5) << 8 | b(i + 6) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * Whether Sheets will take this image, and if not, why — as a code.
 * Pure: takes the bytes, returns { ok, code, detail }.
 */
function sheetsImageFit_(bytes) {
  var size = bytes ? bytes.length : 0;
  if (!size) return { ok: false, code: 'TS-EXP-10', detail: 'empty image' };
  if (size > SHEETS_IMAGE_MAX_BYTES) {
    return { ok: false, code: 'TS-EXP-11', detail: Math.round(size / 1024) + ' KB exceeds the 2 MB limit' };
  }
  var dims = imageDims_(bytes);
  if (!dims) return { ok: false, code: 'TS-EXP-12', detail: 'unrecognised image format' };
  var pixels = dims.width * dims.height;
  if (pixels > SHEETS_IMAGE_MAX_PIXELS) {
    return {
      ok: false, code: 'TS-EXP-13',
      detail: dims.width + 'x' + dims.height + ' exceeds the 1,000,000-pixel limit'
    };
  }
  return { ok: true, code: '', detail: dims.width + 'x' + dims.height + ', ' + Math.round(size / 1024) + ' KB' };
}

/**
 * A copy of a Drive image no larger than `px` on its longest side, made by
 * Drive rather than here — Apps Script cannot resize an image, Drive can.
 *
 * The Drive API's thumbnailLink is a resizable URL: the trailing "=s220" is
 * the size, and asking for "=s400" returns a 400-pixel version. Null when
 * Drive has not generated a thumbnail yet (it lags a fresh upload by a few
 * seconds); the caller retries.
 */
function driveResized_(fileId, px) {
  var meta = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '?fields=thumbnailLink&supportsAllDrives=true',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
  );
  if (meta.getResponseCode() !== 200) {
    throw fail_('TS-EXP-14', 'Drive metadata read failed for ' + fileId + ': HTTP ' + meta.getResponseCode());
  }
  var link = JSON.parse(meta.getContentText()).thumbnailLink;
  if (!link) return null;
  var sized = link.replace(/=s\d+(-c)?$/, '=s' + px);
  var img = UrlFetchApp.fetch(sized, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (img.getResponseCode() !== 200) {
    throw fail_('TS-EXP-15', 'Drive thumbnail fetch failed for ' + fileId + ': HTTP ' + img.getResponseCode());
  }
  return img.getBlob();
}

/** How long to give Drive to produce a thumbnail for a file it has just received. */
var DRIVE_THUMB_ATTEMPTS = 5;
var DRIVE_THUMB_WAIT_MS = 1500;

/** driveResized_, retried across Drive's thumbnail lag. Null only after every attempt. */
function driveResizedWithRetry_(fileId, px) {
  for (var attempt = 1; attempt <= DRIVE_THUMB_ATTEMPTS; attempt++) {
    var blob = driveResized_(fileId, px);
    if (blob) return blob;
    if (attempt < DRIVE_THUMB_ATTEMPTS) Utilities.sleep(DRIVE_THUMB_WAIT_MS);
  }
  return null;
}

/**
 * The last resort resizer: render the image on a Google Slides page and take
 * the page's thumbnail through the Slides API, which is produced on demand
 * (no lag to wait out) at a fixed size — MEDIUM is 800 px wide, 360,000
 * pixels, a third of Sheets' cap. Slower than Drive and the result has the
 * page's white margins, so it is only used when both faster paths have
 * failed; but it depends on nothing that can lag or be missing.
 *
 * One temporary presentation per export, trashed in exportOrders_'s finally.
 */
var SLIDES_TEMP_ = null;

function slidesRender_(blob) {
  if (!SLIDES_TEMP_) SLIDES_TEMP_ = SlidesApp.create('tikshop-photo-render-temp');
  var pres = SLIDES_TEMP_;
  var slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
  var w = pres.getPageWidth();
  var h = pres.getPageHeight();
  var side = Math.min(w, h);
  var img = slide.insertImage(blob);
  // Fit inside a centred square, keeping the photo's own aspect ratio.
  var ratio = img.getWidth() / img.getHeight();
  var iw = ratio >= 1 ? side : side * ratio;
  var ih = ratio >= 1 ? side / ratio : side;
  img.setWidth(iw).setHeight(ih).setLeft((w - iw) / 2).setTop((h - ih) / 2);
  pres.saveAndClose();
  SLIDES_TEMP_ = SlidesApp.openById(pres.getId());

  var url = 'https://slides.googleapis.com/v1/presentations/' + pres.getId() +
    '/pages/' + slide.getObjectId() + '/thumbnail?thumbnailProperties.thumbnailSize=MEDIUM';
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw fail_('TS-EXP-19', 'Slides thumbnail failed: HTTP ' + res.getResponseCode() + ' ' +
      res.getContentText().slice(0, 200));
  }
  var contentUrl = JSON.parse(res.getContentText()).contentUrl;
  if (!contentUrl) throw fail_('TS-EXP-20', 'Slides returned no thumbnail URL.');
  var png = UrlFetchApp.fetch(contentUrl, { muteHttpExceptions: true });
  if (png.getResponseCode() !== 200) {
    throw fail_('TS-EXP-21', 'Slides thumbnail download failed: HTTP ' + png.getResponseCode());
  }
  return png.getBlob();
}

/** Trash the Slides scratch file, if one was needed. Safe to call when it was not. */
function discardSlidesTemp_() {
  if (!SLIDES_TEMP_) return;
  try { DriveApp.getFileById(SLIDES_TEMP_.getId()).setTrashed(true); } catch (e) { /* already gone */ }
  SLIDES_TEMP_ = null;
}

/**
 * TikTok's picture of a variation, kept in Drive under Product Photos/_tiktok
 * so it is fetched from TikTok once and resized by Drive like our own photos.
 * The by-product is an archive of every variation ever sold, including ones
 * this app did not create.
 */
function tiktokPhotoFile_(url, key) {
  var root = DriveApp.getFolderById(PHOTOS_FOLDER_ID);
  var cache = childFolder_(root, '_tiktok');
  var name = fileSafe_(key) + '.jpg';
  var existing = cache.getFilesByName(name);
  if (existing.hasNext()) return existing.next();
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) {
    throw fail_('TS-EXP-16', 'TikTok image fetch failed for ' + key + ': HTTP ' + res.getResponseCode());
  }
  var blob = res.getBlob().setName(name);
  return cache.createFile(blob);
}

/** identifier -> { photo, thumb } Drive links, from this listing's own SKU rows. */
function photoIndex_(listingId) {
  var idx = {};
  listSkus_(listingId).forEach(function (r) {
    if (!r.identifier) return;
    if (r.photo_url || r.photo_thumb_url) {
      idx[String(r.identifier)] = {
        photo: String(r.photo_url || ''),
        thumb: String(r.photo_thumb_url || '')
      };
    }
  });
  return idx;
}

/**
 * Where a variation's picture can come from, best first. Pure, so the order
 * is tested rather than trusted.
 *
 *   thumb    the 400 px copy the phone made at push time — already the right
 *            size, one Drive read, no resizing at all
 *   photo    our full photo, resized by Drive
 *   tiktok   TikTok's image of the variation as sold, cached to Drive, resized
 *            by Drive
 *
 * Whichever file is reached first is also what the Slides renderer is handed
 * if Drive cannot resize any of them.
 */
function photoCandidates_(ours, v) {
  var out = [];
  if (ours && ours.thumb) out.push({ source: 'thumb', fileId: driveFileId_(ours.thumb), direct: true });
  if (ours && ours.photo) out.push({ source: 'photo', fileId: driveFileId_(ours.photo) });
  if (v && v.sku_image) out.push({ source: 'tiktok', url: String(v.sku_image) });
  return out;
}

/**
 * The picture for one variation, sized for Sheets, or the reason there is none.
 *
 * Returns { blob, code, detail }. Nothing here throws to the caller; every
 * path is tried in turn and every failure is kept in `detail` with its code,
 * so the Log tab says exactly which resizer failed and why.
 *
 * Three resizers, in order: the phone's thumbnail (already small), Drive
 * (with retries for its thumbnail lag), Slides (on demand). The photo itself
 * is never inserted unless it measures within both Sheets limits.
 */
function variantPhoto_(v, photos) {
  var out = { blob: null, code: '', detail: '' };
  var key = String(v.seller_sku || v.sku_id || v.variation || 'variation');
  var candidates = photoCandidates_(photos[String(v.seller_sku || '')], v);
  if (!candidates.length) {
    out.code = 'TS-EXP-17';
    out.detail = 'no photo on record for ' + key;
    return out;
  }

  var problems = [];
  var firstFile = null;
  var accept = function (blob, source) {
    var fit = sheetsImageFit_(blob.getBytes());
    if (fit.ok) { out.blob = blob; out.detail = source + ' ' + fit.detail; return true; }
    problems.push(source + ': ' + fit.detail + ' [' + fit.code + ']');
    out.code = fit.code;
    return false;
  };

  for (var i = 0; i < candidates.length && !out.blob; i++) {
    var c = candidates[i];
    try {
      var file = c.fileId ? DriveApp.getFileById(c.fileId) : tiktokPhotoFile_(c.url, key);
      if (!firstFile) firstFile = file;
      if (c.direct && accept(file.getBlob(), c.source)) break;
      var resized = driveResizedWithRetry_(file.getId(), PHOTO_FETCH_PX);
      if (resized) { if (accept(resized, c.source + ' via Drive')) break; }
      else problems.push(c.source + ': Drive produced no thumbnail in ' +
        (DRIVE_THUMB_ATTEMPTS * DRIVE_THUMB_WAIT_MS / 1000) + 's [TS-EXP-22]');
    } catch (e) {
      problems.push(c.source + ': ' + (e && e.message ? e.message : e) + ' [' + codeOf_(e) + ']');
      out.code = codeOf_(e);
    }
  }

  // Both faster paths failed for every candidate; render the first file we
  // could reach through Slides, which does not depend on Drive's thumbnailer.
  if (!out.blob && firstFile) {
    try {
      accept(slidesRender_(firstFile.getBlob()), 'slides');
    } catch (e) {
      problems.push('slides: ' + (e && e.message ? e.message : e) + ' [' + codeOf_(e) + ']');
      out.code = codeOf_(e);
    }
  }

  if (!out.blob) {
    if (!out.code) out.code = 'TS-EXP-22';
    out.detail = key + ' — ' + problems.join('; ');
  }
  return out;
}

/**
 * Put one variation's photo in its row.
 *
 * Whatever happens in here is recorded (a warn row in the Log tab, with the
 * code) and the export carries on. Returns true if a picture was placed. When
 * none could be, the cell says so with the code — the reason is in the Log
 * tab and on the cell's note.
 */
function placePhoto_(sheet, rowIndex, v, photos, brand) {
  sheet.setRowHeight(rowIndex, PHOTO_ROW_PX);
  var photo = variantPhoto_(v, photos);
  if (photo.blob) {
    try {
      sheet.insertImage(photo.blob, 1, rowIndex, 6, 5).setWidth(PHOTO_PX).setHeight(PHOTO_PX);
      return true;
    } catch (e) {
      // Measured as fitting and still refused: that is the case to know about.
      photo.code = 'TS-EXP-18';
      photo.detail = (v.seller_sku || v.sku_id) + ' — insertImage refused a ' + photo.detail +
        ' image: ' + (e && e.message ? e.message : e);
    }
  }
  warn_(photo.code, 'export photo: ' + photo.detail, brand);
  sheet.getRange(rowIndex, 1)
    .setValue('photo unavailable [' + photo.code + ']')
    .setFontColor('#888888')
    .setNote('[' + photo.code + '] ' + photo.detail);
  return false;
}

/**
 * The public page of a TikTok Shop listing. What a factory or a colleague can
 * open without a Seller Center login; the id alone is not something anyone
 * can do anything with.
 */
function listingUrl_(listingId) {
  return 'https://shop.tiktok.com/view/product/' + String(listingId) + '?region=SG';
}

/** A clickable cell: shows `label` (the id by default), opens the listing. */
function listingLinkFormula_(listingId, label) {
  var id = String(listingId).replace(/"/g, '');
  var text = String(label === undefined ? id : label).replace(/"/g, '');
  return '=HYPERLINK("' + listingUrl_(id) + '","' + text + '")';
}

/** Find or create a child folder. Never creates a duplicate. */
function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Exports/YYYY/YYYY-MM/YYYY-MM-DD, created as needed. */
function datedExportFolder_(date) {
  var d = date || new Date();
  var day = sgtDate_(d);
  var root = DriveApp.getFolderById(EXPORTS_FOLDER_ID);
  var year = childFolder_(root, day.slice(0, 4));
  var month = childFolder_(year, day.slice(0, 7));
  return childFolder_(month, day);
}

/** Product Photos/YYYY-MM-DD/{shop}, created as needed. */
function datedPhotoFolder_(shopId, date) {
  var root = DriveApp.getFolderById(PHOTOS_FOLDER_ID);
  var day = childFolder_(root, sgtDate_(date));
  return childFolder_(day, shopId);
}

/**
 * File a product photo under the creator's name.
 *
 * Returns the Drive URL. This is our own archive — TikTok refuses external
 * image URLs, so the copy it lists is uploaded to TikTok separately.
 */
function savePhoto_(shopId, identifier, base64, mimeType, creatorName) {
  var folder = datedPhotoFolder_(shopId);
  var ext = (mimeType || 'image/jpeg').indexOf('png') > -1 ? 'png' : 'jpg';
  var name = identifier + ' - ' + safeName_(creatorName) + ' - ' +
    Utilities.formatDate(new Date(), 'Asia/Singapore', 'HHmm') + '.' + ext;
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType || 'image/jpeg', name);
  var file = folder.createFile(blob);
  return file.getUrl();
}

/**
 * Export a listing's SKUs as a real .xlsx into today's dated folder.
 *
 * Built by writing a temporary Google Sheet and exporting it, which is the
 * only way to produce genuine xlsx from Apps Script — a CSV renamed .xlsx
 * opens with a warning in Excel and Brien asked for Excel.
 */
function exportListing_(listingId, actor) {
  var skus = listSkus_(listingId).filter(function (s) { return String(s.status) === 'pushed'; });
  var listing = readAll_(TAB_LISTINGS).filter(function (l) {
    return String(l.listing_id) === String(listingId);
  })[0];
  if (!listing) throw fail_('TS-EXP-01', 'Unknown listing: ' + listingId);

  var header = ['Identifier', 'Title', 'Variant', 'Price (SGD)', 'Stock', 'Weight (kg)', 'Dimensions (cm)', 'TikTok product ID', 'Listed at (SGT)', 'Created by'];
  var rows = skus.map(function (s) {
    return [s.identifier, s.title, s.variant, s.price, s.stock, s.weight_kg, s.dims_cm, s.tiktok_product_id, s.pushed_at, s.created_by || ''];
  });

  var temp = SpreadsheetApp.create('tikshop-export-temp');
  try {
    var sh = temp.getActiveSheet();
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.setFrozenRows(1);
    SpreadsheetApp.flush();

    var url = 'https://docs.google.com/spreadsheets/d/' + temp.getId() +
      '/export?format=xlsx&portrait=false';
    var blob = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    }).getBlob();

    var filename = exportFilename_((listing.brand || listing.shop_id) + ' - ' +
      safeName_(listing.product_name || listingId), actor);
    blob.setName(filename);

    var file = datedExportFolder_().createFile(blob);
    logEvent_(actor, 'export', listing.brand, filename + ' (' + rows.length + ' SKUs)', 'ok');
    return { url: file.getUrl(), name: filename, rows: rows.length };
  } finally {
    // The temporary sheet is always removed, including when the export throws
    // — otherwise a failed export litters the drive with temp files.
    try { DriveApp.getFileById(temp.getId()).setTrashed(true); } catch (e) { /* already gone */ }
    discardSlidesTemp_();
  }
}


/**
 * The purchase order: what each factory supplied, and what it is owed.
 *
 * One workbook, a summary sheet and one sheet per listing, filed in the same
 * dated folder as everything else. Scoped to a date and time window, because a
 * listing outlives the stream that filled it — the whole reason the Orders
 * screen has a clock on it.
 *
 * > [!important] Cost is derived, not recorded
 * > The factory price is the selling price divided by a margin figure, which is
 * > how this business has always priced. That makes it an ARITHMETIC RESULT and
 * > not a fact about the goods: change the divisor and every cost on the sheet
 * > changes. The divisor is printed on the summary sheet for exactly that
 * > reason — a purchase order that cannot be reproduced from its own contents
 * > is not one anyone should sign.
 */
function exportOrders_(shopId, listingIds, fromDate, fromTime, toDate, toTime,
                       costDivisor, actor) {
  var shop = shopById_(shopId);
  if (!shop) throw fail_('TS-EXP-02', 'Unknown shop: ' + shopId);

  var divisor = Number(costDivisor || 0);
  // A divisor of zero or less is a division by zero or a negative price. Caught
  // here rather than producing Infinity in a column someone pays against.
  if (divisor && divisor <= 0) {
    throw fail_('TS-EXP-03', 'The cost divisor must be greater than zero.');
  }

  var summary = orderSummary_(shopId, fromDate, fromTime, toDate, toTime);
  var wanted = {};
  (listingIds || []).forEach(function (id) { wanted[String(id)] = 1; });

  var chosen = summary.listings.filter(function (l) {
    return !listingIds || !listingIds.length || wanted[l.listing_id];
  });
  if (!chosen.length) throw fail_('TS-EXP-04', 'No orders in that window for those listings.');

  var photosPlaced = 0;
  var photosMissing = 0;
  var temp = SpreadsheetApp.create('tikshop-orders-temp');
  try {
    var book = temp;
    var sh = book.getActiveSheet();
    sh.setName('Summary');

    var window = summary.from + '  to  ' + summary.to + '  (Singapore time)';
    var head = [
      ['Purchase order — ' + shop.brand],
      [window],
      [divisor ? 'Cost = selling price / ' + divisor : 'Selling prices only, no cost column'],
      ['Requested by ' + actor + ' on ' + sgtStamp_()],
      ['']
    ];
    sh.getRange(1, 1, head.length, 1).setValues(head);
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);

    // The id is a link (HYPERLINK survives the xlsx conversion; a rich-text
    // link may not) and the URL is also written out in plain text, so it can
    // be copied from a phone or a printout where a link cannot be tapped.
    var sumHeader = ['Listing', 'TikTok listing ID', 'Listing URL', 'Orders', 'Units', 'Revenue (SGD)'];
    if (divisor) sumHeader.push('Cost (SGD)');
    var sumRows = chosen.map(function (l) {
      var row = [
        l.product_name || l.listing_id, listingLinkFormula_(l.listing_id),
        listingUrl_(l.listing_id), l.order_count, l.units, round2_(l.revenue)
      ];
      if (divisor) row.push(round2_(l.revenue / divisor));
      return row;
    });

    var r0 = head.length + 1;
    sh.getRange(r0, 1, 1, sumHeader.length).setValues([sumHeader]).setFontWeight('bold');
    if (sumRows.length) sh.getRange(r0 + 1, 1, sumRows.length, sumHeader.length).setValues(sumRows);

    // Totals from the source figures, not from row positions, so adding a
    // column here cannot silently sum the wrong one.
    var sum = function (f) { return chosen.reduce(function (n, l) { return n + f(l); }, 0); };
    var totalRow = ['TOTAL', '', '',
      sum(function (l) { return l.order_count; }),
      sum(function (l) { return l.units; }),
      round2_(sum(function (l) { return l.revenue; }))];
    if (divisor) totalRow.push(round2_(sum(function (l) { return l.revenue; }) / divisor));
    sh.getRange(r0 + 1 + sumRows.length, 1, 1, totalRow.length)
      .setValues([totalRow]).setFontWeight('bold');

    sh.setFrozenRows(r0);
    for (var c = 1; c <= sumHeader.length; c++) sh.autoResizeColumn(c);

    // One sheet per listing: this is what a factory actually receives, and a
    // factory should not be handed another factory's figures.
    chosen.forEach(function (l) {
      var detail = listingOrders_(l.listing_id, fromDate, fromTime, toDate, toTime);
      var name = safeName_(l.product_name || l.listing_id).slice(0, 90) || l.listing_id;
      var s2 = book.insertSheet(uniqueSheetName_(book, name));

      var itemHeader = ['Photo', 'SKU', 'Variation', 'Units', 'Unit price (SGD)', 'Revenue (SGD)'];
      if (divisor) itemHeader.push('Unit cost (SGD)', 'Cost (SGD)');
      itemHeader.push('Cancelled / unpaid units');

      var itemRows = detail.variations.map(function (v) {
        var unitPrice = v.units ? v.revenue / v.units : Number(v.price || 0);
        var row = [
          '', v.seller_sku || '', v.variation, v.units, round2_(unitPrice), round2_(v.revenue)
        ];
        if (divisor) row.push(round2_(unitPrice / divisor), round2_(v.revenue / divisor));
        row.push(v.unsold_units);
        return row;
      });

      var top = [
        [l.product_name || l.listing_id],
        ['TikTok listing ' + l.listing_id + '   ·   ' + window],
        [listingLinkFormula_(l.listing_id, listingUrl_(l.listing_id))],
        ['']
      ];
      s2.getRange(1, 1, top.length, 1).setValues(top);
      s2.getRange(1, 1).setFontWeight('bold').setFontSize(12);

      var h0 = top.length + 1;
      s2.getRange(h0, 1, 1, itemHeader.length).setValues([itemHeader]).setFontWeight('bold');
      if (itemRows.length) {
        s2.getRange(h0 + 1, 1, itemRows.length, itemHeader.length).setValues(itemRows);
      }

      var tot = ['', 'TOTAL', '', detail.total_units, '', round2_(detail.total_revenue)];
      if (divisor) tot.push('', round2_(detail.total_revenue / divisor));
      tot.push(detail.variations.reduce(function (n, v) { return n + v.unsold_units; }, 0));
      s2.getRange(h0 + 1 + itemRows.length, 1, 1, tot.length)
        .setValues([tot]).setFontWeight('bold');

      s2.setFrozenRows(h0);
      // Text columns fit themselves; the photo column is fixed to the picture.
      for (var k = 2; k <= itemHeader.length; k++) s2.autoResizeColumn(k);
      s2.setColumnWidth(1, PHOTO_COL_PX);

      // One picture per variation, anchored to its row. Over-grid images are
      // what the xlsx export keeps as pictures; an IMAGE() formula would not
      // survive the conversion, and a Drive link is not a photo. Each one is
      // measured against Sheets' limits first and can only ever degrade to a
      // link in its own cell — never fail the workbook.
      var photos = photoIndex_(l.listing_id);
      detail.variations.forEach(function (v, i) {
        if (placePhoto_(s2, h0 + 1 + i, v, photos, shop.brand)) photosPlaced++;
        else photosMissing++;
      });
      // Numbers read best against the top of a tall row's picture.
      if (itemRows.length) {
        s2.getRange(h0 + 1, 2, itemRows.length, itemHeader.length - 1).setVerticalAlignment('middle');
      }
    });

    SpreadsheetApp.flush();

    var url = 'https://docs.google.com/spreadsheets/d/' + book.getId() +
      '/export?format=xlsx';
    var blob = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    }).getBlob();

    var filename = exportFilename_(
      shop.brand + ' - Purchase order ' + fromDate +
        (fromDate === toDate ? '' : ' to ' + toDate),
      actor);
    blob.setName(filename);

    var folder = datedExportFolder_();
    var file = folder.createFile(blob);
    logEvent_(actor, 'export_orders', shop.brand,
      filename + ' (' + chosen.length + ' listings, ' + photosPlaced + ' photos, ' +
      photosMissing + ' missing)', 'ok');

    return {
      url: file.getUrl(),
      name: filename,
      folder: folderPath_(folder),
      folder_url: folder.getUrl(),
      photos_placed: photosPlaced,
      photos_missing: photosMissing,
      listings: chosen.length,
      units: summary.total_units,
      revenue: summary.total_revenue,
      cost_divisor: divisor || null
    };
  } finally {
    try { DriveApp.getFileById(temp.getId()).setTrashed(true); } catch (e) { /* already gone */ }
  }
}

/** Money, to cents. Float addition otherwise leaves 0.30000000000000004 on a PO. */
function round2_(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * A sheet name that is free, and legal.
 *
 * Two factories can share a product name, and Sheets refuses a duplicate name
 * with an exception that would lose the whole export at the last step.
 */
function uniqueSheetName_(book, base) {
  var name = String(base || 'Listing').slice(0, 90);
  var n = 2;
  while (book.getSheetByName(name)) {
    name = String(base).slice(0, 85) + ' (' + n + ')';
    n++;
  }
  return name;
}
