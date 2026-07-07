const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

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

const CONCURRENCY      = 1;
const BATCH_DELAY      = 3000;  // ms cooldown between batches
const RESET_WAIT_MIN   = 30000; // ms min wait after block before relaunch
const RESET_WAIT_MAX   = 60000; // ms max wait
const SAVE_FOLDER      = 'C:\\Users\\chkam\\OneDrive\\Desktop\\Scrapped';

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

  // Enforce ZIP 10003 — handle Amazon's "Choose your location" modal if it appears
  await enforceZip(page, '10003');

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

  const newBrowser = await chromium.launch({ headless: false });

  // Warm up 2–3 tabs on amazon.com — establishes session before real scraping
  const warmCount = 2 + Math.floor(Math.random() * 2); // 2 or 3
  jobLog(jobId, `  🌡️ Warming up ${warmCount} Amazon tabs…`);

  for (let i = 0; i < warmCount; i++) {
    const warmProxy = nextProxy();
    const warmOpts  = {
      locale: 'en-US', timezoneId: 'America/New_York',
      geolocation: { longitude: -73.9877, latitude: 40.7302 },
      permissions: ['geolocation'],
      userAgent: randomUA(),
      viewport:  { width: 1366 + Math.floor(Math.random() * 200), height: 768 + Math.floor(Math.random() * 100) },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (warmProxy) warmOpts.proxy = warmProxy;
    const ctx = await newBrowser.newContext(warmOpts);
    await ctx.addCookies([{ name: 'x-amz-postal-code', value: '10003', domain: '.' + domain, path: '/' }]);
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
    logs:          [],
    progress:      { completedCount: 0, totalCount: cleanKeywords.length, foundCount: 0, filename, folder: jobFolder },
    stopRequested: false,
  });

  // Clean up jobs older than 2 hours (parse timestamp as UTC by appending Z)
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const toDelete = [];
  for (const [id] of jobs) {
    const ts = id.slice(0, 23).replace(/-/g, (m, i) => i === 10 ? 'T' : i === 13 || i === 16 ? ':' : i === 19 ? '.' : '-') + 'Z';
    if (new Date(ts).getTime() < cutoff) toDelete.push(id);
  }
  toDelete.forEach(id => jobs.delete(id));

  // Create the job folder NOW — before any scraping, so saves never race mkdir
  fs.mkdirSync(jobFolder, { recursive: true });
  console.log(`📁 Job folder created: ${jobFolder}`);

  const allASINs = new Map();

  jobLog(jobId, `Starting scrape for ${cleanKeywords.length} keywords${PROXIES.length ? ` (${PROXIES.length} proxies configured)` : ' (no proxy)'}`);

  let browser = await chromium.launch({ headless: false });

  const job = jobs.get(jobId);

  // Helper: open one context+page, scrape kw, close context
  async function runKeyword(kw) {
    const proxy   = nextProxy();
    const ctxOpts = {
      locale:      'en-US',
      timezoneId:  'America/New_York',
      geolocation: { longitude: -73.9877, latitude: 40.7302 },
      permissions: ['geolocation'],
      userAgent:   randomUA(),
      viewport:    { width: 1366 + Math.floor(Math.random() * 200), height: 768 + Math.floor(Math.random() * 100) },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (proxy) ctxOpts.proxy = proxy;
    const context = await browser.newContext(ctxOpts);
    await context.addCookies([{
      name: 'x-amz-postal-code', value: '10003', domain: '.' + domain, path: '/',
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

  try {
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
      saveCSV(Array.from(allASINs.values()), filename, jobFolder);

      // Short cooldown between batches
      if (i + CONCURRENCY < cleanKeywords.length && !job.stopRequested) await sleep(BATCH_DELAY);
    }
  } catch (err) {
    jobLog(jobId, `⚠️ Fatal: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  const final = Array.from(allASINs.values());
  const saveResult = saveCSV(final, filename, jobFolder);
  jobLog(jobId, `✅ Done — ${saveResult.validCount} unique ASINs saved to ${jobFolder}\\${filename}`);
  if (saveResult.needsReviewCount) {
    jobLog(jobId, `⚠️ ${saveResult.needsReviewCount} row(s) failed validation — see ${filename.replace(/\.csv$/i, '')}.needs_review.csv`);
  }

  if (job) job.progress.done = true;

  // Blocking response — returns when job is complete, same as before
  // jobId is included so background.js can use it for future /stop calls
  res.json({ success: true, jobId, count: final.length, file: filename, folder: jobFolder, results: final });
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

// ── CSV writer ─────────────────────────────────────────────────────────────
// folder defaults to SAVE_FOLDER — pass jobFolder to isolate per job
// Rows that fail validateAsinRecord() are quarantined into a sibling
// "*.needs_review.csv" file instead of being dropped or mixed into the main
// output, so nothing bad is silently written and nothing is silently lost.
function saveCSV(rows, filename, folder) {
  const dir = folder || SAVE_FOLDER;
  fs.mkdirSync(dir, { recursive: true }); // no-op if already exists
  const BOM = '﻿';

  const valid = [], needsReview = [];
  for (const r of rows) {
    const v = validateAsinRecord(r);
    if (v.valid) valid.push(r);
    else needsReview.push({ ...r, _reviewReason: v.reason });
  }

  const body = valid.map(r => `${r.asin},"${(r.brandHint || '').replace(/"/g, '""')}",${r.url}`).join('\r\n');
  fs.writeFileSync(path.join(dir, filename), BOM + 'ASIN,BrandHint,URL\r\n' + body, 'utf-8');

  if (needsReview.length) {
    const reviewName = filename.replace(/\.csv$/i, '') + '.needs_review.csv';
    const reviewBody = needsReview
      .map(r => `${r.asin || ''},"${(r.brandHint || '').replace(/"/g, '""')}",${r.url || ''},"${(r._reviewReason || '').replace(/"/g, '""')}"`)
      .join('\r\n');
    fs.writeFileSync(path.join(dir, reviewName), BOM + 'ASIN,BrandHint,URL,ReviewReason\r\n' + reviewBody, 'utf-8');
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
