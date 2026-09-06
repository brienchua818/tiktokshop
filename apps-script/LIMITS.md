# Platform limits this app runs into

Read this before adding anything that touches one of these services. Every
entry here is either a limit that has already broken something in this app, or
one that sits directly in the path of what the app does. Each names the limit,
the source, and what the code does about it. When a new limit is discovered
the hard way, it goes here the same day, with the code that hit it.

## Google Sheets (Apps Script SpreadsheetApp)

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Inserted image size | **2 MB** and **1,000,000 pixels**, both enforced | [Sheet.insertImage](https://developers.google.com/apps-script/reference/spreadsheet/sheet#insertimageblob,-column,-row); error text "The blob was too large. The maximum blob size is 2 MB. The maximum number of pixels is 1 million." | `sheetsImageFit_` measures bytes and pixels before every insert; `driveResized_` asks Drive for a 400 px copy; `placePhoto_` falls back to a link (TS-EXP-10..18). Hit on 7 Sep with a 1600×1600 photo. |
| `setValues` shape | Every row must have the same number of cells as the range | Runtime error "The number of columns in the data does not match…" | No bare `[]` rows anywhere in Export.gs — spacers are `['']`. Hit on 6 Sep (TS-UNC-00 at the time). |
| Cells per spreadsheet | 10,000,000 | Google Sheets limits | Orders and order items grow without bound; a yearly archive tab split will be needed before this matters — see Build State. |
| Reads and writes | Each `getRange().getValues()` is a round trip, ~0.1–0.5 s | Apps Script best practices | `readAll_` reads a tab once; `replaceByKey_` writes once; `ensureHeaders_` checks the header row once per execution. |
| IMAGE() formulas | Not preserved in xlsx export | Observed | Over-grid images only. |

## Apps Script runtime

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Execution time | **6 minutes** per invocation (consumer and Workspace) | [Quotas](https://developers.google.com/apps-script/guides/services/quotas) | Order sync pages at 100 with `MAX_PAGES = 60`; export builds one workbook per call. A range over ~6,000 orders needs narrowing (TS-ORD-02). |
| URL Fetch calls | 20,000 / day; response ≤ 50 MB; 100 concurrent | Quotas | Photos fetched once and cached in Drive `_tiktok`; TikTok reads are paged. |
| Script lock | `tryLock` waits; a held lock blocks every write | LockService | `withScriptLock_` re-entrancy guard (`HELD_`); reads are not in `WRITE_ACTIONS`; sync and export do their own short locks only around Sheet writes. |
| Web app POST | The `/exec` URL answers a POST with a **302** to `script.googleusercontent.com`, which accepts **GET only** | Observed 5–6 Sep | Client falls back to GET for read actions with payloads under 6,000 characters; the backend always returns HTTP 200 with `_status` in the body. |
| Properties | 9 KB per value, 500 KB total | Quotas | Tokens per shop are small; nothing else is stored there. |
| No image processing | There is no resize, crop or decode API | — | `imageDims_` reads headers; Drive does the resizing via `thumbnailLink`. |
| OAuth scopes | Auto-detected from the code on deploy; a new service means a re-authorisation prompt on next run | Apps Script manifest | Expect a consent prompt after pasting a version that adds Drive API URL fetches. |

## Google Drive

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Thumbnails | `thumbnailLink` is generated asynchronously after upload; may be absent for seconds | Drive API v3 | `driveResizedWithRetry_` polls 5 × 1.5 s; if still absent, `slidesRender_` produces the small copy instead. The phone-made 400 px copy (`photo_thumb_url`) avoids both for SKUs pushed after 7 Sep. |
| Thumbnail sizing | `=sNNN` suffix on `thumbnailLink` resizes the longest side | Drive API v3 | `PHOTO_FETCH_PX = 400`. |
| File name characters | `/` is the only forbidden character, but Windows users of the export cannot open names with `\ : * ? " < > \|` | Excel/Windows | `fileSafe_` strips exactly that set. |

## Google Slides API

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Page thumbnail sizes | `SMALL` 200 px, `MEDIUM` 800 px, `LARGE` 1600 px wide (16:9 page) | [pages.getThumbnail](https://developers.google.com/slides/api/reference/rest/v1/presentations.pages/getThumbnail) | `slidesRender_` uses MEDIUM: 800×450 = 360,000 pixels, inside the Sheets cap. LARGE would not fit. |
| Rendering cost | ~1–2 s per page, and the presentation must be saved before the thumbnail reflects the insert | Observed pattern | Last resort only; one scratch presentation per export, trashed in `finally`. |

## TikTok Shop API

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Variations per product (SG) | **100** | Create Product docs | `MAX_SKUS_PER_PRODUCT`; LISTING_FULL → continuation listing. |
| Title length (SG) | **25–255** characters, English only | Create Product docs; errors 12052262, 12052266 | `tiktok-rules.ts` and `titleProblem_`. |
| `partial_edit` | **Deletes any SKU absent from the payload** | Confirmed 5 Sep | Read-modify-write with every existing id kept; guards refuse an edit that would drop one (TS-PRD-13, -19). |
| Get Product under review | A variation still under review is **omitted** from the product read | Observed with B5, 6 Sep | `tiktok_sku_id` stored at push; `pendingToCarry_` carries them through edits; `confirmed_at` distinguishes removed from pending. |
| Image upload | Must **not** carry `shop_cipher` | Error text, 6 Sep | `PATHS_WITHOUT_CIPHER`. |
| Order line items | No `quantity` field — one line item is one unit | `inspectOrders`, 6 Sep | `quantity: 1` per line item. |
| `seller_sku` on orders | **Inconsistent**: blank on some line items of a variation and present on others (F20, 4 Sep); blank on every line of F21 | Observed in the Order Items tab | `resolveSellerSkus_` fills it from a sibling line, our SKU rows, TikTok's product read, then the `<1–3 letters><number>` pattern at the front of the variation name (`identifierFromVariation_`). Grouping keys on `sku_id`. |
| Rate limits | Dynamic per app × shop; ~1 write/s is the safe assumption; HTTP 429 or code 36009002 | Docs | Pushes serialised by the script lock. |
| Daily listing cap | 100 uploads/day on probation, 1,000 after | Products overview | Allowance shown in the app. |
| Product page URL | `https://shop.tiktok.com/view/product/<id>?region=SG` | Shareable link format | `listingUrl_`. |

## Netlify

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Build credits | Free plan credits; when exhausted deploys are **skipped silently**: state `error`, `skipped: true`, no error message, old build keeps serving | Observed 6 Sep (five deploys) | Before diagnosing from a screenshot, fetch the live bundle and grep for a string the intended commit added. Top up at https://app.netlify.com/teams . |
| Function payload | 6 MB | Netlify docs | Photos are JPEG at ≤1600 px; AI calls send a downscaled copy. |
| Env vars | Injected at build time; a change needs a redeploy | Netlify docs | — |
| Netlify Blobs | Eventually consistent (≤60 s) | Netlify docs | Not used for anything that must be read back immediately. |

## Google Identity

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Authorised JavaScript origins | Exact origin match, no paths; `gsi/button` returns 403 when wrong | GIS docs | Runbook step; sign-in errors carry distinct codes. |
| ID token lifetime | 1 hour | OIDC | Client refreshes silently; 401 codes are distinct from "not approved" 403. |

## Anthropic API

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Org-level key | Requires `anthropic-workspace-id` header | Observed 6 Sep (HTTP 400) | `ANTHROPIC_WORKSPACE_ID` env var. |
| Thinking tokens | Count against `max_tokens` on `claude-opus-5` | API docs | `max_tokens: 4096`. |
