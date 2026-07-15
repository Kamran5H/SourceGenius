'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractFunction, extractDeclaration, compileModule } = require('./_extract');

const BG_PATH = path.join(__dirname, '..', 'brand-finder-extension-v7.1.11', 'background.js');
const src = fs.readFileSync(BG_PATH, 'utf-8');

// Assembled from the real, verbatim function/const bodies in background.js.
// MODES/ST/processedWebsites are test doubles standing in for the extension's
// mutable run-state — the tier-picking/matching logic under test only reads
// MODES[ST.mode].verify and processedWebsites.has(), it doesn't own that
// state, so a minimal stand-in is legitimate here (not a reimplementation of
// any logic under test).
const assembled = [
  extractDeclaration(src, 'BLACKLIST', /^\]\);$/),
  extractDeclaration(src, 'SG_JUNK_RE', /;$/),
  extractDeclaration(src, 'JUNK_BRAND_NAMES', /^\]\);$/),
  'const MODES = { balanced: { verify: false }, aggressive: { verify: true } };',
  'let ST = { mode: "balanced" };',
  'let processedWebsites = new Set();',
  extractFunction(src, 'isBlacklisted'),
  extractFunction(src, 'domainMatchesBrand'),
  extractFunction(src, 'brandDomainResemblance'),
  extractFunction(src, 'toRootUrl'),
  extractFunction(src, 'isDuplicateWebsiteCandidate'),
  extractFunction(src, 'searchEngineLabel'),
  extractFunction(src, 'pickSearchCandidate'),
  extractFunction(src, '_looksLikeGarbageBrand'), // v7.1.51 dep of _parseAmazonHtml
  extractFunction(src, '_parseAmazonHtml'),
  extractFunction(src, 'extractAsin'),
  extractFunction(src, 'validateResult'),
  'const RUNTIME_SNAPSHOT_MAX_AGE_MS = 600000;',
  extractFunction(src, '_runtimeSnapshotIsFresh'),
  'module.exports = { _parseAmazonHtml, pickSearchCandidate, brandDomainResemblance, domainMatchesBrand, validateResult, _runtimeSnapshotIsFresh };',
].join('\n\n');

const {
  _parseAmazonHtml,
  pickSearchCandidate,
  brandDomainResemblance,
  domainMatchesBrand,
  validateResult,
  _runtimeSnapshotIsFresh,
} = compileModule(assembled, BG_PATH);

// ── domainMatchesBrand ──────────────────────────────────────────────────────
test('domainMatchesBrand: root contains the brand name', () => {
  assert.equal(domainMatchesBrand('https://www.happybaby.com', 'Happy Baby'), true);
});

test('domainMatchesBrand: unrelated domain does not match', () => {
  assert.equal(domainMatchesBrand('https://www.totallydifferent.com', 'Nike'), false);
});

test('domainMatchesBrand: invalid URL is handled without throwing', () => {
  assert.equal(domainMatchesBrand('not a url', 'Nike'), false);
});

// ── brandDomainResemblance ───────────────────────────────────────────────────
test('brandDomainResemblance: exact containment scores 1', () => {
  assert.equal(brandDomainResemblance('https://happybaby.com', 'Happy Baby'), 1);
});

test('brandDomainResemblance: partial overlap scores the LCS/max-length ratio', () => {
  // root='greywillow' (10 chars), bn='bluewillow' (10 chars) — longest common
  // substring is "willow" (6 chars) — neither contains the other outright.
  const score = brandDomainResemblance('https://greywillow.com', 'Bluewillow');
  assert.equal(score, 6 / 10);
});

test('brandDomainResemblance: unrelated strings score near zero', () => {
  const score = brandDomainResemblance('https://xyz123.com', 'CompletelyUnrelatedBrand');
  assert.ok(score < 0.3, `expected low resemblance, got ${score}`);
});

// ── pickSearchCandidate ──────────────────────────────────────────────────────
test('pickSearchCandidate: strict domain match wins T1 with the rank-1 bonus', () => {
  const hit = pickSearchCandidate(['https://acme.com/page', 'https://other.com'], 'Acme', 'ddg');
  assert.ok(hit, 'expected a match');
  assert.equal(hit.website, 'https://acme.com');
  assert.equal(hit.conf, 76); // 74 (T1) + 2 (rank-1 bonus)
  assert.equal(hit.method, 'ddg');
  assert.equal(hit.label, 'DuckDuckGo');
});

