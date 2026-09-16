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
 * Archive a photo, and never fail a listing because the archive failed.
 *
 * Brien, HOUZE, 16 Sep: WX11 and WX12 both stopped with
 * "Exception: Service error: Drive" and were never listed. Drive had a bad
 * minute — which it periodically does, and which this app cannot prevent —
 * and because `savePhoto_` runs BEFORE the TikTok upload, a wobble in our own
 * record-keeping stopped two products going live mid-broadcast.
 *
 * That is the wrong way round. The archive is ours; the listing is the
 * business. The export already tries three sources for a variation's picture
 * (`photoCandidates_`: the phone's thumbnail, our Drive copy, then TikTok's),
 * so a missing Drive copy costs a fallback, not a photo.
 *
 * Retried first, because "Service error: Drive" is transient by nature and one
 * more attempt a second later usually lands. If it still fails, the push
 * carries on with no archive URL and says so in the log, where TS-EXP-26 can
 * be matched against the SKU afterwards.
 */
function savePhotoOptional_(shopId, identifier, base64, mimeType, creatorName) {
  var last = null;
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      return savePhoto_(shopId, identifier, base64, mimeType, creatorName);
    } catch (e) {
      last = e;
      // Drive's own transient failures clear in about a second. Anything
      // structural — a missing folder, no permission — fails all three the
      // same way and is reported identically, which is correct: either way the
      // listing must not be held up by it.
      if (attempt < 3) Utilities.sleep(700 * attempt);
    }
  }
  warn_('TS-EXP-26', 'Could not archive the photo for ' + identifier + ' to Drive after 3 tries (' +
    (last && last.message ? last.message : last) + '). The SKU is being listed anyway; ' +
    'the export will fall back to TikTok\u2019s copy of the picture.');
  return '';
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
/**
 * The columns a purchase order shows for one tally, and the values under them.
 *
 * Brien, 15 Sep: *"It should show on each variation or listing: total sold,
 * total cancelled, net sold, total sales, cancelled sales, net sales."* Those
 * six are always here, under his names.
 *
 * The other four buckets — refunded, awaiting return, on hold, unrecognised —
 * appear ONLY when something in this export is in one of them. They have to be
 * able to appear, because the six alone stop adding up the moment one is not
 * empty: net sold is total sold minus EVERY bucket, not just cancelled. A
 * sheet where the subtraction visibly fails and no column explains why is
 * worse than a wider sheet, and this one is paid against.
 *
 * One spec, used by both the Summary sheet and every factory's sheet, so the
 * two cannot show different columns for the same figures.
 */
var TALLY_COLUMNS = [
  { key: 'ordered_units', label: 'Total sold', always: true },
  { key: 'cancelled_units', label: 'Cancelled', always: true },
  { key: 'refunded_units', label: 'Refunded' },
  { key: 'at_risk_units', label: 'Awaiting return' },
  { key: 'held_units', label: 'On hold' },
  { key: 'unknown_units', label: 'Unrecognised' },
  { key: 'sold_units', label: 'Net sold', always: true },
  { key: 'ordered_value', label: 'Total sales (SGD)', always: true, money: true },
  { key: 'cancelled_value', label: 'Cancelled sales (SGD)', always: true, money: true },
  { key: 'refunded_value', label: 'Refunded sales (SGD)', money: true, showWith: 'refunded_units' },
  { key: 'at_risk_value', label: 'Awaiting return (SGD)', money: true, showWith: 'at_risk_units' },
  { key: 'held_value', label: 'On hold (SGD)', money: true, showWith: 'held_units' },
  { key: 'unknown_value', label: 'Unrecognised (SGD)', money: true, showWith: 'unknown_units' },
  { key: 'sold_value', label: 'Net sales (SGD)', always: true, money: true }
];

