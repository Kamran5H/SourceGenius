// SG VPN Controller — service worker.
//
// Receives events from the main Source Genius extension:
//   { sgVpnEvent: 'block' | 'slow' | 'clean' | 'idle' }
// and switches IP automatically. Two backends:
//
//   backend 'proxy'   (DEFAULT, deterministic, recommended) — routes Amazon
//                     traffic through your proxy list via chrome.proxy. connect
//                     = apply proxy, rotate = next proxy, disconnect = go direct.
//                     100% reliable mechanism; block-avoidance = proxy IP quality.
//
//   backend 'urbanvpn' (fallback) — clicks Urban VPN through the native host.
//                     Fragile (image clicks), needs calibration. See README.
//
// Event → action:
//   block → connect (or rotate if already on — current IP is walled)
//   slow  → rotate (only if already on)
//   clean → after CLEAN_DISCONNECT_MS with no blocks, disconnect
//   idle  → disconnect now (run finished)
//
// Configure via the options page (right-click extension → Options), or by
// setting chrome.storage.local: sgBackend, sgProxies, sgProxyEnabled.

const HOST                = 'com.sourcegenius.vpn';
const CLEAN_DISCONNECT_MS = 90_000;
const ROTATE_DEBOUNCE_MS  = 30_000;
const DISCONNECT_ALARM    = 'sg-vpn-disconnect';

// Amazon marketplaces to route through the proxy (everything else stays DIRECT
// so search engines / the team DB are fast and unproxied).
const AMAZON_DOMAINS = [
  'amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.de', 'amazon.fr',
  'amazon.co.jp', 'amazon.com.au', 'amazon.es', 'amazon.it', 'amazon.nl',
];

// Seed proxy list (used only when you haven't saved your own in Options).
// Curated from the free public list you supplied: elite/anonymous HTTP only,
// US-first, no transparent (they leak your real IP) and no SOCKS.
// ⚠️ FREE PUBLIC PROXIES DIE WITHIN MINUTES and Amazon blocks datacenter IPs —
// most of these are probably already dead. Replace via Options with a fresh
// batch when you run. The controller auto-rotates past dead ones on each block.
const DEFAULT_PROXIES = [
  { scheme: 'http', host: '159.65.245.255', port: 80,   label: 'US-1' },
  { scheme: 'http', host: '159.223.201.213', port: 3128, label: 'US-2' },
  { scheme: 'http', host: '208.82.61.64',   port: 3128, label: 'US-3' },
  { scheme: 'http', host: '150.241.116.167', port: 443,  label: 'US-4' },
  { scheme: 'http', host: '34.43.46.91',     port: 80,   label: 'US-5' },
  { scheme: 'http', host: '49.51.228.35',    port: 81,   label: 'US-6' },
  { scheme: 'http', host: '34.44.49.215',    port: 80,   label: 'US-7' },
  { scheme: 'http', host: '24.63.14.91',     port: 8080, label: 'US-8' },
  { scheme: 'http', host: '72.56.238.99',    port: 9090, label: 'US-9' },
  { scheme: 'http', host: '70.35.196.194',   port: 8087, label: 'US-10' },
  { scheme: 'http', host: '174.137.134.182', port: 2999, label: 'US-11' },
  { scheme: 'http', host: '174.138.119.88',  port: 80,   label: 'US-12' },
  { scheme: 'http', host: '71.198.208.169',  port: 443,  label: 'US-13' },
  { scheme: 'http', host: '52.34.243.150',   port: 8080, label: 'US-14' },
  { scheme: 'http', host: '152.67.154.35',   port: 3128, label: 'GB-1' },
  { scheme: 'http', host: '172.104.151.103', port: 3128, label: 'DE-1' },
  { scheme: 'http', host: '81.168.119.85',   port: 443,  label: 'GB-2' },
  { scheme: 'http', host: '45.95.232.35',    port: 3128, label: 'CH-1' },
  { scheme: 'http', host: '62.60.149.161',   port: 3128, label: 'SE-1' },
];

// ── config + state (storage.local persists across SW eviction) ───────────
async function cfg() {
  const s = await chrome.storage.local.get(['sgBackend', 'sgProxies', 'sgProxyEnabled', 'sgProxyIdx', 'vpnOn', 'lastRotate']);
  return {
    backend:  s.sgBackend || 'proxy',
    proxies:  (Array.isArray(s.sgProxies) && s.sgProxies.length) ? s.sgProxies : DEFAULT_PROXIES,
    enabled:  s.sgProxyEnabled !== false,       // default enabled
    idx:      s.sgProxyIdx | 0,
    vpnOn:    !!s.vpnOn,
    lastRotate: s.lastRotate || 0,
  };
}
const save = patch => chrome.storage.local.set(patch);

