# Source Genius

An Amazon-seller lead-generation pipeline: scrape ASINs/brand names off Amazon,
then find each brand's official website across multiple search engines and DNS
probing. Four components, wired together as described below.

## Components

### 1. `brand-finder-extension-v7.1.11/` — main Chrome extension (MV3)

The core product. A single service-worker file (`background.js`, ~7,800
lines) that:

- Scrapes ASINs + brand hints from Amazon search/product pages (tab-based DOM
  queries, with a direct-fetch fast path and an adaptive AIMD
  concurrency/rate controller in front of it).
- Finds each brand's official website via a multi-tier waterfall: DNS-over-HTTPS
  probing plus Google, Bing, DuckDuckGo, Yahoo, Ecosia, Brave, and Mojeek (see
  `pickSearchCandidate()` for the confidence-tier logic).
- Runs every candidate result through `validateResult()` before it's ever
  written as "found" — see **Result validation** below.
- Syncs results to a shared backend (hardcoded to `emailcampaign.ai` — see
  `BACKEND_URL` near the top of `background.js`) for team-wide deduplication.
- Self-heals: a circuit breaker ("Amazon wall") rests all Amazon tabs after
  repeated blocks, and a watchdog content script (`watchdog.js`) reloads the
  service worker if it stops responding.

Other files: `sidepanel.html`/`sidepanel.js` (the UI), `stealth.js` (MAIN-world
fingerprint spoofing content script — see **Out of scope** below),
`user-livewrite.gs` (legacy Google Apps Script integration, mostly superseded
by the baked-in backend).

### 2. `amazon-playwright-scraper/` — standalone keyword→ASIN scraper

A Node/Express server (`server.js`) that drives a real (headed) Playwright
Chrome to search Amazon by keyword and collect ASINs, for cases where the
extension's own keyword-scrape mode isn't enough (bulk keyword lists, a
separate machine, etc.).

- `POST /scrape` registers a job and returns `{ jobId }` immediately; the
  scrape itself runs in the background. Poll `GET /status?jobId=...` for
  progress, `POST /stop` to cancel. Pass `?wait=1` on `/scrape` for the old
  blocking behavior (kept for any tooling that still wants the full result
  set in one response).
- Config is env-driven — copy `.env.example` to `.env` in this directory (see
  the file for all keys: save folder, concurrency, headless, simulated
  shopper location). Every var defaults to the original hardcoded values, so
  it runs the same as before out of the box.
- Every scraped row passes through `validateAsinRecord()` before being
  written to CSV. Rows that fail land in a sibling `*.needs_review.csv`
  instead of being silently dropped or mixed into the main output.

### 3. `sg-vpn-controller/` — companion IP-rotation extension

A separate MV3 extension that rotates outbound IP for `amazon.*` domains,
either via `chrome.proxy` (preferred — configure your own proxy list on its
Options page; see **Known limitations** re: the bundled default list) or by
driving the Urban VPN browser extension through a native host as a fallback.

### 4. `sg-vpn-native-host/` — native-messaging host for the Urban VPN fallback

A small Node native-messaging host (`host.mjs`) + AutoHotkey script
(`UrbanVPN.ahk`) that drives Urban VPN's UI by image recognition, only used
when `sg-vpn-controller` is configured with the `urbanvpn` backend instead of
a real proxy. See `sg-vpn-native-host/README.md` for the extension-ID wiring
steps between the controller and the main extension.

## Result validation ("honest accuracy," not "100% accuracy")

Heuristic web scraping and search matching cannot be perfectly accurate, and
this project doesn't pretend otherwise. Instead, every candidate result passes
through a validation gate before it's ever written as a confirmed "found"
record:

- **Extension side**: `validateResult()` in `background.js` checks ASIN
  format, website URL syntax, brand-string sanity (rejects empty/placeholder
  brands like "Amazon" or "Visit the Store"), and that the confidence score is
  numeric. Records that fail land in a `needs-review` status — never dropped,
  never written to the shared database or exported CSV as if they were a
  confirmed match. The count is surfaced in the run-completion summary line
  and in `ST.stats.needsReview`.
- **Scraper side**: `validateAsinRecord()` in `amazon-playwright-scraper/server.js`
  does the equivalent check on scraped ASIN/URL rows, quarantining failures
  into a sibling `*.needs_review.csv`.

