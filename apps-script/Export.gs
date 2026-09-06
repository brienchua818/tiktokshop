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
/** Sheets refuses an inserted image above this. Thumbnails are far under it. */
var PHOTO_MAX_BYTES = 2 * 1024 * 1024;

/** The file id inside a Drive link, in either of the two shapes Drive issues. */
function driveFileId_(url) {
  var m = String(url || '').match(/\/d\/([A-Za-z0-9_-]+)/) ||
    String(url || '').match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

/** identifier -> Drive photo link, from this listing's own SKU rows. */
function photoIndex_(listingId) {
  var idx = {};
  listSkus_(listingId).forEach(function (r) {
    if (r.identifier && r.photo_url) idx[String(r.identifier)] = String(r.photo_url);
  });
  return idx;
}

/**
 * The picture for one variation on the purchase order, or null.
 *
 * Our own Drive copy first, as a thumbnail: it is the photo taken at the
 * factory, and a thumbnail keeps the workbook small. Otherwise the image TikTok
 * attached to the order line, which exists for every variation TikTok has ever
 * sold, including ones added in Seller Center. A failure here is a missing
 * picture, never a failed export — the figures matter more than the photo.
 */
function variantPhoto_(v, photos) {
  var driveUrl = photos[String(v.seller_sku || '')];
  if (driveUrl) {
    try {
      var file = DriveApp.getFileById(driveFileId_(driveUrl));
      var thumb = file.getThumbnail();
      var blob = thumb || file.getBlob();
      if (blob && blob.getBytes().length <= PHOTO_MAX_BYTES) return blob;
    } catch (e) {
      console.warn('Drive photo unavailable for ' + v.seller_sku + ': ' + e);
    }
  }
  if (v.sku_image) {
    try {
      var res = UrlFetchApp.fetch(v.sku_image, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        var b = res.getBlob();
        if (b.getBytes().length <= PHOTO_MAX_BYTES) return b;
      }
    } catch (e2) {
      console.warn('TikTok photo unavailable for ' + (v.seller_sku || v.sku_id) + ': ' + e2);
    }
  }
  return null;
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
  if (!shop) throw new Error('Unknown shop: ' + shopId);

  var divisor = Number(costDivisor || 0);
  // A divisor of zero or less is a division by zero or a negative price. Caught
  // here rather than producing Infinity in a column someone pays against.
  if (divisor && divisor <= 0) {
    throw new Error('The cost divisor must be greater than zero.');
  }

  var summary = orderSummary_(shopId, fromDate, fromTime, toDate, toTime);
  var wanted = {};
  (listingIds || []).forEach(function (id) { wanted[String(id)] = 1; });

  var chosen = summary.listings.filter(function (l) {
    return !listingIds || !listingIds.length || wanted[l.listing_id];
  });
  if (!chosen.length) throw new Error('No orders in that window for those listings.');

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
      // survive the conversion, and a Drive link is not a photo.
      var photos = photoIndex_(l.listing_id);
      detail.variations.forEach(function (v, i) {
        var rowIndex = h0 + 1 + i;
        s2.setRowHeight(rowIndex, PHOTO_ROW_PX);
        var blob = variantPhoto_(v, photos);
        if (!blob) {
          s2.getRange(rowIndex, 1).setValue('no photo').setFontColor('#888888');
          return;
        }
        s2.insertImage(blob, 1, rowIndex, 6, 5).setWidth(PHOTO_PX).setHeight(PHOTO_PX);
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
      filename + ' (' + chosen.length + ' listings)', 'ok');

    return {
      url: file.getUrl(),
      name: filename,
      folder: folderPath_(folder),
      folder_url: folder.getUrl(),
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