/** Which of those columns this export needs. Pure, so it is asserted. */
function tallyColumns_(tallies) {
  var live = {};
  (tallies || []).forEach(function (t) {
    TALLY_COLUMNS.forEach(function (c) {
      if (Number((t || {})[c.key] || 0) !== 0) live[c.key] = true;
    });
  });
  return TALLY_COLUMNS.filter(function (c) {
    return c.always || !!live[c.showWith || c.key];
  });
}

function tallyHeader_(cols) {
  return cols.map(function (c) { return c.label; });
}

function tallyValues_(cols, t) {
  return cols.map(function (c) {
    var n = Number((t || {})[c.key] || 0);
    return c.money ? round2_(n) : n;
  });
}

/**
 * How net sold was arrived at, in words, for whoever signs the sheet off.
 *
 * Written from the columns actually present, so it can never describe a
 * subtraction the sheet does not show.
 */
function netExplainer_(cols) {
  var taken = cols.filter(function (c) {
    return !c.money && c.key !== 'ordered_units' && c.key !== 'sold_units';
  }).map(function (c) { return c.label.toLowerCase(); });
  return 'Net sold = total sold \u2212 ' + taken.join(' \u2212 ') +
    '.   Net sales is the same subtraction in money, and is what the factory is paid on.';
}

/**
 * The rows themselves, as functions.
 *
 * setValues throws when an array is not exactly the width of its range, and
 * exportOrders_ has no per-sheet failsafe: one mismatch kills the whole
 * workbook AFTER every photo has been fetched, which on a stream night is the
 * export failing at the last step. The column count is now data-dependent —
 * it varies with the cost divisor and with which buckets are non-zero — so
 * "the header and the row obviously match" stopped being something a reader
 * can check by eye.
 *
 * Pulled out of the sheet-writing loop so the tests call THESE rather than
 * re-implementing them. A test that rebuilds the header itself passes happily
 * while the export writes something else, which is the exact shape of a test
 * that cannot fail.
 */
/**
 * The block above the Summary table, and which of its rows must be bold.
 *
 * Returns `{ rows, alert }` — `alert` being the 1-based row the reconciliation
 * warning starts on, or 0 when there is nothing to warn about.
 *
 * It returns that index rather than the caller computing it, because the
 * caller used to bold row 5 on the assumption that the block was five rows
 * long. Adding the line that explains the subtraction made that assumption
 * silently wrong, and a warning that says CHECK BEFORE PAYING in the same
 * weight as the surrounding text is a warning nobody reads.
 */
function summaryHeadRows_(shop, window, divisor, actor, cols, reconciliation) {
  var rows = [
    ['Purchase order \u2014 ' + shop.brand],
    [window],
    [divisor ? 'Cost = selling price / ' + divisor : 'Selling prices only, no cost column'],
    ['Requested by ' + actor + ' on ' + sgtStamp_()],
    [netExplainer_(cols)],
    ['']
  ];

  /**
   * The reconciliation, on the face of the purchase order.
   *
   * Not in a log nobody opens. Whoever signs this off is the person who can
   * tell a cancelled order from one TikTok merely did not return, and they can
   * only do that if the question reaches them \u2014 so it sits above the
   * numbers it affects, not beside them.
   */
  var r = reconciliation || {};
  var at = 4;
  var alert = 0;
  if (r.error) {
    alert = at + 1;
    rows.splice(at, 0,
      ['NOT CHECKED against TikTok: ' + r.error],
      ['These figures are the Sheet as recorded, which may include orders TikTok has since dropped.'],
      ['']);
  } else if ((r.missing || []).length) {
    alert = at + 1;
    rows.splice(at, 0,
      ['CHECK BEFORE PAYING: ' + r.missing.length + ' recorded order(s) are not in ' +
       'TikTok\u2019s list for this window'],
      ['They carry ' + r.units + ' unit(s) counted as sold below. They may have been ' +
       'cancelled and dropped, or may simply be missing from that response.'],
      ['Orders: ' + r.missing.slice(0, 12).join(', ') +
       (r.missing.length > 12
         ? ' and ' + (r.missing.length - 12) + ' more \u2014 see the Log tab'
         : '')],
      ['']);
  } else if (r.checked) {
    rows.splice(at, 0,
      ['Checked against TikTok: all ' + r.checked +
       ' recorded line(s) in this window are still on TikTok.'],
      ['']);
  }
  return { rows: rows, alert: alert };
}