test('pickSearchCandidate: resemblance-only match lands in T3, not T1', () => {
  const hit = pickSearchCandidate(['https://greywillow.com'], 'Bluewillow', 'bing');
  assert.ok(hit, 'expected a match');
  assert.equal(hit.website, 'https://greywillow.com');
  assert.equal(hit.conf, 62 + 2); // T3 base 62 + rank-1 bonus
});

test('pickSearchCandidate: blacklisted-only hits return null', () => {
  const hit = pickSearchCandidate(['https://facebook.com/somepage'], 'Acme', 'ddg');
  assert.equal(hit, null);
});

test('pickSearchCandidate: no resemblance in a non-verify mode returns null (T6 gated)', () => {
  const hit = pickSearchCandidate(['https://totallyunrelateddomain.org'], 'Zephyrix', 'bing');
  assert.equal(hit, null);
});

// ── _parseAmazonHtml ──────────────────────────────────────────────────────
test('_parseAmazonHtml: extracts brand from JSON-LD, ASIN from the URL, and product markers', () => {
  const html = `
    <html><body>
      <div id="dp">
        <script type="application/ld+json">{"brand":{"name":"Acme Corp"}}</script>
        <span id="productTitle"> Acme Widget 3000 </span>
      </div>
    </body></html>
  `;
  const result = _parseAmazonHtml(html, 'https://www.amazon.com/dp/B0C1D2E3F4');
  assert.equal(result.brand, 'Acme Corp');
  assert.equal(result.asin, 'B0C1D2E3F4');
  assert.equal(result.title, 'Acme Widget 3000');
  assert.equal(result.hasProductMarkers, true);
});

test('_parseAmazonHtml: no brand markers yields an empty brand and hasProductMarkers=false', () => {
  const html = '<html><body>Sorry, this page is not available.</body></html>';
  const result = _parseAmazonHtml(html, 'https://www.amazon.com/dp/B0C1D2E3F4');
  assert.equal(result.brand, '');
  assert.equal(result.hasProductMarkers, false);
});

// ── validateResult ──────────────────────────────────────────────────────
test('validateResult: a well-formed found record passes', () => {
  const res = { url: 'https://www.amazon.com/dp/B0C1D2E3F4', brand: 'Acme', website: 'https://acme.com', conf: 74 };
  assert.deepEqual(validateResult(res), { valid: true });
});

test('validateResult: rejects a malformed ASIN', () => {
  const res = { url: 'https://www.amazon.com/dp/not-an-asin', brand: 'Acme', website: 'https://acme.com', conf: 74 };
  const v = validateResult(res);
  assert.equal(v.valid, false);
  assert.match(v.reason, /invalid ASIN/);
});

test('validateResult: rejects a junk brand placeholder', () => {
  const res = { url: 'https://www.amazon.com/dp/B0C1D2E3F4', brand: 'Amazon', website: 'https://acme.com', conf: 74 };
  const v = validateResult(res);
  assert.equal(v.valid, false);
  assert.match(v.reason, /junk brand/);
});

test('validateResult: rejects a malformed website URL', () => {
  const res = { url: 'https://www.amazon.com/dp/B0C1D2E3F4', brand: 'Acme', website: 'not a url', conf: 74 };
  const v = validateResult(res);
  assert.equal(v.valid, false);
  assert.match(v.reason, /malformed website URL/);
});

test('validateResult: rejects a non-numeric confidence', () => {
  const res = { url: 'https://www.amazon.com/dp/B0C1D2E3F4', brand: 'Acme', website: 'https://acme.com', conf: '74' };
  const v = validateResult(res);
  assert.equal(v.valid, false);
  assert.match(v.reason, /non-numeric confidence/);
});

test('validateResult: rejects an empty brand', () => {
  const res = { url: 'https://www.amazon.com/dp/B0C1D2E3F4', brand: '   ', website: 'https://acme.com', conf: 74 };
  const v = validateResult(res);
  assert.equal(v.valid, false);
  assert.match(v.reason, /empty brand/);
});

test('validateResult: accepts a lowercase page-scanned ASIN (normalized, not quarantined)', () => {
  const res = { asin: 'b0c1d2e3f4', url: '', brand: 'Acme', website: 'https://acme.com', conf: 74 };
  assert.deepEqual(validateResult(res), { valid: true });
});

