const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
// Raw (un-stealthed) Playwright for the brand reader — it drives the REAL
// installed Chrome via channel:'chrome' with a persistent profile, where the
// stealth plugin's patches are unnecessary and only add fingerprint surface.
// See _getBrandContext for why that combination is what beats the 202 block.
const { chromium: rawChromium } = require('playwright');

// ── Minimal .env loader (no new dependency) ─────────────────────────────────
// Reads a .env file next to this script, if present, and merges KEY=VALUE
// lines into process.env (never overrides a var already set in the real
// environment). See .env.example for the full list of supported keys.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      const [, key, rawVal] = m;
      if (process.env[key] === undefined) process.env[key] = rawVal.replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* .env is optional — a load error here just means defaults apply */ }
})();

const app = express();

// ── Security: lock down who can drive this local server ──────────────────────
// This process launches real (headed) Chrome windows on the machine, so an
// unauthenticated /scrape endpoint is a genuine abuse/DoS surface. Two guards:
//   1. CORS is restricted to the extension itself (chrome-extension:// origin)
//      and to origin-less callers (curl / node test scripts). Arbitrary web
//      pages you happen to visit get a CORS rejection and can't trigger jobs.
//   2. The listener binds to 127.0.0.1 only (see app.listen below), so nothing
//      on the LAN can reach it either — loopback only.
app.use(cors({
  origin(origin, cb) {
    // No Origin header = same-machine tooling (curl, the test script) → allow.
    if (!origin) return cb(null, true);
    if (/^chrome-extension:\/\//i.test(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'), false);
  },
}));
app.use(express.json({ limit: '1mb' }));

// Sane hard caps so a single request can't spin up an unbounded amount of work.
const MAX_KEYWORDS = 500;
const MAX_PAGES    = 20;
const ALLOWED_DOMAIN = /^amazon\.(com|co\.uk|ca|de|fr|co\.jp|com\.au|es|it|nl)$/i;

// Higher CONCURRENCY = faster scraping but more parallel Amazon requests from
// this IP, which raises block risk. 1 is the safe default; raise it only if
// you have proxy rotation or accept a higher block rate.
const CONCURRENCY      = Number(process.env.SG_CONCURRENCY) || 1;
// Headed (visible) Chrome windows are the current default — headless is more
// detectable to Amazon's bot checks, so this is opt-in, not opt-out.
const HEADLESS         = process.env.SG_HEADLESS === 'true';
const BATCH_DELAY      = 3000;  // ms cooldown between batches
const RESET_WAIT_MIN   = 30000; // ms min wait after block before relaunch
const RESET_WAIT_MAX   = 60000; // ms max wait
const SAVE_FOLDER      = process.env.SG_SAVE_FOLDER || path.join(os.homedir(), 'Scrapped');

// ── Simulated shopper location ──────────────────────────────────────────────
// Amazon personalizes search/availability by locale. These defaults reproduce
// the original hardcoded NYC/ZIP-10003 profile; override via env if you need
// a different region.
const SCRAPE_ZIP      = process.env.SG_ZIP      || '10003';
const SCRAPE_LOCALE   = process.env.SG_LOCALE   || 'en-US';
const SCRAPE_TIMEZONE = process.env.SG_TIMEZONE || 'America/New_York';
const SCRAPE_LAT      = Number(process.env.SG_LAT) || 40.7302;
const SCRAPE_LON      = Number(process.env.SG_LON) || -73.9877;

// ── Proxy rotation ─────────────────────────────────────────────────────────
// Add proxies as 'http://user:pass@host:port' or 'http://host:port'.
// Leave empty to run without a proxy.
const PROXIES = [
  // 'http://user:pass@proxy1.example.com:8080',
  // 'http://user:pass@proxy2.example.com:8080',
];
let proxyIndex = 0;
function nextProxy() {
  if (!PROXIES.length) return null;
  const p = PROXIES[proxyIndex % PROXIES.length];
  proxyIndex++;
  return { server: p };
}

// ── User-agent rotation (realistic Mozilla/Firefox + Chrome strings) ────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];
function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Per-job state — keyed by jobId so jobs never share or overwrite each other
const jobs = new Map();
// { logs: [], progress: { completedCount, totalCount, foundCount, filename }, stopRequested: false }

function makeJobId() {
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23); // includes ms
  const rand = Math.random().toString(36).slice(2, 6);                       // 4 random chars
  return `${ts}-${rand}`;
}

// Clean up jobs older than 2 hours. Each job stores its own createdAt
// (Date.now() at registration) rather than this having to reverse-engineer a
// timestamp out of the jobId string — jobId's format is an implementation
// detail of makeJobId() and shouldn't be parsed elsewhere.
function cleanupOldJobs() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if ((job.createdAt || 0) < cutoff) jobs.delete(id);
  }
}

