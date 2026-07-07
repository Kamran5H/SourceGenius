// Source Genius — Urban VPN native-messaging host.
// Chrome launches this (via urbanvpn_host.bat) and speaks the native-messaging
// protocol over stdio: each message is a 4-byte little-endian length prefix
// followed by that many bytes of UTF-8 JSON. We read {action:"connect"|
// "disconnect"|"rotate"} and run the AutoHotkey clicker with that action.
//
// CRITICAL: never write anything but protocol bytes to stdout — a stray
// console.log corrupts the stream and Chrome drops the port. All logs go to
// stderr (visible only if you launch the .bat manually for debugging).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Where AutoHotkey v2 lives. Override with the SG_AHK_PATH env var if yours
// is elsewhere. These are the default v2 install locations on Windows.
const AHK = [
  process.env.SG_AHK_PATH,
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe',
  'C:\\Program Files\\AutoHotkey\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe',
].filter(Boolean).find(p => { try { return existsSync(p); } catch { return false; } });

const CLICKER = fileURLToPath(new URL('./UrbanVPN.ahk', import.meta.url));

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  process.stdout.write(len);
  process.stdout.write(body);
}

function runClicker(action) {
  if (!AHK) { console.error('[host] AutoHotkey not found'); send({ ok: false, error: 'AutoHotkey v2 not found — set SG_AHK_PATH' }); return; }
  console.error(`[host] ${action} -> ${AHK} ${CLICKER}`);
  const child = spawn(AHK, [CLICKER, action], { windowsHide: true, stdio: 'ignore' });
  child.on('exit', code => send({ ok: code === 0, action, code }));
  child.on('error', e => { console.error('[host]', e.message); send({ ok: false, error: e.message }); });
}

// ── native-messaging read loop ──────────────────────────────────────────
let buf = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    let msg = null;
    try { msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')); } catch (_) {}
    buf = buf.subarray(4 + len);
    if (msg && typeof msg.action === 'string') runClicker(msg.action);
    else send({ ok: false, error: 'expected {action}' });
  }
});
process.stdin.on('end', () => process.exit(0));
