/**
 * Coded errors, so a failure can be diagnosed from its code alone.
 *
 * Every failure this backend raises on purpose carries a code of the form
 * TS-<AREA>-<NN>: TS-EXP-07 is one specific line in Export.gs, and only that
 * line. The code travels three ways at once — in the JSON error the app shows,
 * in the Log tab's detail column, and in the Apps Script execution log — so a
 * screenshot of the app, a row in the Sheet, or a line in the console all point
 * at the same place without any guessing.
 *
 * The registry of codes is generated from the sources, not written by hand:
 *
 *     python3 apps-script/build-error-codes.py    ->  apps-script/ERROR-CODES.md
 *
 * and the test suite fails if a code is used twice or is missing from the
 * registry, so the document cannot drift from the code.
 *
 * Areas: API (routing, roles), AUTH (sign-in), CFG (configuration), EXP
 * (exports), LCK (locking), ORD (orders), PRD (products and variations), SHT
 * (spreadsheet), TT (TikTok API transport and tokens). UNC is reserved for the
 * one case that has no code: an error the runtime raised that this code did not
 * anticipate — which is itself the finding.
 */

/**
 * Build an Error that carries a code and, optionally, extra fields for the
 * client (kept off the message so the message stays readable).
 */
function fail_(code, message, extra) {
  var err = new Error(String(message || code));
  err.code = code;
  if (extra) {
    Object.keys(extra).forEach(function (k) { err[k] = extra[k]; });
  }
  return err;
}

/** The code on an error, or the marker for one that was never given a code. */
function codeOf_(err) {
  return (err && err.code) ? String(err.code) : 'TS-UNC-00';
}

/**
 * A non-fatal problem, recorded rather than thrown.
 *
 * For the places where the right behaviour is to carry on — a photo that would
 * not fit in the export, a thumbnail Drive has not generated yet — and where
 * silently carrying on would leave nobody able to explain the gap afterwards.
 * Goes to the Log tab with result "warn", so the log can be filtered for them.
 */
function warn_(code, detail, shop) {
  try {
    console.warn('[' + code + '] ' + detail);
    logEvent_('system', 'warn', shop || '', '[' + code + '] ' + String(detail || '').slice(0, 450), 'warn');
  } catch (e) {
    // Logging must never be the thing that fails.
  }
}

/**
 * TikTok's reason, with its own numeric code kept — "Chinese characters are
 * not supported in product name (TikTok 12052262)" — because the number is
 * what TikTok's documentation is indexed by, and the message alone is often
 * one sentence that fits several causes.
 */
function ttReason_(r) {
  if (!r) return 'no response';
  var msg = String(r.message || '').trim();
  var code = r.code === undefined || r.code === null ? '' : String(r.code);
  if (msg && code) return msg + ' (TikTok ' + code + ')';
  return msg || (code ? 'TikTok code ' + code : 'unknown TikTok error');
}
