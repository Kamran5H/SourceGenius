'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractFunction, compileModule } = require('./_extract');

const OPTIONS_PATH = path.join(__dirname, '..', 'sg-vpn-controller', 'options.js');
const src = fs.readFileSync(OPTIONS_PATH, 'utf-8');

// options.js calls document.* at module scope, so it can't be require()'d
// directly outside a browser/extension page context.
const assembled = [
  extractFunction(src, 'parseProxyLine'),
  'module.exports = { parseProxyLine };',
].join('\n\n');

const { parseProxyLine } = compileModule(assembled, OPTIONS_PATH);

test('parseProxyLine: full scheme + auth + host + port', () => {
  const p = parseProxyLine('http://user:pass@1.2.3.4:8080');
  assert.deepEqual(p, {
    scheme: 'http',
    host: '1.2.3.4',
    port: 8080,
    username: 'user',
    password: 'pass',
    label: 'http://1.2.3.4:8080',
  });
});

test('parseProxyLine: bare host:port defaults to http with no auth', () => {
  const p = parseProxyLine('1.2.3.4:8080');
  assert.equal(p.scheme, 'http');
  assert.equal(p.host, '1.2.3.4');
  assert.equal(p.port, 8080);
  assert.equal(p.username, '');
});

test('parseProxyLine: comment lines and blank lines return null', () => {
  assert.equal(parseProxyLine('# a comment'), null);
  assert.equal(parseProxyLine('   '), null);
  assert.equal(parseProxyLine(''), null);
});

test('parseProxyLine: missing port returns null', () => {
  assert.equal(parseProxyLine('1.2.3.4'), null);
});

test('parseProxyLine: unparseable garbage returns null instead of throwing', () => {
  assert.equal(parseProxyLine('not a valid proxy string'), null);
});
