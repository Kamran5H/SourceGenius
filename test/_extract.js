'use strict';
// Pulls specific functions/consts out of source files that can't be
// require()'d directly (background.js and options.js touch chrome.* /
// document.* at module scope; server.js calls app.listen() at module scope).
// This tests the ACTUAL production source verbatim — no reimplementation —
// so a real edit to the extracted code is what the tests exercise.
//
// Extraction is boundary-based rather than full-bracket-depth counting:
// several of the extracted functions contain regex literals with unbalanced
// bracket characters inside character classes (e.g. /[^}]/), which would
// break naive brace-counting. Instead this relies on this codebase's
// consistent formatting convention: every top-level function/const/let
// declaration closes on its own line with no leading whitespace.

function extractFunction(src, name) {
  const startRe = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = startRe.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const tail = src.slice(m.index);
  const endRe = /\n\}(?:\r?\n|$)/;
  const em = endRe.exec(tail);
  if (!em) throw new Error(`extractFunction: end of "${name}" not found`);
  return tail.slice(0, em.index + 2); // include the trailing "\n}"
}

// endLineRe matches the line the declaration ends on (e.g. /^\]\);$/ for a
// `new Set([...])`, or /;$/ for a single-line assignment).
function extractDeclaration(src, name, endLineRe) {
  const startRe = new RegExp(`^(?:const|let)\\s+${name}\\b`, 'm');
  const m = startRe.exec(src);
  if (!m) throw new Error(`extractDeclaration: "${name}" not found`);
  const lineStart = src.lastIndexOf('\n', m.index) + 1;
  const rest = src.slice(lineStart);
  // AUDIT-FIX: split on \r?\n and strip trailing \r — a git checkout with CRLF
  // line endings (Windows autocrlf) left every line ending in \r, so the
  // anchored endLineRe (e.g. /^\]\);$/) never matched and every extraction
  // "failed" even though the source was fine.
  const lines = rest.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    out.push(line);
    if (endLineRe.test(line)) return out.join('\n');
  }
  throw new Error(`extractDeclaration: end of "${name}" not found`);
}

// Compiles an assembled source string into its own module and returns
// module.exports — the standard Node technique for running a source string
// as if it were a real file, without touching the actual filesystem.
function compileModule(assembledSrc, fakeFilename) {
  const Module = require('module');
  const m = new Module(fakeFilename);
  m.filename = fakeFilename;
  m._compile(assembledSrc, fakeFilename);
  return m.exports;
}

module.exports = { extractFunction, extractDeclaration, compileModule };
