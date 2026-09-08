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

## Every network call has a deadline, and every phone shows the server's list

- **No fetch without a timeout.** `call()` takes `timeoutMs`; a stalled
  request is a `TIMEOUT` (status 0, outcome unknown), never a frozen screen.
  The backend logs any action over 15 s (`TS-API-04`).
- **The queue is the union**, not this phone's drafts: `mergeRows(drafts,
  live)` adds every variant the backend or TikTok has that this phone did not
  make. Two phones on one stream must see one list.
- **Sessions outlive Google's hour.** `whoami` returns a backend session;
  the client sends it first. Do not reintroduce a per-call Google check.

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

## The UI has three rules, and each is enforced by a check

Not style. Each of these shipped as a real bug, so each is now a test that
fails rather than a habit that slips.

- **A colour is a token, never a palette class.** `text-fg`, `bg-raised`,
  `border-line` swap with the palette; `text-cyan-400` does not, so it renders
  identically in both themes and is invisible in the one it was not written
  for. Enforced by `tools/palette.test.ts`, which scans `src/` and names the
  file and the class. Only `text-white` and `bg-black` are allowed raw — ink on
  a filled button, and the camera viewfinder — and they are allowed by name.
  The same test asserts every `--color-*` token is defined in **both**
  palettes, so adding one to dark and forgetting day fails too.
- **A fixed bottom bar reserves its own height.** The shell pads `main` by the
  tab bar. A screen that adds a second bar above it takes ~56px more that
  nothing accounts for, so at full scroll the last row can never be read. Any
  screen with its own bar ends with `<BarSpacer />`. Enforced by the audit,
  which scrolls each screen to the bottom and reports readable text left under
  a bar.
- **Every overlay closes on Escape and locks the page behind it.**
  `useDismiss` does both. Without it a sheet's scrim swallows every control on
  the page with no way out, which the audit reports as a control that cannot be
  clicked.
- **No text is painted outside its own box.** A row that runs out of width does
  not get to spill: flex will shrink a `whitespace-nowrap` button below its
  content width, leaving the rectangles tidy while the words draw over each
  other. Two tabs, a timestamp and a refresh button in one 375px strip did
  exactly that. Give anything that can run out of room `min-w-0` and a
  `truncate`, then shorten the label until it fits — truncation is the honest
  failure, not the fix. The audit compares `scrollWidth` to `clientWidth` on
  every control and text node and fails when nothing is clipping the excess.
  It also fails on two controls in the same layer whose rectangles overlap;
  layers differ deliberately, so a fixed bar over scrolled content is not a
  finding.

- **One row, one component.** The variation row existed as two near-identical
  markups, one for a local draft and one for everything else. Six changes in a
  day each landed in whichever copy it touched, and the result was a list where
  rows were three lines or four depending on whether anybody was recorded
  against them, a photo that matched neither height, and everything at 12px in
  four greys. Brien's words: "the uxui now sucks... suddenly don't look aligned
  and neat anymore." He was right, and no single change was at fault —
  duplication was. Anything rendered twice will drift, and nobody notices until
  it is ugly enough to complain about.
- **Three rules for a list row**, since that is what the fix came down to:
  every row the same height whatever data is missing; the image sets the height
  and everything centres against it; two text sizes, not one, so the size
  carries the hierarchy and the colours do not have to.
- **Screenshots catch what checks cannot.** The audit passed the accreted row on
  every device: nothing was dead, undersized, overlapping or spilling. Two
  affordances for the tappable stock figure also passed and both looked wrong —
  a plus icon that wrapped onto its own line, then a dotted underline that read
  as a spell-check squiggle. Look at the picture before saying it is done.
- **A control that does nothing is a bug, even when it renders perfectly.**
  Brien could not change anyone's role, and every check passed: the buttons
  rendered, were named, were 44px, and survived a click. So the audit now
  records every backend call and a signature of the page, and fails a click
  that produces no request, no navigation and no visible change. A control
  already in its selected state is exempt, read from its own `aria-pressed`
  rather than from a list of names, so every segmented control is covered and
  none is excused by accident. It found a second bug immediately: Sign out
  awaited Google's script before clearing local state, so on a blocked or dead
  connection it did nothing at all.
- **A disabled control is a deliberate state, not a fault.** The audit skips
  clicking one. It used to time out on the segment showing someone's current
  role and report the screen as broken while it worked.
- **Compare a role in one place.** The Users tab is a spreadsheet people edit
  by hand, so "Lister" and " admin " turn up. Checks that lowercased kept
  working, checks that did not locked people out silently, which is the worst
  split available: access looks granted in the Sheet and is refused by the
  app. `normaliseRole_` is the only comparison, and the frontend normalises
  too so neither side can drift.

Run it with `npm run audit:ui` (add `:shots` for screenshots in
`dist/ui-audit`). The build **must** carry `VITE_APPS_SCRIPT_URL` and
`VITE_GOOGLE_CLIENT_ID` or the app renders a config error and the audit sees
nothing — `npm run build:audit` sets them, so never build it by hand. A screen
reporting zero controls is a failure, not a pass.

When adding a check, prove it fires: break the thing on purpose, watch it fail,
then fix it back. A check that has never gone red is not known to work.

And prove it does not fire on the legitimate case either. The trapped-content
check read a row scrolled out of view inside the queue's own `max-h` list as
"hidden behind the bottom bar", because a clipped element still reports its
real position. It only surfaced when a sixth variation was added to the
fixtures, and it would have sent somebody hunting a layout bug that was not
there. A false alarm costs more than a missing check, because it teaches people
to ignore the output. When a check reports something, it must also report
enough geometry to diagnose it without a second run.

## Shipping

- Frontend: `npm test`, `npm run build` (`tsc -b` is stricter than
  `--noEmit`) and `npm run audit:ui` before every push. `main` auto-deploys on Netlify; verify the
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

**A caveat does not expire.** The way this rule actually gets broken is not by
inventing something — it is by restating a conclusion from an earlier note and
dropping the "unverified" that was attached to it. The claim then reads as
settled because it has been repeated, not because anything was checked. So
before repeating a conclusion, go back to where it was written down and carry
its caveat with it, or re-verify it. Summarising is where confidence gets
manufactured.
