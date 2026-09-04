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

1. Create a new Apps Script project, or add these files to an existing one.
2. Paste the files in: `Config.gs`, `Sheet.gs`, `Auth.gs`, `Api.gs`,
   `TikTok.gs`, `Product.gs`, `Export.gs`, and the `appsscript.json` manifest.
3. Run `setupSheets()` once. It creates the four tabs and seeds you as admin.
4. Add Script Properties, per shop, `{P}` being `HZ`, `TM` or `PM`:
   - `{P}_APP_KEY`, `{P}_APP_SECRET`, `{P}_SERVICE_ID`
   - `GOOGLE_CLIENT_ID` — the OAuth client the frontend signs in with
   - optionally `{P}_DAILY_CAP` (defaults to 1000)
5. Deploy as a web app: execute as **me**, access **anyone**.
6. Set the deployment `/exec` URL as the Redirect URL in Partner Center — or
   see the warning below.
7. Open `ttAuthorizeUrl('HZ')` once per shop, while signed into that shop.
8. Run `ttSelfTest()` to confirm all three answer.

> **If you reuse the app registrations that `Sheldon Delivery API` already
> uses, do NOT repoint their Redirect URL.** That project's `doGet` handles the
> TikTok callback at its own `/exec`, and changing it breaks delivered-status
> and POD sync for Painting Matters. Either register separate apps for
> listing, or add these files to that same project so one callback serves both.

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
| `pushSku` | Validate, file the photo, list on TikTok, record |
| `exportListing` | Write an xlsx into today's dated folder |
| `users` / `setRole` | Admins only |