// ── proxy backend ─────────────────────────────────────────────────────────
function proxyDirective(p) {
  const host = `${p.host}:${p.port}`;
  const scheme = (p.scheme || 'http').toLowerCase();
  // "; DIRECT" fallback: if the proxy is unreachable (dead free proxy), Chrome
  // uses a direct connection instead of hard-failing every Amazon request. Worst
  // case the tool behaves like no-proxy (your real IP) rather than breaking.
  if (scheme === 'socks5') return `SOCKS5 ${host}; DIRECT`;
  if (scheme === 'socks4' || scheme === 'socks') return `SOCKS ${host}; DIRECT`;
  if (scheme === 'https') return `HTTPS ${host}; DIRECT`;
  return `PROXY ${host}; DIRECT`; // http
}
function buildPac(p) {
  const directive = proxyDirective(p);
  const list = JSON.stringify(AMAZON_DOMAINS);
  // eslint-disable-next-line no-useless-concat
  return `function FindProxyForURL(url, host){` +
    `var d=${list};` +
    `for(var i=0;i<d.length;i++){if(host===d[i]||host==="www."+d[i]||shExpMatch(host,"*."+d[i]))return ${JSON.stringify(directive)};}` +
    `return "DIRECT";}`;
}
async function applyProxy(i) {
  const c = await cfg();
  if (!c.proxies.length) { console.warn('[vpn] no proxies configured'); return false; }
  const idx = ((i % c.proxies.length) + c.proxies.length) % c.proxies.length;
  const p = c.proxies[idx];
  await save({ sgProxyIdx: idx, _curProxy: p });
  await chrome.proxy.settings.set({
    scope: 'regular',
    value: { mode: 'pac_script', pacScript: { data: buildPac(p), mandatory: true } },
  });
  console.log(`[vpn] proxy → ${p.label || (p.host + ':' + p.port)} (#${idx})`);
  return true;
}
async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
  console.log('[vpn] proxy cleared (DIRECT)');
}

// Proxy auth: chrome.proxy can't carry credentials, so answer the proxy's auth
// challenge here with the current proxy's user/pass (HTTP/HTTPS proxies only —
// Chrome doesn't support authenticated SOCKS from extensions).
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback(); return; }
    chrome.storage.local.get('_curProxy').then(({ _curProxy }) => {
      if (_curProxy && _curProxy.username) callback({ authCredentials: { username: _curProxy.username, password: _curProxy.password || '' } });
      else callback();
    });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

// ── native-host (Urban VPN clicker) backend ─────────────────────────────
function callHost(action) {
  return new Promise(resolve => {
    let port;
    try { port = chrome.runtime.connectNative(HOST); }
    catch (e) { console.warn('[vpn] connectNative threw:', e?.message); return resolve(false); }
    let done = false;
    const finish = ok => { if (!done) { done = true; try { port.disconnect(); } catch (_) {} resolve(ok); } };
    port.onMessage.addListener(m => { console.log('[vpn] host reply:', m); finish(!!(m && m.ok)); });
    port.onDisconnect.addListener(() => { const e = chrome.runtime.lastError; if (e) console.warn('[vpn] host:', e.message); finish(false); });
    try { port.postMessage({ action }); } catch (e) { console.warn('[vpn] postMessage:', e?.message); finish(false); }
  });
}

// ── backend-agnostic actions ─────────────────────────────────────────────
async function connect() {
  const c = await cfg();
  if (c.vpnOn) return;
  await save({ vpnOn: true });
  console.log('[vpn] connect');
  if (c.backend === 'urbanvpn') await callHost('connect');
  else await applyProxy(c.idx);
}
async function disconnect() {
  await chrome.alarms.clear(DISCONNECT_ALARM);
  const c = await cfg();
  if (!c.vpnOn) return;
  await save({ vpnOn: false });
  console.log('[vpn] disconnect');
  if (c.backend === 'urbanvpn') await callHost('disconnect');
  else await clearProxy();
}
async function rotate() {
  const c = await cfg();
  if (Date.now() - c.lastRotate < ROTATE_DEBOUNCE_MS) return;
  await save({ lastRotate: Date.now() });
  if (!c.vpnOn) { await connect(); return; }
  console.log('[vpn] rotate');
  if (c.backend === 'urbanvpn') await callHost('rotate');
  else await applyProxy(c.idx + 1);
}
async function armDisconnect() {
  const c = await cfg();
  if (!c.vpnOn) return;
  await chrome.alarms.create(DISCONNECT_ALARM, { delayInMinutes: CLEAN_DISCONNECT_MS / 60000 });
}

async function onEvent(kind) {
  const c = await cfg();
  if (!c.enabled) return; // controller globally disabled
  switch (kind) {
    case 'block':
      await chrome.alarms.clear(DISCONNECT_ALARM);
      if (c.vpnOn) await rotate(); else await connect();
      break;
    case 'slow':
      if (c.vpnOn) { await chrome.alarms.clear(DISCONNECT_ALARM); await rotate(); }
      break;
    case 'clean':
      await armDisconnect();
      break;
    case 'idle':
      await disconnect();
      break;
  }
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === DISCONNECT_ALARM) disconnect(); });

// events from the main Source Genius extension
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (msg && typeof msg.sgVpnEvent === 'string') {
    onEvent(msg.sgVpnEvent).then(async () => { const c = await cfg(); try { reply({ ok: true, vpnOn: c.vpnOn, backend: c.backend }); } catch (_) {} });
    return true;
  }
});

// options-page / self-test messages
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.test) { onEvent(msg.test).then(async () => { const c = await cfg(); reply?.({ ok: true, vpnOn: c.vpnOn, backend: c.backend, idx: c.idx }); }); return true; }
  if (msg.sgVpnEvent) { onEvent(msg.sgVpnEvent).then(() => reply?.({ ok: true })); return true; }
});

// Safety: if the profile is left on a proxy from a previous session but nothing
// re-enabled it, clear on startup so browsing isn't stuck behind a dead proxy.
chrome.runtime.onStartup.addListener(async () => {
  const c = await cfg();
  if (!c.vpnOn) await clearProxy();
});