function jobLog(jobId, msg) {
  console.log(`[${jobId}] ${msg}`);
  const job = jobs.get(jobId);
  if (job) job.logs.push(msg);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Enforce delivery ZIP code via Amazon's location modal ─────────────────
// Amazon sometimes ignores the cookie and shows a location picker. This
// detects the modal, types the ZIP, confirms, and waits for the page to
// update before scraping — so results are always for the correct location.
async function enforceZip(page, zip) {
  try {
    // Check if the location modal / inline form is visible
    const zipInput = await page.$('#GLUXZipUpdateInput');
    if (!zipInput) return; // modal not present — cookie was accepted, nothing to do

    await zipInput.click({ clickCount: 3 }); // select any existing value
    await zipInput.type(zip, { delay: 80 });

    // Click the Apply / Submit button inside the modal
    const applyBtn = await page.$('#GLUXZipUpdate input[type="submit"], #GLUXZipUpdate button, .a-popover-footer input[type="submit"]');
    if (applyBtn) {
      await applyBtn.click();
      // Wait for the page to reload with the new location
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      console.log(`    📍 Location set to ZIP ${zip}`);
    }
  } catch (_) {
    // Modal may not appear on every request — not fatal
  }
}

// ── Hard-refresh a page and wait for it to be responsive again ────────────
async function hardRefresh(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

// ── Run fn; if it times out or the page is unresponsive, hard-refresh once ─
async function withRefreshOnFail(page, fn, label) {
  try {
    return await fn();
  } catch (err) {
    const isUnresponsive = /timeout|target closed|navigation|crashed|detached/i.test(err.message);
    if (isUnresponsive) {
      console.log(`    🔄 Page unresponsive on "${label}" — hard-refreshing…`);
      await hardRefresh(page);
      return await fn(); // one retry after refresh
    }
    throw err; // not an unresponsive error — let caller handle
  }
}

// ── Scrape one keyword across maxPages, reusing a single page ─────────────
// Returns { items: [...], blocked: bool }
async function scrapeKeyword(page, kw, domain, maxPages, shouldStop) {
  // Random jitter before hitting Amazon — 5–8s to avoid IP flagging
  await page.waitForTimeout(5000 + Math.floor(Math.random() * 3000));

  const searchUrl = `https://www.${domain}/s?k=${encodeURIComponent(kw)}`;

  // Initial load — hard-refresh if the page doesn't respond
  await withRefreshOnFail(page,
    () => page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }),
    kw
  ).catch(() => {});

  // Enforce configured ZIP — handle Amazon's "Choose your location" modal if it appears
  await enforceZip(page, SCRAPE_ZIP);

  const items = [];

  for (let p = 1; p <= maxPages; p++) {
    if (shouldStop && shouldStop()) break;

    // Auto-click "Continue Shopping" if Amazon shows an interstitial
    const clickedContinue = await withRefreshOnFail(page, () => page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
      for (const el of els) {
        const label = [el.textContent || '', el.value || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '']
          .join(' ').replace(/\s+/g, ' ').trim();
        const href = el.href || el.getAttribute('href') || '';
        if (/continue\s+shopping/i.test(label) || /continue.*shopping/i.test(href)) {
          el.click();
          return true;
        }
      }
      return false;
    }), `continue-shopping p${p}`).catch(() => false);

    if (clickedContinue) {
      console.log(`    ↪️ Auto-clicked "Continue Shopping" on: "${kw}"`);
      await page.waitForTimeout(1200);
    }

    // Check for CAPTCHA / block page — URL check is instant and most reliable
    const isBlocked = await page.evaluate(() => {
      const url  = window.location.href;
      const title = document.title || '';
      const text  = (document.body && document.body.innerText) || '';
      return url.includes('validateCaptcha') ||
             url.includes('/errors/') ||
             title.includes('Robot Check') ||
             title.includes('Sorry!') ||
             text.includes('Type the characters you see in this image') ||
             text.includes('Enter the characters you see below') ||
             text.includes('automated access') ||
             text.includes('CAPTCHA');
    }).catch(() => false);

    if (isBlocked) {
      return { items, blocked: true };
    }

    // Extract ASINs and brand hints from live DOM
    const pageItems = await withRefreshOnFail(page, () => page.evaluate((dom) => {
      const out = [];
      document.querySelectorAll('[data-asin][data-component-type="s-search-result"]').forEach(card => {
        const asin = (card.getAttribute('data-asin') || '').trim();
        if (!asin || asin.length < 5) return;

        let brandHint = '';
        const brandEl = card.querySelector('[data-cy="title-recipe-brand-name"], .s-line-clamp-1 span');
        if (brandEl && brandEl.textContent) {
          brandHint = brandEl.textContent.trim().replace(/^Brand:\s*/i, '').split('\n')[0].trim().slice(0, 60);
        }

        out.push({ asin, brandHint, url: `https://www.${dom}/dp/${asin}` });
      });
      return out;
    }, domain), `extract p${p}`).catch(() => []);

    items.push(...pageItems);

    // Navigate to next page by clicking the button — more human-like than URL construction
    if (p < maxPages) {
      const nextBtn = await page.$('.s-pagination-next:not(.s-pagination-disabled)').catch(() => null);
      if (nextBtn) {
        await withRefreshOnFail(page, () => Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }),
          nextBtn.click(),
        ]), `pagination p${p}`).catch(() => {});
        await page.waitForTimeout(800 + Math.floor(Math.random() * 1000));
      } else {
        break;
      }
    }
  }

  return { items, blocked: false };
}