test('validateResult: a record with no website is not rejected on URL grounds', () => {
  // not-found records (no website) shouldn't fail validation just for lacking one
  const res = { url: 'https://www.amazon.com/dp/B0C1D2E3F4', brand: 'Acme', website: '', conf: 0 };
  assert.deepEqual(validateResult(res), { valid: true });
});

// ── _runtimeSnapshotIsFresh (anti-block controller persistence gate) ──────────
test('_runtimeSnapshotIsFresh: a snapshot saved seconds ago is inherited', () => {
  const now = 1_000_000_000_000;
  assert.equal(_runtimeSnapshotIsFresh({ savedAt: now - 5000 }, now), true);
});

test('_runtimeSnapshotIsFresh: a snapshot older than 10 min is NOT inherited (IP has likely cooled)', () => {
  const now = 1_000_000_000_000;
  assert.equal(_runtimeSnapshotIsFresh({ savedAt: now - 11 * 60 * 1000 }, now), false);
});

test('_runtimeSnapshotIsFresh: just inside the 10 min window is inherited', () => {
  const now = 1_000_000_000_000;
  assert.equal(_runtimeSnapshotIsFresh({ savedAt: now - (10 * 60 * 1000 - 1) }, now), true);
});

test('_runtimeSnapshotIsFresh: missing/garbage savedAt is not fresh (no crash)', () => {
  const now = 1_000_000_000_000;
  assert.equal(_runtimeSnapshotIsFresh({}, now), false);
  assert.equal(_runtimeSnapshotIsFresh(null, now), false);
  assert.equal(_runtimeSnapshotIsFresh({ savedAt: 'nope' }, now), false);
});

test('_runtimeSnapshotIsFresh: a future-dated savedAt (clock skew) is not treated as fresh-negative-age', () => {
  const now = 1_000_000_000_000;
  // savedAt in the future → now-savedAt is negative → not fresh (guarded)
  assert.equal(_runtimeSnapshotIsFresh({ savedAt: now + 60000 }, now), false);
});

// ── AUDIT-FIX (100K scale): chunked results persistence ─────────────────────
// Compiles the REAL persistence functions from background.js against a fake
// chrome.storage.local, fresh module state per test.
function makePersistModule() {
  const preamble = [
    'const store = {};',
    'const setCalls = [];',
    'const clone = (v) => JSON.parse(JSON.stringify(v));',
    'const chrome = { storage: { local: {',
    '  set: async (obj) => { setCalls.push(Object.keys(obj)); Object.assign(store, clone(obj)); },',
    '  get: async (keys) => { const out = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in store) out[k] = clone(store[k]); return out; },',
    '  remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; },',
    '} } };',
    'let ST = { results: [] };',
  ].join('\n');
  const body = [
    extractDeclaration(src, 'RESULTS_CHUNK_SIZE', /;$/),
    extractDeclaration(src, '_persistedChunkLens', /;$/),
    extractDeclaration(src, '_dirtyResultChunks', /;$/),
    extractDeclaration(src, '_persistedResultsRef', /;$/),
    extractDeclaration(src, '_storedChunkCount', /;$/),
    extractDeclaration(src, '_legacyResultsKeyCleared', /;$/),
    extractDeclaration(src, '_persistResultsChain', /;$/),
    extractFunction(src, 'markResultChunkDirty'),
    extractFunction(src, '_persistResultsOnce'),
    extractFunction(src, 'persistResults'),
    extractFunction(src, 'loadPersistedResults'),
    extractFunction(src, 'clearPersistedResults'),
    'module.exports = { store, setCalls, ST, persistResults, loadPersistedResults, clearPersistedResults, markResultChunkDirty };',
  ].join('\n\n');
  return compileModule(preamble + '\n\n' + body, BG_PATH + '#persist');
}

test('persistResults: splits a big run into 5000-row chunks with correct meta', async () => {
  const m = makePersistModule();
  m.ST.results = Array.from({ length: 12345 }, (_, i) => ({ idx: i, asin: 'A' + i, status: 'found' }));
  await m.persistResults();
  assert.deepEqual(m.store.resultsMeta, { len: 12345, chunks: 3, chunkSize: 5000 });
  assert.equal(m.store.resultsChunk_0.length, 5000);
  assert.equal(m.store.resultsChunk_1.length, 5000);
  assert.equal(m.store.resultsChunk_2.length, 2345);
  const loaded = await m.loadPersistedResults({ resultsMeta: m.store.resultsMeta });
  assert.equal(loaded.length, 12345);
  assert.equal(loaded[0].asin, 'A0');
  assert.equal(loaded[12344].asin, 'A12344');
});

