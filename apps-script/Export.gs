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
  if (!listing) throw new Error('Unknown listing: ' + listingId);

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

    var filename = (listing.brand || listing.shop_id) + ' - ' +
      safeName_(listing.product_name || listingId) + ' - ' +
      safeName_(actor) + ' - ' + sgtStamp_() + '.xlsx';
    blob.setName(filename);

    var file = datedExportFolder_().createFile(blob);
    logEvent_(actor, 'export', listing.brand, filename + ' (' + rows.length + ' SKUs)', 'ok');
    return { url: file.getUrl(), name: filename, rows: rows.length };
  } finally {
    // The temporary sheet is always removed, including when the export throws
    // — otherwise a failed export litters the drive with temp files.
    try { DriveApp.getFileById(temp.getId()).setTrashed(true); } catch (e) { /* already gone */ }
  }
}