// ── Full browser reset + warm-up on block ─────────────────────────────────
// Closes the current browser, waits, relaunches, then opens 2–3 warm-up tabs
// on amazon.com before returning the fresh browser instance.
async function resetAndWarm(oldBrowser, jobId, domain) {
  if (oldBrowser) await oldBrowser.close().catch(() => {});

  const waitMs = RESET_WAIT_MIN + Math.floor(Math.random() * (RESET_WAIT_MAX - RESET_WAIT_MIN));
  jobLog(jobId, `  🔄 Browser reset — waiting ${Math.round(waitMs / 1000)}s before relaunch…`);
  await sleep(waitMs);

  const newBrowser = await chromium.launch({ headless: HEADLESS });

  // Warm up 2–3 tabs on amazon.com — establishes session before real scraping
  const warmCount = 2 + Math.floor(Math.random() * 2); // 2 or 3
  jobLog(jobId, `  🌡️ Warming up ${warmCount} Amazon tabs…`);

  for (let i = 0; i < warmCount; i++) {
    const warmProxy = nextProxy();
    const warmOpts  = {
      locale: SCRAPE_LOCALE, timezoneId: SCRAPE_TIMEZONE,
      geolocation: { longitude: SCRAPE_LON, latitude: SCRAPE_LAT },
      permissions: ['geolocation'],
      userAgent: randomUA(),
      viewport:  { width: 1366 + Math.floor(Math.random() * 200), height: 768 + Math.floor(Math.random() * 100) },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (warmProxy) warmOpts.proxy = warmProxy;
    const ctx = await newBrowser.newContext(warmOpts);
    await ctx.addCookies([{ name: 'x-amz-postal-code', value: SCRAPE_ZIP, domain: '.' + domain, path: '/' }]);
    await ctx.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
      return route.continue();
    });
    const pg = await ctx.newPage();
    await pg.goto(`https://www.${domain}/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await pg.waitForTimeout(2000 + Math.floor(Math.random() * 1500));
    await ctx.close().catch(() => {});
  }

  jobLog(jobId, `  ✅ Browser ready — resuming scrape steadily`);
  return newBrowser;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Returns logs + progress for a specific job. The extension passes ?jobId=xxx.
// Falls back to the most recent job if no jobId given (backwards compat).
app.get('/status', (req, res) => {
  const { jobId } = req.query;
  if (jobId && jobs.has(jobId)) {
    const j = jobs.get(jobId);
    return res.json({ logs: j.logs, progress: j.progress });
  }
  // No jobId — return the most recently created job
  if (jobs.size) {
    const latest = [...jobs.values()].at(-1);
    return res.json({ logs: latest.logs, progress: latest.progress });
  }
  res.json({ logs: [], progress: null });
});

app.post('/scrape', async (req, res) => {
  const { keywords, maxPages = 1, domain = 'amazon.com' } = req.body;
  if (!keywords || !Array.isArray(keywords) || !keywords.length)
    return res.status(400).json({ error: 'keywords[] required' });
  if (keywords.length > MAX_KEYWORDS)
    return res.status(400).json({ error: `too many keywords (max ${MAX_KEYWORDS})` });
  if (!ALLOWED_DOMAIN.test(domain))
    return res.status(400).json({ error: 'unsupported domain' });
  // Clamp maxPages to a sane range so one request can't request unbounded paging.
  const pages = Math.min(MAX_PAGES, Math.max(1, Number(maxPages) || 1));
  // Keep only non-empty string keywords, deduped, each length-capped.
  const cleanKeywords = [...new Set(
    keywords.filter(k => typeof k === 'string').map(k => k.trim().slice(0, 200)).filter(Boolean)
  )];
  if (!cleanKeywords.length)
    return res.status(400).json({ error: 'no valid keywords' });

  const jobId     = makeJobId();
  const jobFolder = path.join(SAVE_FOLDER, jobId);          // Scrapped/<jobId>/
  const filename  = `amazon-asins-${jobId}.csv`;            // file inside that folder

  // Register this job — completely isolated from any other job
  jobs.set(jobId, {
    createdAt:     Date.now(),
    logs:          [],
    progress:      { completedCount: 0, totalCount: cleanKeywords.length, foundCount: 0, filename, folder: jobFolder },
    stopRequested: false,
  });

  cleanupOldJobs();

  // Create the job folder NOW — before any scraping, so saves never race mkdir
  fs.mkdirSync(jobFolder, { recursive: true });
  console.log(`📁 Job folder created: ${jobFolder}`);

  const jobPromise = runScrapeJob({ jobId, cleanKeywords, pages, domain, jobFolder, filename });

  // ?wait=1 — old blocking behavior, kept for any existing caller/tooling that
  // expects the full result set in the HTTP response.
  if (req.query.wait === '1') {
    const final = await jobPromise; // runScrapeJob catches its own errors and always resolves
    const jobErr = jobs.get(jobId)?.progress?.error;
    return res.json({ success: !jobErr, jobId, count: final.length, file: filename, folder: jobFolder, results: final, ...(jobErr ? { error: jobErr } : {}) });
  }

  // Default: non-blocking. The job runs in the background; the client polls
  // /status?jobId=... for progress and reads the CSV (or /stop to cancel).
  // A holding request open for a multi-thousand-keyword job would exceed most
  // client/proxy HTTP timeouts long before Playwright finishes.
  jobPromise.catch(err => jobLog(jobId, `⚠️ Unhandled job error: ${err.message}`));
  res.json({ success: true, jobId, message: `Job started — poll /status?jobId=${jobId}` });
});

// Jobs finish outside the request/response cycle now (see ?wait=1 note above),
// so the actual scrape work lives in its own function rather than inline in
// the route handler.
async function runScrapeJob({ jobId, cleanKeywords, pages, domain, jobFolder, filename }) {
  const job = jobs.get(jobId);
  const allASINs = new Map();

  jobLog(jobId, `Starting scrape for ${cleanKeywords.length} keywords${PROXIES.length ? ` (${PROXIES.length} proxies configured)` : ' (no proxy)'}`);

  // Assigned inside the try below so a launch failure is caught and the job is
  // still marked done in the finally — otherwise a poller waits on it forever.
  let browser = null;

  // Helper: open one context+page, scrape kw, close context
  async function runKeyword(kw) {
    const proxy   = nextProxy();
    const ctxOpts = {
      locale:      SCRAPE_LOCALE,
      timezoneId:  SCRAPE_TIMEZONE,
      geolocation: { longitude: SCRAPE_LON, latitude: SCRAPE_LAT },
      permissions: ['geolocation'],
      userAgent:   randomUA(),
      viewport:    { width: 1366 + Math.floor(Math.random() * 200), height: 768 + Math.floor(Math.random() * 100) },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (proxy) ctxOpts.proxy = proxy;
    const context = await browser.newContext(ctxOpts);
    await context.addCookies([{
      name: 'x-amz-postal-code', value: SCRAPE_ZIP, domain: '.' + domain, path: '/',
    }]);
    await context.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    try {
      return await scrapeKeyword(page, kw, domain, pages, () => job.stopRequested);
    } finally {
      await context.close().catch(() => {});
    }
  }

  let final = [];
  try {
    browser = await chromium.launch({ headless: HEADLESS });

    for (let i = 0; i < cleanKeywords.length && !job.stopRequested; i += CONCURRENCY) {
      const chunk = cleanKeywords.slice(i, i + CONCURRENCY);

      // Run chunk in parallel — each returns { items, blocked }
      const chunkResults = await Promise.all(chunk.map(async kw => {
        jobLog(jobId, `      🔍 Scraping: "${kw}"`);
        try {
          const { items, blocked } = await runKeyword(kw);
          if (blocked) {
            jobLog(jobId, `  ⚠️ [BLOCKED] Amazon bot detection triggered on: "${kw}"`);
            return { kw, items, blocked: true };
          }
          jobLog(jobId, `      ✅ Finished: "${kw}" (${items.length} ASINs found)`);
          job.progress.completedCount++;
          return { kw, items, blocked: false };
        } catch (err) {
          jobLog(jobId, `  ❌ "${kw}" error: ${err.message}`);
          job.progress.completedCount++;
          return { kw, items: [], blocked: false };
        }
      }));

      // Collect blocked keywords from this chunk for retry
      const blockedKws = chunkResults.filter(r => r.blocked).map(r => r.kw);

      // Merge successful results
      chunkResults.filter(r => !r.blocked).forEach(r =>
        r.items.forEach(item => { if (!allASINs.has(item.asin)) allASINs.set(item.asin, item); })
      );

      // If any keyword was blocked: reset browser, warm up, retry blocked ones one by one
      if (blockedKws.length && !job.stopRequested) {
        jobLog(jobId, `  🚫 ${blockedKws.length} keyword(s) blocked — resetting browser…`);
        browser = await resetAndWarm(browser, jobId, domain);

        for (const kw of blockedKws) {
          if (job.stopRequested) break;
          jobLog(jobId, `      🔁 Retrying: "${kw}"`);
          try {
            const { items, blocked } = await runKeyword(kw);
            if (blocked) {
              jobLog(jobId, `      ⛔ Still blocked on retry: "${kw}" — skipping`);
            } else {
              jobLog(jobId, `      ✅ Retry succeeded: "${kw}" (${items.length} ASINs found)`);
              items.forEach(item => { if (!allASINs.has(item.asin)) allASINs.set(item.asin, item); });
            }
          } catch (err) {
            jobLog(jobId, `  ❌ Retry error "${kw}": ${err.message}`);
          }
          job.progress.completedCount++;
          // Steady pace between retries
          if (!job.stopRequested) await sleep(3000 + Math.floor(Math.random() * 2000));
        }
      }

      job.progress.foundCount = allASINs.size;

      // Incremental CSV save — partial results survive if job is stopped early
      await saveCSV(Array.from(allASINs.values()), filename, jobFolder);

      // Short cooldown between batches
      if (i + CONCURRENCY < cleanKeywords.length && !job.stopRequested) await sleep(BATCH_DELAY);
    }
  } catch (err) {
    jobLog(jobId, `⚠️ Fatal: ${err.message}`);
    if (job) job.progress.error = err.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Final save runs exactly once here in EVERY path — normal completion, a
    // mid-loop crash, or a launch failure — so whatever was collected is always
    // persisted (incremental per-batch saves already cover most of it).
    final = Array.from(allASINs.values());
    try {
      const saveResult = await saveCSV(final, filename, jobFolder);
      jobLog(jobId, `✅ Done — ${saveResult.validCount} unique ASINs saved to ${jobFolder}\\${filename}`);
      if (saveResult.needsReviewCount) {
        jobLog(jobId, `⚠️ ${saveResult.needsReviewCount} row(s) failed validation — see ${filename.replace(/\.csv$/i, '')}.needs_review.csv`);
      }
    } catch (saveErr) {
      jobLog(jobId, `⚠️ Final CSV save failed: ${saveErr.message}`);
      if (job && !job.progress.error) job.progress.error = saveErr.message;
    }
    if (job) job.progress.done = true; // always resolve the job so pollers don't hang
  }

  return final;
}

// ═══════════════════════════════════════════════════════════════════════════
// BRAND READER — the raw-ASIN path
// ═══════════════════════════════════════════════════════════════════════════
// The extension reads a product-page brand with a service-worker fetch() and,
// on failure, a helper tab. Both are walled hard on a rate-limited IP: the SW
// fetch can't set Sec-Fetch/UA/Referer (forbidden headers) and leaks an
// extension Origin, and the tabs share the same throttled profile. When the
// wall is up, EVERY raw ASIN ends as "Amazon page blocked — brand unread",
// because a pasted ASIN has no brandHint to fall back on.
//
// A real headed Chromium with the stealth plugin, a genuine TLS/JA3
// fingerprint and a warm cookie jar reads those same pages while the extension
// is walled. This endpoint exposes exactly that, one ASIN at a time, so the
// extension can hand off the brand read and keep its own pipeline for search.
//
// The extractor below is a VERBATIM port of the extension's in-tab extractor
// (background.js `fetchAmazonProductViaTab`) so brands come out byte-identical
// — the search/match logic downstream sees no change in its input.

const BRAND_CONCURRENCY  = Number(process.env.SG_BRAND_CONCURRENCY) || 3;
const BRAND_REST_MS      = Number(process.env.SG_BRAND_REST_MS) || 45000;
const BRAND_BLOCK_STRIKES = 5;

let _brandBrowser   = null;
let _brandContext   = null;
let _brandLaunching = null;
let _brandStrikes   = 0;
let _brandRestUntil = 0;
let _brandActive    = 0;
const _brandQueue   = [];
// cssRescued counts pages where blocking stylesheets hid the byline and the
// guard re-read recovered it. If this climbs, Amazon has started serving the
// degraded no-CSS skeleton again and BRAND_BLOCK_FAST should drop 'stylesheet'.
let _brandStats     = { ok: 0, blocked: 0, empty: 0, cssRescued: 0, errors: 0 };

function _acquireBrandSlot() {
  return new Promise(resolve => {
    if (_brandActive < BRAND_CONCURRENCY) { _brandActive++; return resolve(); }
    _brandQueue.push(resolve);
  });
}
function _releaseBrandSlot() {
  _brandActive = Math.max(0, _brandActive - 1);
  const next = _brandQueue.shift();
  if (next) { _brandActive++; next(); }
}

async function _closeBrandBrowser() {
  const c = _brandContext;
  _brandBrowser = null; _brandContext = null;
  if (c) await c.close().catch(() => {});
}

// One PERSISTENT real-Chrome profile, reused across requests AND across server
// restarts. Both properties are load-bearing, measured against amazon.com:
//
//   * Persistent + warmed  → /dp/ returns 200 with the full product page.
//   * Cold ephemeral ctx   → /dp/ returns **HTTP 202 with an empty body**.
//
// The 202 is Amazon's silent bot block. It is NOT a fingerprint problem: it
// reproduced with real Chrome and navigator.webdriver === false. It is purely
// about session cookies — a context that has never touched amazon.com gets 202
// on a direct product-page hit, and the same profile succeeds on the next run
// once the cookie jar exists. That is why we warm up on the homepage first and
// why the profile lives on disk instead of being rebuilt every launch.
//
// Uses `channel: 'chrome'` (the real installed Chrome), not bundled Chromium,
// and deliberately does NOT use the stealth plugin or a randomised userAgent:
// a genuine Chrome profile with its own real UA is the least detectable thing
// available, and overriding the UA only desynchronises it from the real client
// hints Chrome sends.
const BRAND_PROFILE_DIR = process.env.SG_BRAND_PROFILE || path.join(os.homedir(), '.sg-brand-profile');

async function _getBrandContext(domain) {
  if (_brandContext) return _brandContext;
  if (_brandLaunching) return _brandLaunching;
  _brandLaunching = (async () => {
    try {
      const proxy = nextProxy();
      const opts = {
        channel:     'chrome',
        headless:    HEADLESS,
        locale:      SCRAPE_LOCALE,
        timezoneId:  SCRAPE_TIMEZONE,
        geolocation: { longitude: SCRAPE_LON, latitude: SCRAPE_LAT },
        permissions: ['geolocation'],
        viewport:    { width: 1366 + Math.floor(Math.random() * 200), height: 768 + Math.floor(Math.random() * 100) },
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        args: ['--disable-blink-features=AutomationControlled'],
      };
      if (proxy) opts.proxy = proxy;
      _brandContext = await rawChromium.launchPersistentContext(BRAND_PROFILE_DIR, opts);
      _brandBrowser = _brandContext.browser();
      await _brandContext.addCookies([{
        name: 'x-amz-postal-code', value: SCRAPE_ZIP, domain: '.' + domain, path: '/',
      }]).catch(() => {});
      // Resource blocking is applied per-PAGE (see _readPage) rather than here,
      // so the CSS-degrade guard can re-read a page with a different block list.
      // Warm the jar on the homepage before any /dp/ hit — see the 202 note above.
      const warm = await _brandContext.newPage();
      await warm.goto(`https://www.${domain}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await warm.waitForTimeout(2000);
      await warm.close().catch(() => {});
      console.log(`🏷️  Brand browser ready — real Chrome, profile ${BRAND_PROFILE_DIR} (concurrency ${BRAND_CONCURRENCY}, headless=${HEADLESS})`);
      return _brandContext;
    } finally {
      _brandLaunching = null;
    }
  })();
  return _brandLaunching;
}

