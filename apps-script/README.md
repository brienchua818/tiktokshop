# TikShop — Apps Script backend

Runs as **you**, which is what gives it native access to the shared drive and
the Sheet with no service account. A service account would have to be added as
a member of the shared drive separately.

Data lives in Drive, per Brien's instruction:

```
TikTok Livestream Buddy/                     1DMzpmTKGkBmAW2j_yaFJffKXIHZJU_ix
  TikShop Data              (Sheet)          Listings · SKUs · Log · Users
  Exports/2026/2026-09/2026-09-04/           HOUZE - Katrin BJ - Brien Chua - ....xlsx
  Product Photos/2026-09-04/HZ/              A1 - Brien Chua - 1432.jpg
```

Year and month levels exist so the folder list stays navigable — a flat folder
of dated exports is unusable after a few months of daily streams.

## Setup

1. Create a **new, separate** Apps Script project. Not the delivery one — see
   the warning below.
2. Paste in `TikShopBackend.gs` — the single generated file
   (`python3 apps-script/build-single-file.py`) that concatenates all ten
   sources: `Config.gs`, `Errors.gs`, `Lock.gs`, `Sheet.gs`, `Auth.gs`,
   `TikTok.gs`, `Product.gs`, `Orders.gs`, `Export.gs`, `Api.gs` — plus the
   `appsscript.json` manifest. Check the line count against the one in the
   commit message: a truncated paste fails on an undefined function.
   Error codes are listed in `ERROR-CODES.md`; platform limits in `LIMITS.md`.
3. Run `setupSheets()` once. It creates the four tabs and seeds you as admin.
4. Add Script Properties, per shop, `{P}` being `HZ`, `TM` or `PM`:
   - `{P}_APP_KEY`, `{P}_APP_SECRET`, `{P}_SERVICE_ID`
   - `GOOGLE_CLIENT_ID` — the OAuth client the frontend signs in with
   - optionally `{P}_DAILY_CAP` (defaults to 1000)
5. Deploy as a web app: execute as **me**, access **anyone**.
6. Register three new custom apps in Partner Center (one per shop) and set
   this deployment's `/exec` URL as their Redirect URL.
7. Open `ttAuthorizeUrl('HZ')` once per shop, while signed into that shop.
8. Run `ttSelfTest()` to confirm all three answer.

> **This must be its own Apps Script project. Do not add it to
> `Sheldon Delivery API`.**
>
> That project already defines `doGet`, `doPost`, `handle_`, `json_` and
> `WRITE_ACTIONS`. So does this one. Apps Script shares a single global scope
> across files, so combining them collides on all five — and `WRITE_ACTIONS` is
> a `const` there, which is a hard redeclaration error. Delivered-status and
> POD sync for Painting Matters would break.
>
> A TikTok app registration carries exactly one Redirect URL, and the existing
> registrations point at the delivery project's `/exec`. So this project needs
> **its own app registrations** — three new custom apps in Partner Center, one
> per shop. Custom apps need no review below 25 authorisations, so the only
> cost is registering them and authorising each shop once.
>
> The alternative — repointing the existing registrations at this project —
> would break the delivery integration. Don't.

## Who can use it

Anyone with a Google account can sign in. Signing in is **not** permission to
act.

A first-time signer is written to the `Users` tab as `pending` and can do
nothing. To let them work, change their `role` to `lister` (or `admin`). The
allowlist lives in the Sheet so you can edit it yourself, without a deploy.

| Role | Can do |
| --- | --- |
| `admin` | List, export, and approve others |
| `lister` | List and export |
| `pending` | Nothing — awaiting approval |
| `blocked` | Nothing |

This matters because the app pushes products to live TikTok shops. Without the
allowlist, anyone on the internet with a Gmail address who found the URL could
list products against your shops.

Identity is proved by a Google ID token the frontend forwards, verified against
Google's `tokeninfo` endpoint and checked against `GOOGLE_CLIENT_ID`. It is
never taken from a claim the caller simply asserts — decoding a JWT without
verifying its signature would make the allowlist decorative.

Every action is written to the `Log` tab with who did it, and exports and
photos carry the creator's name in the filename.

## API

`GET`/`POST` to the `/exec` URL with `?action=`:

| Action | Purpose |
| --- | --- |
| `ping` | Health check; no auth |
| `whoami` | Identity and role |
| `shops` | The three shops and whether each is connected |
| `listings` | Factory streams for a shop |
| `addListing` | Add a stream by TikTok listing ID |
| `skus` | SKUs for a stream |
| `allowance` | Uploads used and remaining today |
| `pushSku` | Validate, file the photo, add the variation, record |
| `exportListing` | Write an xlsx into today's dated folder |
| `users` / `setRole` | Admins only |

### How `pushSku` behaves

A livestream is **one TikTok product**, and each SKU called out on air is a
**variation** of it. So `pushSku` does one of two things:

- **`listing_id` given** → adds a variation to that product. Returns
  `mode: "variation_added"` with `variations_now` and `remaining`.
- **`listing_id` omitted** → creates the stream's listing with this SKU as its
  first variation. Returns `mode: "listing_created"`, and its `listing_id` is
  what every later SKU in the stream must be sent with.

Two responses are **not failures** and the client must treat them differently
from an error:

| HTTP | `code` | What it means | What to do |
| --- | --- | --- | --- |
| 409 | `LISTING_FULL` | The listing holds 100 variations, TikTok's Singapore limit | Offer to start a continuation listing; do not retry as-is |
| 409 | `LISTING_BUSY` | Another write holds the script lock | Retry in a second or two; nothing was lost |
| 422 | — | TikTok refused the SKU, with its own wording | Show the message; **do not** retry — each attempt costs daily allowance |

`audit: "pending"` on a success means TikTok has resent the product for review.
Existing variations stay live and buyable throughout; the new one is not
purchasable until it clears.

## Tests

```
node apps-script/test/run.cjs
```

Apps Script has no test runner and its editor cannot be driven from a
terminal, so the pure logic is loaded into plain node instead. That covers the
parts where a mistake is expensive and silent — the payload that edits a live
listing, the title rules, and the lock — and mirrors
`netlify/lib/tiktok-variants.test.ts` case for case, because the same
livestream can be served by either backend and the two must not drift.

It does **not** cover anything touching `SpreadsheetApp`, `DriveApp`,
`UrlFetchApp` or `LockService` for real; those are stubbed. Use `ttSelfTest()`
in the editor for the integration side.

## Two things that will bite if changed

**Never nest the script lock.** `Api.gs` takes it once per write action and
everything below assumes it is held. `Lock.gs` tracks per-execution ownership
so a nested `withScriptLock_` is a no-op rather than a second acquisition —
because whether Apps Script's script lock is re-entrant within one execution
is undocumented, and the two possible failures are a thirty-second hang on
every push or a silently skipped write. Always go through `withScriptLock_`.

**Never send a partial SKU list to `partial_edit`.** From TikTok's own
reference: *"You must pass in all existing SKUs. Any existing SKU IDs not
listed here will result in the deletion of those SKUs."* There is no append
call. `buildAppendPayload_` reads the product first and refuses to emit a
payload that would drop one — leave that check in place.