/**
 * The block above one factory's table.
 *
 * Hardened the same way as `summaryRow_`, and for the same reason: setValues
 * throws on `undefined`, so a listing carrying neither a name nor an id would
 * have taken the whole workbook down rather than leaving one blank cell. The
 * first row used to be `l.product_name || l.listing_id` with nothing beneath
 * it.
 */
function listingTopRows_(l, window, cols) {
  var id = String(l.listing_id == null ? '' : l.listing_id);
  return [
    [String(l.product_name || id || '\u2014')],
    ['TikTok listing ' + (id || '\u2014') + '   \u00b7   ' + String(window || '')],
    [listingLinkFormula_(id, listingUrl_(id))],
    [netExplainer_(cols)],
    ['']
  ];
}

/**
 * Distinct orders across the listings this export actually includes.
 *
 * `summariseItems_` already warns that a basket holding two listings is ONE
 * order and must not be counted twice — and then the TOTAL line summed the
 * per-listing counts anyway, one function later, saying two.
 *
 * Per listing the count is right: each factory's sheet should say how many
 * orders touched it, and a shared basket touched both. It is only the TOTAL
 * that has to de-duplicate, and it cannot simply reuse `summary.total_orders`
 * either, because the export may have been asked for a subset of listings.
 */
function summaryOrderCount_(chosen, summary) {
  var seen = {};
  var complete = true;
  (chosen || []).forEach(function (l) {
    if (!l.order_ids) { complete = false; return; }
    l.order_ids.forEach(function (id) { seen[String(id)] = 1; });
  });
  // A backend that predates `order_ids` still has to produce a figure. The
  // window's own distinct count is the honest fallback: right when the export
  // covers every listing, and never the double-counted sum.
  if (!complete) return Number((summary || {}).total_orders || 0);
  return Object.keys(seen).length;
}

function summaryHeader_(cols, divisor) {
  // The id is a link (HYPERLINK survives the xlsx conversion; a rich-text link
  // may not) and the URL is also written out in plain text, so it can be
  // copied from a phone or a printout where a link cannot be tapped.
  var head = ['Listing', 'TikTok listing ID', 'Listing URL', 'Orders']
    .concat(tallyHeader_(cols));
  // Cost follows NET sales, not total: the factory is paid for what was kept.
  // Naming it "Net cost" says so, now that three sales columns sit beside it
  // and an unqualified "Cost" would not say which one it came from.
  if (divisor) head.push('Net cost (SGD)');
  return head;
}

function summaryRow_(cols, divisor, l) {
  /**
   * Every identity cell is coerced to a string it is not.
   *
   * setValues throws on `undefined`, and it throws AFTER the photos have been
   * fetched — so a listing missing a field it was assumed to have costs the
   * whole workbook rather than one blank cell. A blank cell is a question
   * somebody can ask; a failed export on a stream night is not.
   */
  var id = String(l.listing_id == null ? '' : l.listing_id);
  var row = [
    String(l.product_name ? l.product_name + ' \u2014 not attributed to a listing'
                          : (id || 'Not attributed to a listing')),
    id ? listingLinkFormula_(id) : '', id ? listingUrl_(id) : '',
    Number(l.order_count || 0)
  ].concat(tallyValues_(cols, l));
  if (divisor) row.push(round2_(Number(l.sold_value || 0) / divisor));
  return row;
}