// VERBATIM port of the extension's in-tab extractor. Keep the two in sync.
function _extractBrandInPage() {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim()
    .replace(/^(Brand:|Visit the\s+|by\s+)/i, '')
    .replace(/\s+Store\s*$/i, '')
    .replace(/\s*\((Author|Editor|Illustrator|Translator|Contributor|Narrator|Artist|Publisher)[^)]*\).*/i, '')
    .trim();
  let brand = '';
  const garbage = (s) => !s || /[<>"=?/\\{}|]/.test(s) || /\b(class|href|style|nav_|aria|data-)\b/i.test(s) || /https?:|:\/\//i.test(s) || !/[A-Za-z]/.test(s);
  const pick = (v) => { if (brand) return; const c = clean(v); if (c && c.length > 1 && c.length < 60 && !garbage(c)) brand = c; };

  const by = document.querySelector('#bylineInfo');
  if (by) pick(by.textContent);
  if (!brand) { const m = ((document.body && document.body.innerText) || '').match(/Visit the\s+([^\n]+?)\s+Store/i); if (m) pick(m[1]); }
  if (!brand) { const po = document.querySelector('.po-brand .po-break-word'); if (po) pick(po.textContent); }
  if (!brand) {
    document.querySelectorAll('#productDetails_techSpec_section_1 tr, #detailBullets_feature_div li, .a-keyvalue tr, .prodDetTable tr').forEach(row => {
      if (brand) return;
      const t = (row.textContent || '').replace(/\s+/g, ' ').trim();
      const m = t.match(/^Brand\s*Name?\s*[:\-]?\s*(.+)$/i);
      if (m) pick(m[1]);
    });
  }
  if (!brand) {
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      if (brand) return;
      try { const j = JSON.parse(s.textContent); const b = (j.brand && (j.brand.name || j.brand)) || j.manufacturer; if (typeof b === 'string') pick(b); } catch (_) {}
    });
  }
  const titleEl = document.querySelector('#productTitle');
  const title = (titleEl ? titleEl.textContent : '').trim();
  const asin = ((location.href.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i) || [])[1] || '').toUpperCase();
  const hasProductMarkers = !!document.querySelector('#productTitle, #centerCol, #ppd, #dp, #detailBullets_feature_div');
  return { brand, asin, title, hasProductMarkers };
}

