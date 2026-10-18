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
| Execution time | **6 minutes** per invocation (consumer and Workspace) | [Quotas](https://developers.google.com/apps-script/guides/services/quotas) | The manual order sync pages at 50 (`ORDER_PAGE_SIZE`) with `MAX_PAGES = 60`, so a range over 3,000 orders needs narrowing (TS-ORD-02). The background sync writes each page as it reads it, stops starting pages at 4 minutes (`SYNC_BUDGET_MS`, TS-ORD-34) and resumes the saved page next run; its run guard lives 360 s. Export builds one workbook per call. |
| URL Fetch calls | 20,000 / day; response ≤ 50 MB; 100 concurrent | Quotas | Photos fetched once and cached in Drive `_tiktok`; TikTok reads are paged. The listing screen reads `listingState` (two product fetches each) by itself while it is on screen: at most every 20 s, one at a time, never hedged (`POLL_READ`) — about 1,100 fetches per phone over a three-hour stream. |
| Simultaneous executions | **30 per user**, 1,000 per script (consumer and Workspace). The web app runs as the deploying user (`executeAs: USER_DEPLOYING`), so every phone shares the one 30 | [Quotas](https://developers.google.com/apps-script/guides/services/quotas), "Current limitations" | Timed reads on the phone (`useAutoRefresh`) are a setTimeout started after the last read settles, never an interval, so one phone has at most one timed read out however slow the backend is. The Orders tab reads once a minute, only while its window includes now. |
| Script lock | `tryLock` waits; a held lock blocks every write | LockService | `withScriptLock_` re-entrancy guard (`HELD_`); reads are not in `WRITE_ACTIONS`; sync and export do their own short locks only around Sheet writes. |
| Web app POST | The `/exec` URL answers a POST with a **302** to `script.googleusercontent.com`, which accepts **GET only** | Observed 5–6 Sep | Client falls back to GET for read actions with payloads under 6,000 characters; the backend always returns HTTP 200 with `_status` in the body. |
| Properties | 9 KB per value, 500 KB total | Quotas | Tokens per shop are small. The order sync's per-shop memos (`SYNC_SEEN_`, `RETURNS_SEEN_`) and saved page (`SYNC_CURSOR_`) are measured against `SYNC_STATE_MAX_CHARS` (8,000) before every write: a memo is cut oldest-first (TS-ORD-36, TS-ORD-38), a page that does not fit is not saved (TS-ORD-37). At most about 50 KB across three shops. |
| CacheService | Value kept **at most 6 hours** (21,600 s); 250-character key; 100 KB per value; entries **may be evicted before they expire** | [Cache reference](https://developers.google.com/apps-script/reference/cache/cache) | The SKU slices (`SKU_CACHE_TTL_S`, chunked under 100 KB) and the stock request keys (`STOCK_REQUEST_TTL_S`, key cut to 200 characters). Both treat a miss as "read it again" or "judge it afresh", never as an answer. |
| No image processing | There is no resize, crop or decode API | — | `imageDims_` reads headers; Drive does the resizing via `thumbnailLink`. |
| OAuth scopes | Auto-detected from the code on deploy; a new service means a re-authorisation prompt on next run | Apps Script manifest | Expect a consent prompt after pasting a version that adds Drive API URL fetches. |

## CacheService

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Expiry | **21,600 s (6 hours)** maximum, and only a maximum: the reference calls it "the maximum time the value remains in the cache" | [Cache.put](https://developers.google.com/apps-script/reference/cache/cache#putkey,-value,-expirationinseconds) | Every cache here is a speed-up, never the only copy: a miss reads the Sheet. The SKU slices and the per-listing sold counts are keyed on a version their writers bump (`SKUS_VERSION`, `ORDERS_VERSION`), so they can live the full six hours without serving a stale answer. Anything that must outlast a gap between runs is in Script Properties instead. |
| Value size | **100 KB** per key | Cache.put | SKU slices are chunked at 90,000 characters. The sold-count index holds counts only, not rows, so a 200-SKU listing stays far inside it (estimated, not measured); a put that fails is TS-ORD-21 and the read is simply paid for. |

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
| Get Order List (`/order/202309/orders/search`) | `update_time_ge`/`update_time_lt` filtering is **not confirmed** from documentation; an ignored filter would not error | Not read from here — see `ttSearchOrders_` | Checked on every page of the background sync: an order more than `SYNC_FILTER_TOLERANCE_S` (1 h) behind the query's lower bound means ignored, and the run falls back to a creation-time window (TS-ORD-25). Anything less is index lag, which `SYNC_OVERLAP_S` (120 s) re-asks about. |
| Get Order List: `page_size`, `sort_field`, `sort_order` | The code sends `page_size=50` and no sort. Whether 100 is accepted, and whether `sort_field=update_time` with `sort_order=ASC` is honoured, is **not confirmed** | Not read from here | Nothing relies on result order. The watermark moves only when a scan reaches its last page; an unfinished scan saves its page token with the exact bounds it was issued for. |
| Page token lifetime | **Unknown.** The background sync reuses a token in the next execution, a minute or more later | Not documented anywhere found | A refused token restarts the scan from the unmoved watermark (TS-ORD-35): slower, never a gap. If tokens turn out to die between executions, a backlog bigger than one 4-minute run never finishes and TS-ORD-35 repeats every run — that is the signal to confirm `sort_field=update_time` and move the watermark per page instead. |
| Stock quantity | **1 to 99,999** per SKU per warehouse. **Documented**: `quantity` "Valid range: [1, 99,999]" on Update Inventory (doc 6503068fc20ad60284b38858), and the same on Partial Edit Product (68f597ee1e45470499ff10f0) and Edit Product (68f597ed028a11048cff9ad7); 12052055 "must be within allowed limits". **Observed**: a read returns 0 for a sold-out SKU, so 0 is a value TikTok holds but not one a write may send. A write of 0 has never been tried here. Before this row the repo cited no page for the floor (`checkStockTotal_` called it documented without naming one); it is kept at 1 either way | Update Inventory reference | `checkStockTotal_` (TS-STK-04) and `STOCK_MIN`/`STOCK_MAX` in `tiktok-rules.ts`; a reduction that would pass the floor is refused by name (TS-STK-14), and the phone greys out a minus step that would. |
| Stock under a promotion | 12052393 "Product locked for Promotion and stock can't be updated below current stock" | Update Inventory (doc 6503068fc20ad60284b38858) | Not checked before sending, since only TikTok knows the promotion: a minus step on such a product comes back as TS-STK-05 with TikTok's number. |
| Price (SG, local seller) | **0.01 to 10,000 SGD**, **2 decimal places** | Product pricing (doc 67e1288d76cfee049d9af858) | `PRICE_MIN`/`PRICE_MAX` in Config.gs and `tiktok-rules.ts`; `validatePrice_` / `validatePrice` (one shared test table) before a push (TS-PRD-21) or a price change (TS-PRC-02). |
| Update Price | `POST /product/202309/products/{id}/prices/update`: the product must be **ACTIVATE** and **not in an ongoing promotion**; response `data` is always empty. 12052038 / 12019045 price locked by a promotion; 12052570 over the limit; 12052073 invalid; 12052557 SKU not in the product; 12019113 / 12052901 status not allowed | Update Price (doc 650307de5a12ff0294eac8b0) | `setVariationPrice_`: refuses before sending unless the live version is ACTIVATE and has the SKU (TS-PRC-05, -06); promotion lock is TS-PRC-08, any other refusal TS-PRC-09, TikTok's number kept; success is confirmed by re-reading the live version (TS-PRC-11), never by the empty reply. |
| Price and stock edits skip review | "edits to the `price` or `inventory` fields do not require a reaudit and will be immediately published on the platform" | Partial Edit Product (68f597ee1e45470499ff10f0), Edit Product (68f597ed028a11048cff9ad7) | The live version has a new price at once; the copy under review may lag it (`pending_price`, TS-PRC-12). Every rebuild — push, remove, restore — takes a live SKU's price from the live version (`pricedFromLive_`), or the next push would put the old price back. |
| Rate limits | Dynamic per app × shop; ~1 write/s is the safe assumption; HTTP 429 or code 36009002 | Docs | Pushes serialised by the script lock. |
| Daily listing cap | 100 uploads/day on probation, 1,000 after | Products overview | Allowance shown in the app. |
| Product page URL | `https://shop.tiktok.com/view/product/<id>?region=SG` | Shareable link format | `listingUrl_`. |

## Browser fetch

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Default request deadline | **None.** A stalled `fetch` waits for ever | WHATWG Fetch | Every backend call carries an `AbortController` deadline: reads 25 s, `listingState` 40 s, push 120 s, sync 180 s, export 240 s (`src/lib/script-api.ts`). A timeout is status 0 + code `TIMEOUT`: outcome unknown, retryable. "Checking…" sat for two minutes on 7 Sep before this. |

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
| ID token lifetime | **1 hour** | OIDC | The backend verifies it once at `whoami` and issues its own 14 h session (`issueSession_`, HMAC-signed, secret in Script Properties). Silent renewal did not fire reliably on two phones on 7 Sep; the session is what stops an hourly sign-in mid-stream. |

## Anthropic API

| Limit | Value | Source | Where handled |
| --- | --- | --- | --- |
| Org-level key | Requires `anthropic-workspace-id` header | Observed 6 Sep (HTTP 400) | `ANTHROPIC_WORKSPACE_ID` env var. |
| Thinking tokens | Count against `max_tokens` on `claude-opus-5` | API docs | `max_tokens: 4096`. |