## Testing

```
npm test
```

runs the unit test suite (`node --test test/*.test.js`, no extra
dependencies — Node's built-in test runner). Covers the pure,
browser-independent functions: `domainMatchesBrand`, `brandDomainResemblance`,
`pickSearchCandidate`, `_parseAmazonHtml`, and `validateResult` from
`background.js`; `validateAsinRecord` from `server.js`; `parseProxyLine` from
`sg-vpn-controller`. `amazon-playwright-scraper/` also has its own
`npm test` pointing at the same server-side suite.

`test/_extract.js` explains how these get pulled out of files that can't be
`require()`'d directly (they touch `chrome.*`/`document.*` at module scope, or
call `app.listen()` on load) — it tests the real, verbatim production source,
not a reimplementation.

## Reliability: blocking & service-worker restarts

The extension fights Amazon rate-limiting with an adaptive controller (AIMD
concurrency + a request/second token bucket + a circuit-breaker "wall rest").
When Amazon walls the IP, the controller *learns* a slower safe rate.

That learned backoff is snapshotted to `chrome.storage` (`_sgRuntime`) so it
**survives a service-worker restart** — a naive restart would reset the
controller to its aggressive starting rate and immediately re-trip the wall
(the wall→recover→wall loop). The snapshot is written on every back-off event
(not just the deliberate self-heal reload), so it also survives a watchdog
crash-reload or an MV3 kill; on restart it's inherited only if fresh (saved
within 10 min — `_runtimeSnapshotIsFresh()`, unit-tested), since a
long-dead-then-revived worker has likely seen its IP cool down and is better
off starting clean.

The MV3 keepalive is kept armed during the keyword-scrape phase too, not just
the website-finder phase, so the worker doesn't suspend mid-scrape.

**Honest limit:** blocking cannot be eliminated — it's an inherent consequence
of operating against Amazon's ToS (see below). These mechanisms make the tool
back off politely and recover cleanly; they do not, and are not intended to,
make the scraping undetectable.

## Known limitations & risks

- **Accuracy ceiling.** Brand-to-website matching is a heuristic, multi-tier
  best-guess pipeline (domain-name matching, string resemblance, search-result
  ranking). It will never be 100% correct. The `needs-review` quarantine
  bounds *how wrong a confirmed record can silently be* — it does not, and
  cannot, guarantee every "found" result is actually correct. Low-confidence
  and malformed matches are the ones caught; a confident-looking but wrong
  match (e.g. a reseller's site that happens to pass the domain check) can
  still get through.
- **Operating against target sites' Terms of Service is an inherent risk of
  this pipeline, not a bug to be engineered away.** Automated scraping of
  Amazon and querying search engines programmatically both fall outside those
  sites' terms of service. Rate limiting, CAPTCHAs, and IP/account blocks are
  expected operational friction, not defects — the adaptive rate limiter,
  circuit breaker, and IP-rotation companion extension exist to operate
  *within* that reality, not to eliminate it. Anti-detection/stealth code
  (`stealth.js`, the CAPTCHA-handling paths in `background.js`) is intentionally
  out of scope for further hardening in this codebase — see the code comments
  where it's used.
- **`manifest.json` is the single source of truth for the version** (currently
  `7.1.49`). The `background.js`/`sidepanel.js` header banners and the
  sidepanel's user-facing version strings are kept in sync with it; the inline
  `// v7.1.x:` changelog annotations throughout the code are historical
  "added-in" markers, not the current version. Note the folder is still named
  `v7.1.11` — a stale directory name, harmless, left as-is to avoid breaking
  any absolute paths that reference it.
- **The shared backend (`emailcampaign.ai`) is hardcoded** in both
  `background.js` and `sidepanel.js`. This is by design (v7.1.2 — no
  per-user Google Apps Script setup needed) and out of scope to change here;
  flagged only so it's not mistaken for an oversight.
- **`sg-vpn-controller`'s bundled `DEFAULT_PROXIES` list is a set of free
  public proxies** the code's own comment admits are "probably already dead" —
  free public proxies die within minutes and aren't a reliable default.
  Replace them with your own on the Options page before relying on this for
  real traffic. (Fixing the default-to-DIRECT-with-a-warning behavior instead
  of shipping a likely-dead list is a known follow-up, not yet done.)
