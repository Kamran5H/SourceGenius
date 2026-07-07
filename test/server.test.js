'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractFunction, extractDeclaration, compileModule } = require('./_extract');

const SERVER_PATH = path.join(__dirname, '..', 'amazon-playwright-scraper', 'server.js');
const src = fs.readFileSync(SERVER_PATH, 'utf-8');

// server.js calls app.listen() at module scope, so it can't be require()'d
// directly in a test (it would bind a real port). validateAsinRecord has no
// side effects of its own, so it's extracted the same way as background.js's
// pure functions.
const assembled = [
  extractDeclaration(src, 'ASIN_RE', /;$/),
  extractFunction(src, 'validateAsinRecord'),
  'module.exports = { validateAsinRecord };',
].join('\n\n');

const { validateAsinRecord } = compileModule(assembled, SERVER_PATH);

test('validateAsinRecord: a well-formed row passes', () => {
  const r = { asin: 'B0C1D2E3F4', brandHint: 'Acme', url: 'https://www.amazon.com/dp/B0C1D2E3F4' };
  assert.deepEqual(validateAsinRecord(r), { valid: true });
});

test('validateAsinRecord: rejects a malformed ASIN', () => {
  const r = { asin: 'not-an-asin', brandHint: 'Acme', url: 'https://www.amazon.com/dp/not-an-asin' };
  const v = validateAsinRecord(r);
  assert.equal(v.valid, false);
  assert.match(v.reason, /invalid ASIN/);
});

test('validateAsinRecord: rejects a malformed URL', () => {
  const r = { asin: 'B0C1D2E3F4', brandHint: 'Acme', url: 'not a url' };
  const v = validateAsinRecord(r);
  assert.equal(v.valid, false);
  assert.match(v.reason, /malformed URL/);
});

test('validateAsinRecord: missing ASIN and URL both get reported', () => {
  const v = validateAsinRecord({ brandHint: 'Acme' });
  assert.equal(v.valid, false);
  assert.match(v.reason, /invalid ASIN/);
  assert.match(v.reason, /malformed URL/);
});