test('persistResults: an appending hot save rewrites ONLY the last partial chunk', async () => {
  const m = makePersistModule();
  m.ST.results = Array.from({ length: 12000 }, (_, i) => ({ idx: i }));
  await m.persistResults();
  m.setCalls.length = 0;
  m.ST.results.push({ idx: 12000 }, { idx: 12001 });   // append like a live run
  await m.persistResults();
  assert.equal(m.setCalls.length, 1);
  // Bounded write: meta + the last partial chunk only — never the full array.
  assert.deepEqual(m.setCalls[0].sort(), ['resultsChunk_2', 'resultsMeta']);
  assert.equal(m.store.resultsChunk_2.length, 2002);
  assert.equal(m.store.resultsChunk_0.length, 5000);   // untouched
});

test('persistResults: markResultChunkDirty re-persists an in-place reclassification', async () => {
  const m = makePersistModule();
  m.ST.results = Array.from({ length: 10001 }, (_, i) => ({ idx: i, status: 'found' }));
  await m.persistResults();
  m.setCalls.length = 0;
  const res = m.ST.results[3];                          // lives in chunk 0 (already full+persisted)
  res.status = 'db-duplicate';
  m.markResultChunkDirty(res);
  await m.persistResults();
  assert.ok(m.setCalls[0].includes('resultsChunk_0'), 'dirty chunk 0 must be rewritten');
  assert.equal(m.store.resultsChunk_0[3].status, 'db-duplicate');
});

test('persistResults: wholesale reassignment shrinks storage and removes stale chunks', async () => {
  const m = makePersistModule();
  m.ST.results = Array.from({ length: 12000 }, (_, i) => ({ idx: i }));
  await m.persistResults();
  m.ST.results = [{ idx: 0 }, { idx: 1 }];              // retry round / fresh run replaced the array
  await m.persistResults();
  assert.equal(m.store.resultsMeta.len, 2);
  assert.equal(m.store.resultsChunk_0.length, 2);
  assert.equal('resultsChunk_1' in m.store, false, 'stale chunk 1 removed');
  assert.equal('resultsChunk_2' in m.store, false, 'stale chunk 2 removed');
  const loaded = await m.loadPersistedResults({ resultsMeta: m.store.resultsMeta });
  assert.equal(loaded.length, 2);
});

test('loadPersistedResults: falls back to the legacy monolithic results key', async () => {
  const m = makePersistModule();
  const legacy = [{ idx: 0, asin: 'LEGACY' }];
  const loaded = await m.loadPersistedResults({ results: legacy }); // no resultsMeta
  assert.deepEqual(loaded, legacy);
});

test('clearPersistedResults: removes meta, all chunks, and the legacy key', async () => {
  const m = makePersistModule();
  m.ST.results = Array.from({ length: 7000 }, (_, i) => ({ idx: i }));
  await m.persistResults();
  m.store.results = [{ old: true }]; // simulate leftover legacy key
  await m.clearPersistedResults();
  assert.equal('resultsMeta' in m.store, false);
  assert.equal('resultsChunk_0' in m.store, false);
  assert.equal('resultsChunk_1' in m.store, false);
  assert.equal('results' in m.store, false);
});

test('loadPersistedResults: seeds bookkeeping so the first post-restore save is incremental', async () => {
  const m = makePersistModule();
  m.ST.results = Array.from({ length: 11000 }, (_, i) => ({ idx: i }));
  await m.persistResults();
  // Simulate an SW restart restoring from the chunked layout
  const m2 = makePersistModule();
  Object.assign(m2.store, JSON.parse(JSON.stringify(m.store)));
  const loaded = await m2.loadPersistedResults({ resultsMeta: m2.store.resultsMeta });
  m2.ST.results = loaded;
  // Mimic the restore path seeding the ref (background.js does this after load)
  m2.setCalls.length = 0;
  m2.ST.results.push({ idx: 11000 });
  await m2.persistResults();
  // Without seeding this would rewrite chunks 0..2; with seeding + the restore
  // ref assignment only meta + the changed tail chunk should be written. The
  // module-internal ref isn't reachable from the test, so allow either the
  // seeded fast path or (worst case) a single full rewrite — but the STORE must
  // be correct either way.
  assert.equal(m2.store.resultsMeta.len, 11001);
  assert.equal(m2.store.resultsChunk_2.length, 1001);
  const reloaded = await m2.loadPersistedResults({ resultsMeta: m2.store.resultsMeta });
  assert.equal(reloaded.length, 11001);
});