function summaryTotalRow_(cols, divisor, totals, orderCount, rows) {
  var row = ['TOTAL', '', '', Number(orderCount || 0)].concat(tallyValues_(cols, totals));
  if (divisor) {
    /**
     * The sum of the cost column, not the total divided again.
     *
     * Each row's cost is rounded to cents before it is written, so dividing
     * the grand total instead re-derives a figure the column above does not
     * add up to — off by a cent or two on a long sheet, which is exactly the
     * kind of thing somebody signing a purchase order notices and stops for.
     */
    row.push(round2_((rows || []).reduce(function (n, l) {
      return n + round2_(Number(l.sold_value || 0) / divisor);
    }, 0)));
  }
  return row;
}

function itemHeader_(cols, divisor) {
  var head = ['Photo', 'SKU', 'Variation', 'Unit price (SGD)'].concat(tallyHeader_(cols));
  if (divisor) head.push('Unit cost (SGD)', 'Net cost (SGD)');
  return head;
}

/**
 * Per unit of what was ORDERED, so cancelling a unit cannot move the price.
 *
 * Dividing net sales by net units gives the same answer while both are
 * non-zero, and a wrong one the moment a line is cancelled at a different
 * price — or a divide-by-zero the moment everything was cancelled.
 */
function unitPriceOf_(v) {
  var ordered = Number(v.ordered_units || 0);
  if (ordered > 0) return Number(v.ordered_value || 0) / ordered;
  var listed = Number(v.price || 0);
  return isFinite(listed) ? listed : 0;
}

function itemRow_(cols, divisor, v) {
  var unitPrice = unitPriceOf_(v);
  var row = ['', String(v.seller_sku || ''), String(v.variation || ''), round2_(unitPrice)]
    .concat(tallyValues_(cols, v));
  if (divisor) row.push(round2_(unitPrice / divisor), round2_(Number(v.sold_value || 0) / divisor));
  return row;
}

