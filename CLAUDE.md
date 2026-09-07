# TikShop — working rules for anyone (human or Claude) changing this app

This app is used standing in a factory during a livestream, and its export is
what a factory gets paid against. A failure costs a stream or a payment. The
rules below exist because each one was learned by breaking something. They are
not style preferences.

## Before building on a platform feature: read its limits first

- **Look up the documented limits of every external call before writing it**,
  and record them in `apps-script/LIMITS.md` with the source. Sheets
  `insertImage` has a pixel cap as well as a byte cap; `setValues` needs
  rectangular data; Apps Script has no image API; Netlify stops building when
  credits run out and says nothing. All four broke this app in one day because
  the limit was assumed rather than read.
- **Measure before you send.** If a limit is numeric, the code checks the
  value against it before the call and degrades on purpose, with a code.
  Never rely on the platform's own error as the check.
- **Do not trust one read.** Dashboards, CDN caches, service workers, phones,
  and product reads all answered wrongly at least once. Cross-check against a
  second source before acting on anything destructive or paid.

## Every failure path has three things: a failsafe, a log line, a code

- **A code.** Every `throw` in `apps-script/` is `throw fail_('TS-AREA-NN', ...)`.
  The registry is generated: `python3 apps-script/build-error-codes.py` writes
  `apps-script/ERROR-CODES.md`; the tests fail on a duplicate code or a stale
  registry. A bare `throw new Error` is a defect. The code shows on screen in
  square brackets, in the Log tab, and in the execution log.
- **A log line.** Fatal failures are logged by the API handler with the code.
  Non-fatal ones — a photo that would not fit, a thumbnail not yet generated —
  go through `warn_(code, detail)` so they appear in the Log tab with result
  `warn`. Silence is not an outcome.
- **A failsafe means the same result by another route, not a lesser result.**
  A photo that does not fit is resized by another resizer (phone copy, Drive,
  Slides); it is not replaced with a link. Only when every route is exhausted
  does the output say so, with the code. Offering the user a substitute for
  the thing they asked for is not a failsafe.
- **A failsafe.** Decide, per failure, what the user gets instead: the export
  without a picture but with a link; the SKU list without live state but with
  a refresh button; the push reported as "outcome unknown", never "failed",
  when the answer was lost. A decorative element must never fail a payment
  document. Wrap the decorative part, not the whole function.
- **TikTok's own code stays in the message**: `ttReason_(r)` renders
  "message (TikTok 12052262)". Their documentation is indexed by that number.

## Who knows whether a write happened

- **The backend does; the phone does not.** A push is send → write → reply,
  and the reply can fail alone (B9, 7 Sep: recorded 12:14:17, shown on the
  phone as "Failed · No connection"). A network error on a write is
  "outcome unknown", never "failed". The client then asks the backend what it
  recorded (`listingState`, non-external variants) and, on every later fetch
  of live state, corrects local drafts against that answer
  (`src/live-listing/reconcile.ts`).
- **"Recorded by the backend" is the question, not "shown by TikTok".** A
  variation just added is under review and absent from TikTok's product read
  for minutes. Checking TikTok's read to decide whether a push worked gives
  the wrong answer for exactly that window.
- A draft still inside its automatic attempts reads **Retrying**, not Failed.

## Data in the Sheet

- Reads and writes map columns **by position in `HEADERS`**. Adding, removing
  or reordering a column is a **migration**: `ensureHeaders_` re-lays rows out
  by name when the header row and `HEADERS` disagree. Add the column to
  `HEADERS`, nothing else; never edit the Sheet's header row by hand.
- `partial_edit` on TikTok deletes any SKU absent from the payload. Every edit
  is read-modify-write with guards that refuse to drop an id. Do not bypass
  `buildAppendPayload_` / `buildRemovePayload_`.

## Diagnosing a report from Brien

1. **Read the primary sources before the screenshot.** The Log tab in the data
   Sheet (id `1GRYYUP7NdgCwTIgt3UHiPh4K-cerNvo-PHQZfGUs2Jg`, readable through
   the Drive connector) usually has the exact error and code. The live bundle
   at `https://sheldon-tikshop.netlify.app` can be fetched and grepped for a
   string the intended commit added — that is how "the fix did not work" was
   found to be "the fix was never deployed".
2. **Inference is not a finding.** If the evidence fits two explanations, say
   both. Do not report the dramatic one as fact.
3. **Find the class, not the instance.** One ragged `setValues` row means
   checking every `setValues`. One shifted column means every tab.

## Shipping

- Frontend: `npm test` and `npm run build` (`tsc -b` is stricter than
  `--noEmit`) before every push. `main` auto-deploys on Netlify; verify the
  deploy went `ready` and the bundle contains the change. If deploys are
  `skipped`, it is credits.
- Backend: `python3 apps-script/build-error-codes.py`,
  `python3 apps-script/build-single-file.py`, `node apps-script/test/run.cjs`.
  Brien pastes `apps-script/TikShopBackend.gs` by hand. Give him the
  **commit-pinned** raw URL
  (`https://raw.githubusercontent.com/brienchua818/tiktokshop/<sha>/apps-script/TikShopBackend.gs`;
  never `/main/`, it caches stale) **and the line count** so he can confirm the
  paste is whole. Existing behaviour that needs the new backend is not fixed
  until he has pasted it — say so.
- Any message that tells him to go somewhere includes the URL.

## How Brien wants to be told things

Point form, emojis fine, the answer first. State what was verified and how;
state what was not. He should not be the regression suite: if he reports one
instance, he expects the class fixed.