function _isBlockedInPage() {
  const url   = window.location.href;
  const title = document.title || '';
  const text  = (document.body && document.body.innerText) || '';
  return url.includes('validateCaptcha') ||
         url.includes('/errors/') ||
         title.includes('Robot Check') ||
         /sorry/i.test(title) && title.length < 80 ||
         text.includes('Type the characters you see in this image') ||
         text.includes('Enter the characters you see below') ||
         text.includes('automated access') ||
         text.includes('CAPTCHA');
}

// ── Resource blocking ───────────────────────────────────────────────────────
// FAST is the default and also blocks font + stylesheet. Measured over 12 real
// ASINs on a warm profile, FAST vs LIGHT returned **byte-identical brand strings
// on 12/12** and cut 16.8s/item → 9.6s/item (43% faster), all HTTP 200.
//
// The caution this overrides is real but belongs to a different mechanism: the
// EXTENSION blocks CSS via declarativeNetRequest, and there Amazon serves a
// degraded "Skip to / Keyboard shortcuts" skeleton where #bylineInfo never
// renders — a false "brand not found". That did not reproduce here. Rather than
// trust one sample forever, LIGHT is kept as a guard: if a FAST read yields a
// product page with NO brand, it is re-read once with CSS on. That is the exact
// shape of the degrade, and it is the expensive failure (a brandless product is
// classified 'skipped', which is never retried), so it is worth one extra load
// on the rare pages that hit it. Script is deliberately NOT blocked: it bought
// only ~8% more and risks both JS-rendered bylines and looking non-human.
const BRAND_BLOCK_FAST  = ['image', 'media', 'font', 'stylesheet'];
const BRAND_BLOCK_LIGHT = ['image', 'media'];

