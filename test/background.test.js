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
  extractFunction(src, '_parseAmazonHtml'),
  extractFunction(src, 'extractAsin'),
  extractFunction(src, 'validateResult'),
  'module.exports = { _parseAmazonHtml, pickSearchCandidate, brandDomainResemblance, domainMatchesBrand, validateResult };',
].join('\n\n');

const {
  _parseAmazonHtml,
  pickSearchCandidate,
  brandDomainResemblance,
  domainMatchesBrand,
  validateResult,
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
