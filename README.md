# TikShop

TikTok Shop live-listing console for HOUZE, Table Matters and Painting Matters.
Replaces the app at `houze.voyagerai.in`.

Built for one job: creating SKUs on a phone, one-handed, standing in a factory
while a livestream runs, on bad Wi-Fi.

## Why this exists

The app it replaces had no real authentication. Its username and password were
hardcoded string constants in the JavaScript every visitor downloaded, and a
successful login only set `localStorage.tikshop_authed = "1"`. A fixed API
token shipped in the same bundle and granted the whole backend — so anyone who
found the URL could push products to the live shops and export cost prices.

Here, no secret and no TikTok token ever reaches the browser.

## What it does

- **Live Listing** — pick a factory stream, build SKUs against it.
- **Sequential identifiers** — `A1`, `A2`, `A3`, allocated not typed, continuing
  from both what is already live on TikTok and what is queued locally.
- **In-app camera** — square-cropped, JPEG-encoded, uploaded to TikTok for its
  image `uri` and archived to Cloudinary.
- **Photo to title** — Claude vision writes an English title of at least 25
  characters, which is TikTok's own hard minimum for Singapore.
- **Voice** — Gemini takes the recording and fills name, price and stock.
  Accepts English, Mandarin or both mixed, and returns English.
- **Bulk add** — one name, price and stock across a gallery, each photo becoming
  its own sequential SKU.
- **Offline queue** — SKUs are written to the device first and push themselves
  when the connection returns, exactly once.

## Architecture

```
Browser (installable PWA)  ->  /api/*  (Netlify Functions)  ->  TikTok Shop
                                    |                           Claude
                                    |                           Gemini
                                    +-- Postgres (Netlify DB)   Cloudinary
```

The browser talks only to our own functions. Those hold the app secrets, sign
TikTok requests and store shop tokens encrypted at rest.

> **Under review.** A hybrid — Apps Script backend reusing the working TikTok
> integration in `Sheldon Delivery API`, with this frontend on Netlify — is
> being considered. Apps Script cannot serve the frontend: its pages run in a
> sandboxed iframe with camera and microphone stripped, and service workers
> cannot register on an opaque origin, so camera, voice and offline all need a
> real origin. See the decision note in the Godown vault.

## Setup

### 1. Database

Provision Netlify DB on the project, then apply the schema and seed:

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql
```

`shop_id` values are `HZ`, `TM`, `PM` — the same prefixes `Sheldon Delivery API`
uses in Script Properties, so the two projects share one convention.

### 2. Environment variables

Set these on the Netlify project. Mark every secret as a secret.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | From Netlify DB |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32`. Rotating it invalidates stored tokens; shops must reauthorise |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client |
| `GOOGLE_REDIRECT_URI` | `https://sheldon-tikshop.netlify.app/api/auth-google-callback` |
| `ANTHROPIC_API_KEY` | Photo to title |
| `GEMINI_API_KEY` | Voice to fields |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Image archive |
| `HZ_SERVICE_ID`, `HZ_APP_KEY`, `HZ_APP_SECRET` | HOUZE's TikTok app |
| `TM_SERVICE_ID`, `TM_APP_KEY`, `TM_APP_SECRET` | Table Matters' |
| `PM_SERVICE_ID`, `PM_APP_KEY`, `PM_APP_SECRET` | Painting Matters' |

### 3. Google Cloud

Create an OAuth 2.0 Web application client and add as an authorised redirect
URI:

```
https://sheldon-tikshop.netlify.app/api/auth-google-callback
```

Sign-in is restricted to `sheldonglobal.com`. Access is granted and revoked by
adding or removing the Workspace user — there is no password anywhere.

### 4. TikTok Partner Center

Scopes to enable, using TikTok's own names:

- **Shop Authorized Information** — required; yields `shop_cipher`
- **Product Basic**, **Product Modify** — listing
- **Logistics Basic** — required; every SKU's inventory needs a `warehouse_id`
- **Order Information** — for the Orders module later

Leave off Product Delete & Recover, every **Global** scope, both Promotion
scopes, Return & Refund and Fulfillment unless something here starts using
them.

Redirect URL for the listing apps:

```
https://sheldon-tikshop.netlify.app/api/tiktok-callback
```

> **Do not change the Redirect URL on the app registrations that
> `Sheldon Delivery API` uses.** Its `doGet` handles the TikTok OAuth callback
> at its own `/exec`. Repointing it would break delivered-status and POD sync
> for Painting Matters. Register separate apps for listing, or let the Apps
> Script callback store tokens for both.

### 5. Seller Center, per shop

Both are prerequisites, not optional:

- **Return warehouse** must be set. There is no API for it, and without one
  every listing fails with `12052535`.
- A **sales warehouse** must exist and be enabled.

Also check each shop's **daily listing allowance**. New shops are capped at 100
product uploads a day during probation, rising to 1,000. A 200-SKU stream on a
fresh shop fails at item 101 with `12052093`. The app shows the remaining
allowance so this does not surface mid-broadcast.

## Development

```bash
npm install
npm run dev        # frontend on :5173
npm test           # 163 tests
npm run typecheck
npm run build
```

## TikTok constraints worth knowing

These are encoded in `src/lib/tiktok-rules.ts` with tests, so they fail fast
rather than at push time.

| Rule | Value |
| --- | --- |
| Title length | **25–255** characters for Singapore |
| Title language | **English only** — Chinese characters and emoji are rejected |
| `seller_sku` | 1–50 characters, no spaces |
| SKUs per product | 100 |
| Stock per SKU | 1–99,999 |
| Currency / weight / dimensions | `SGD` / `KILOGRAM` / `CENTIMETER` |
| Category version | `v2`, required for Singapore |

Two traps that cost real time:

- The required-attribute flag in TikTok's category response is **misspelled
  `is_requried`**. Reading `is_required` returns undefined, silently skips every
  mandatory attribute, and the listing then fails at create with an unhelpful
  error.
- Product **create** is still `202309` while **edit** moved to `202509`. There
  is no `202509` create path, and `products/activate` is not draft publishing —
  it only reactivates a deactivated product.