async function _readPage(ctx, url, blockList) {
  const page = await ctx.newPage();
  try {
    await page.route('**/*', route =>
      blockList.includes(route.request().resourceType()) ? route.abort() : route.continue());
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#bylineInfo', { timeout: 6000 })
      .catch(() => page.waitForSelector('#productTitle, #centerCol, #ppd', { timeout: 4000 }).catch(() => {}));
    const status  = resp ? resp.status() : 0;
    const blocked = status === 202 || status === 429 || status === 503 ||
                    await page.evaluate(_isBlockedInPage).catch(() => false);
    const out = blocked ? null : await page.evaluate(_extractBrandInPage);
    return { status, blocked, out };
  } finally {
    await page.close().catch(() => {});
  }
}

async function readBrand(url, domain) {
  if (Date.now() < _brandRestUntil) {
    return { blocked: true, resting: true, restMs: _brandRestUntil - Date.now() };
  }
  await _acquireBrandSlot();
  try {
    const ctx = await _getBrandContext(domain);
    let { status, blocked, out } = await _readPage(ctx, url, BRAND_BLOCK_FAST);

    // Amazon's silent bot block is an HTTP 202 with an EMPTY body — no CAPTCHA,
    // no "Sorry" text, nothing for the in-page detector to match. Classifying it
    // by status is the only way to see it. Getting this wrong is expensive: a 202
    // scored as "loaded, no brand" marks a real product as a genuine skip and it
    // never gets retried. 429/503 are the ordinary throttle responses.
    if (blocked) {
      if (status === 202 || status === 429 || status === 503) {
        console.log(`  🚫 Brand read blocked — HTTP ${status} (silent bot block)`);
      }
      _brandStats.blocked++;
      if (++_brandStrikes >= BRAND_BLOCK_STRIKES) {
        // A real browser being walled means the IP itself is hot — resting and
        // relaunching with a fresh profile session is the only thing that helps.
        _brandRestUntil = Date.now() + BRAND_REST_MS;
        _brandStrikes = 0;
        console.log(`🧊 Brand browser walled ${BRAND_BLOCK_STRIKES}x — resting ${Math.round(BRAND_REST_MS / 1000)}s and relaunching`);
        await _closeBrandBrowser();
      }
      return { blocked: true };
    }

    // CSS-degrade guard: a product page that rendered but carries no brand is the
    // one outcome blocking CSS could plausibly have caused. Pay one re-read with
    // stylesheets on rather than emit a false "no brand" (→ 'skipped', no retry).
    if (out && out.hasProductMarkers && !out.brand) {
      const retry = await _readPage(ctx, url, BRAND_BLOCK_LIGHT);
      if (retry.out && retry.out.brand) {
        _brandStats.cssRescued++;
        console.log(`  🎨 Brand only visible with CSS on — "${retry.out.brand}" (${url.slice(-10)})`);
        out = retry.out;
      }
    }

    _brandStrikes = 0; // a page that rendered is proof the session still works
    if (out && out.brand) _brandStats.ok++; else _brandStats.empty++;
    return { blocked: false, ...out };
  } catch (e) {
    // Almost always `page.goto: Timeout` from too many parallel pages in one
    // browser — a capacity problem, NOT an Amazon block, so it must not feed the
    // wall/strike accounting. Measured: 3 parallel pages are clean, 6 times out
    // on ~2/3 of reads (and the failures LOOK fast, so raw throughput numbers
    // flatter a broken setting). If `errors` is climbing, lower concurrency.
    _brandStats.errors++;
    console.log(`  ⚠️ Brand read failed (${String(e.message).split('\n')[0].slice(0, 60)})`);
    return { blocked: false, error: e.message, brand: '', title: '', hasProductMarkers: false };
  } finally {
    _releaseBrandSlot();
  }
}