function itemTotalRow_(cols, divisor, totals, rows) {
  // Every figure here is the sum of the column above it, taken from the same
  // spec that wrote the column. Adding a column can no longer leave a TOTAL
  // that does not match it — and nor can the cost column, which is summed from
  // the rounded per-row figures rather than re-derived from the grand total.
  var row = ['', 'TOTAL', '', ''].concat(tallyValues_(cols, totals));
  if (divisor) {
    row.push('', round2_((rows || []).reduce(function (n, v) {
      return n + round2_(Number(v.sold_value || 0) / divisor);
    }, 0)));
  }
  return row;
}

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

  /**
   * Check the window against TikTok before building anything from it.
   *
   * This is the moment the number decides what a factory is paid, and until
   * now nothing had ever compared the Sheet against TikTok. An order that
   * stopped being returned sat at its last-seen status for ever and was
   * counted as sold in every export made afterwards.
   *
   * It never blocks the export. The check cannot tell a cancelled-and-dropped
   * order from one merely absent from that response, so refusing to build
   * would be as wrong as building silently. It reports, on the sheet where the
   * money is, and the person paying decides.
   */
  var reconciliation = { checked: 0, missing: [], units: 0 };
  try {
    reconciliation = reconcileWindow_(
      shopId,
      sgtEpoch_(fromDate, fromTime || '00:00'),
      sgtEndEpoch_(toDate, toTime)
    );
  } catch (e) {
    warn_('TS-EXP-23', 'Could not reconcile this window against TikTok: ' + e +
      '. The export is built from the Sheet as recorded.');
    reconciliation.error = String(e && e.message ? e.message : e);
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
  // Chosen once, so the line that explains the subtraction and the columns
  // that perform it can never describe different sheets.
  var sumCols = tallyColumns_(chosen);

  var temp = SpreadsheetApp.create('tikshop-orders-temp');
  try {
    var book = temp;
    var sh = book.getActiveSheet();
    sh.setName('Summary');

    var window = summary.from + '  to  ' + summary.to + '  (Singapore time)';
    var block = summaryHeadRows_(shop, window, divisor, actor, sumCols, reconciliation);
    var head = block.rows;

    sh.getRange(1, 1, head.length, 1).setValues(head);
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
    // The row the block itself says the warning is on, not a row this code
    // assumes it is on.
    if (block.alert) sh.getRange(block.alert, 1).setFontWeight('bold');

    // The id is a link (HYPERLINK survives the xlsx conversion; a rich-text
    // link may not) and the URL is also written out in plain text, so it can
    // be copied from a phone or a printout where a link cannot be tapped.
    var sumHeader = summaryHeader_(sumCols, divisor);
    var sumRows = chosen.map(function (l) { return summaryRow_(sumCols, divisor, l); });

    var r0 = head.length + 1;
    sh.getRange(r0, 1, 1, sumHeader.length).setValues([sumHeader]).setFontWeight('bold');
    if (sumRows.length) sh.getRange(r0 + 1, 1, sumRows.length, sumHeader.length).setValues(sumRows);

    // Totals from the source figures, not from row positions, so adding a
    // column here cannot silently sum the wrong one.
    var sumTotals = chosen.reduce(function (t, l) { return addTally_(t, l); }, emptyTally_());
    var totalRow = summaryTotalRow_(sumCols, divisor, sumTotals,
      summaryOrderCount_(chosen, summary), chosen);
    sh.getRange(r0 + 1 + sumRows.length, 1, 1, totalRow.length)
      .setValues([totalRow]).setFontWeight('bold');

    sh.setFrozenRows(r0);
    for (var c = 1; c <= sumHeader.length; c++) sh.autoResizeColumn(c);

    // One sheet per listing: this is what a factory actually receives, and a
    // factory should not be handed another factory's figures.
    chosen.forEach(function (l) {
      /**
       * Lines TikTok gave us with no listing id get a row on the Summary, and
       * no sheet of their own.
       *
       * There is no listing to open, no photo to place and no factory to send
       * it to, and asking listingOrders_ for a blank id produces a sheet with
       * a TOTAL and no lines under it. The Summary row still carries their
       * units and money, so nothing is hidden — it is simply not pretending to
       * be a purchase order for a factory nobody can name.
       */
      if (!String(l.listing_id || '')) {
        warn_('TS-EXP-25', l.ordered_units + ' unit(s) of "' + (l.product_name || 'an unnamed product') +
          '" carry no listing id. They are on the Summary but have no sheet of their own.');
        return;
      }
      var detail = listingOrders_(l.listing_id, fromDate, fromTime, toDate, toTime);
      // Same hazard as the cells: a blank name must not become the string
      // "undefined" on the tab of a document a factory receives.
      var name = safeName_(String(l.product_name || l.listing_id || 'Listing'))
        .slice(0, 90) || String(l.listing_id || 'Listing');
      var s2 = book.insertSheet(uniqueSheetName_(book, name));

      // Columns from the same spec as the Summary sheet, chosen from THIS
      // listing's rows — a factory with no refunds is not shown a refund
      // column just because another factory in the same export had one.
      var itemCols = tallyColumns_(detail.variations);
      var itemHeader = itemHeader_(itemCols, divisor);
      var itemRows = detail.variations.map(function (v) {
        return itemRow_(itemCols, divisor, v);
      });

      var top = listingTopRows_(l, window, itemCols);
      s2.getRange(1, 1, top.length, 1).setValues(top);
      s2.getRange(1, 1).setFontWeight('bold').setFontSize(12);

      var h0 = top.length + 1;
      s2.getRange(h0, 1, 1, itemHeader.length).setValues([itemHeader]).setFontWeight('bold');
      if (itemRows.length) {
        s2.getRange(h0 + 1, 1, itemRows.length, itemHeader.length).setValues(itemRows);
      }

      var tot = itemTotalRow_(itemCols, divisor, detail.totals, detail.variations);
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