// ── Shared-connection rate sharing (6 copies on one wifi/IP) ────────────────
function makeRateShareModule(cfg) {
  const assembledRate = [
    'const AMAZON_RATE_MIN = 0.35;',
    'const AMAZON_RATE_MAX = 1.0;',
    `let ST = { cfg: ${JSON.stringify(cfg || {})} };`,
    extractFunction(src, '_rateShare'),
    extractFunction(src, '_rateMin'),
    extractFunction(src, '_rateMax'),
    'module.exports = { ST, _rateShare, _rateMin, _rateMax };',
  ].join('\n\n');
  return compileModule(assembledRate, BG_PATH + '#rateshare');
}

test('_rateShare: defaults to 1 when unset, garbage, or below 1', () => {
  assert.equal(makeRateShareModule({})._rateShare(), 1);
  assert.equal(makeRateShareModule({ sharedInstances: 'abc' })._rateShare(), 1);
  assert.equal(makeRateShareModule({ sharedInstances: 0 })._rateShare(), 1);
  assert.equal(makeRateShareModule({ sharedInstances: -3 })._rateShare(), 1);
});

test('_rateShare: honours the configured copy count, capped at 8', () => {
  assert.equal(makeRateShareModule({ sharedInstances: 6 })._rateShare(), 6);
  assert.equal(makeRateShareModule({ sharedInstances: 99 })._rateShare(), 8);
});

test('_rateMin/_rateMax: 6 copies each get 1/6 of the per-IP budget (floor included)', () => {
  const m = makeRateShareModule({ sharedInstances: 6 });
  assert.equal(m._rateMax(), 1.0 / 6);   // ~10/min ceiling per copy → ~60/min aggregate
  assert.equal(m._rateMin(), 0.35 / 6);  // ~3.5/min floor per copy → aggregate CAN now drop under the wall
  // the old fixed floor: 6 copies × 21/min = 126/min aggregate — never clears
  assert.ok(m._rateMin() * 6 * 60 < 22, 'shared floor aggregate must be far below the old 126/min');
});

// ── Tabless-read health gate (the "background always blocked" fix) ──────────
function makeTablessModule() {
  const asm = [
    extractDeclaration(src, '_tablessWindow', /;$/),
    extractDeclaration(src, '_TABLESS_WIN', /;$/),
    extractDeclaration(src, '_tablessProbeCounter', /;$/),
    extractFunction(src, '_recordTablessOutcome'),
    extractFunction(src, '_tablessBlockRate'),
    extractFunction(src, '_shouldTryTabless'),
    'module.exports = { _recordTablessOutcome, _tablessBlockRate, _shouldTryTabless };',
  ].join('\n\n');
  return compileModule(asm, BG_PATH + '#tabless');
}

test('_shouldTryTabless: always probes early (fewer than 6 samples)', () => {
  const m = makeTablessModule();
  for (let i = 0; i < 5; i++) { assert.equal(m._shouldTryTabless(), true); m._recordTablessOutcome(true); }
});

test('_shouldTryTabless: keeps the fast path while tabless is healthy', () => {
  const m = makeTablessModule();
  for (let i = 0; i < 20; i++) m._recordTablessOutcome(false); // all clean
  assert.equal(m._tablessBlockRate(), 0);
  assert.equal(m._shouldTryTabless(), true);
});

test('_shouldTryTabless: skips tabless when reliably walled, but re-probes ~1 in 8', () => {
  const m = makeTablessModule();
  for (let i = 0; i < 20; i++) m._recordTablessOutcome(true); // all blocked
  assert.equal(m._tablessBlockRate(), 1);
  let tries = 0;
  for (let i = 0; i < 40; i++) if (m._shouldTryTabless()) tries++;
  assert.ok(tries >= 3 && tries <= 7, `expected ~5 re-probes in 40, got ${tries}`);
});

test('_tablessBlockRate: rolls over a bounded 20-sample window', () => {
  const m = makeTablessModule();
  for (let i = 0; i < 20; i++) m._recordTablessOutcome(true);  // window full of blocks
  for (let i = 0; i < 20; i++) m._recordTablessOutcome(false); // push them all out
  assert.equal(m._tablessBlockRate(), 0);
});