// POST /brand { url } | { asin, domain } → { brand, title, asin, hasProductMarkers, blocked }
app.post('/brand', async (req, res) => {
  const { url, asin, domain = 'amazon.com' } = req.body || {};
  if (!ALLOWED_DOMAIN.test(domain)) return res.status(400).json({ error: 'unsupported domain' });

  let target = '';
  if (typeof url === 'string' && url) {
    let u;
    try { u = new URL(url); } catch (_) { return res.status(400).json({ error: 'bad url' }); }
    // Only ever drive the browser to Amazon — never to an arbitrary host from
    // the request body. This endpoint launches a real browser; an open redirect
    // here would make it a general-purpose fetcher for anything on this machine.
    if (u.protocol !== 'https:' || !ALLOWED_DOMAIN.test(u.hostname.replace(/^www\./, ''))) {
      return res.status(400).json({ error: 'url must be an https amazon domain' });
    }
    target = u.origin + u.pathname;
  } else if (typeof asin === 'string' && /^[A-Z0-9]{10}$/i.test(asin.trim())) {
    target = `https://www.${domain}/dp/${asin.trim().toUpperCase()}`;
  } else {
    return res.status(400).json({ error: 'url or asin required' });
  }

  const out = await readBrand(target, domain);
  res.json(out);
});

app.get('/brand/stats', (req, res) => {
  res.json({
    ..._brandStats,
    concurrency: BRAND_CONCURRENCY,
    resting: Date.now() < _brandRestUntil,
    restMsLeft: Math.max(0, _brandRestUntil - Date.now()),
    up: !!_brandContext,
  });
});

app.post('/stop', (req, res) => {
  const { jobId } = req.body;
  if (jobId && jobs.has(jobId)) {
    jobs.get(jobId).stopRequested = true;
    return res.json({ ok: true, jobId });
  }
  // No jobId — stop the most recent running job
  for (const [, j] of [...jobs].reverse()) {
    if (!j.progress.done) { j.stopRequested = true; break; }
  }
  res.json({ ok: true });
});

// ── Result validation ────────────────────────────────────────────────────────
// Gate before any row is committed to CSV — mirrors the validateResult() gate
// in the extension's background.js. Catches malformed ASINs/URLs mechanically
// so a scraper hiccup or selector drift can't silently produce junk rows that
// look like clean scrape results downstream.
const ASIN_RE = /^[A-Z0-9]{10}$/;
function validateAsinRecord(r) {
  const reasons = [];
  if (!r.asin || !ASIN_RE.test(r.asin)) reasons.push(`invalid ASIN "${r.asin || '(none)'}"`);
  try {
    const u = new URL(r.url || '');
    if (!/^https?:$/.test(u.protocol) || !/\./.test(u.hostname)) reasons.push(`malformed URL "${r.url}"`);
  } catch (_) { reasons.push(`malformed URL "${r.url}"`); }
  return reasons.length ? { valid: false, reason: reasons.join('; ') } : { valid: true };
}

// Wraps fs.writeFileSync with one retry after a short delay — OneDrive/Windows
// can transiently lock a file mid-write (cloud sync, AV scan). If the retry
// also fails, the error propagates so the caller's own error handling (the
// scrape loop's 'Fatal' log, or the /scrape route's catch) surfaces it
// instead of the write failure being lost silently.
async function writeFileWithRetry(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    console.error(`⚠️ CSV write failed (${err.message}) — retrying once: ${filePath}`);
    await sleep(300);
    fs.writeFileSync(filePath, content, 'utf-8'); // let a second failure throw
  }
}

// ── CSV writer ─────────────────────────────────────────────────────────────
// folder defaults to SAVE_FOLDER — pass jobFolder to isolate per job
// Rows that fail validateAsinRecord() are quarantined into a sibling
// "*.needs_review.csv" file instead of being dropped or mixed into the main
// output, so nothing bad is silently written and nothing is silently lost.
async function saveCSV(rows, filename, folder) {
  const dir = folder || SAVE_FOLDER;
  fs.mkdirSync(dir, { recursive: true }); // no-op if already exists
  const BOM = '﻿';
  const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;

  const valid = [], needsReview = [];
  for (const r of rows) {
    const v = validateAsinRecord(r);
    if (v.valid) valid.push(r);
    else needsReview.push({ ...r, _reviewReason: v.reason });
  }

  // url is now quoted/escaped the same way as brandHint — previously it was
  // written raw, which would corrupt the row if a URL ever contained a comma
  // or quote character.
  const body = valid.map(r => `${r.asin},${esc(r.brandHint)},${esc(r.url)}`).join('\r\n');
  await writeFileWithRetry(path.join(dir, filename), BOM + 'ASIN,BrandHint,URL\r\n' + body);

  if (needsReview.length) {
    const reviewName = filename.replace(/\.csv$/i, '') + '.needs_review.csv';
    const reviewBody = needsReview
      .map(r => `${r.asin || ''},${esc(r.brandHint)},${esc(r.url)},${esc(r._reviewReason)}`)
      .join('\r\n');
    await writeFileWithRetry(path.join(dir, reviewName), BOM + 'ASIN,BrandHint,URL,ReviewReason\r\n' + reviewBody);
  }

  return { validCount: valid.length, needsReviewCount: needsReview.length };
}

// ── Process safety ─────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('⚠️', err.message));
process.on('unhandledRejection', r   => console.error('⚠️', r));

const PORT = 3000;
// Bind to loopback only — never expose this Chrome-launching server to the LAN.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Source Genius Playwright Scraper`);
  console.log(`📡 http://127.0.0.1:${PORT} (loopback only)`);
  console.log(`📁 Output: ${SAVE_FOLDER}`);
  console.log(`⚡ Concurrency: ${CONCURRENCY}`);
  console.log(`${'='.repeat(50)}\n`);
});
