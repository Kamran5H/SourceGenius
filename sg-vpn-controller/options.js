// SG VPN Controller — options page logic.
// Parses the proxy list, saves config to chrome.storage.local, and offers
// manual test buttons that fire the same events the main extension sends.

function parseProxyLine(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  // Accept "scheme://[user:pass@]host:port" or bare "host:port" (defaults http).
  let str = /:\/\//.test(s) ? s : 'http://' + s;
  let u;
  try { u = new URL(str); } catch (_) { return null; }
  if (!u.hostname || !u.port) return null;
  const scheme = (u.protocol || 'http:').replace(':', '').toLowerCase();
  return {
    scheme,
    host: u.hostname,
    port: Number(u.port),
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    label: `${scheme}://${u.hostname}:${u.port}`,
  };
}

function proxyToLine(p) {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

async function load() {
  const s = await chrome.storage.local.get(['sgBackend', 'sgProxies', 'sgProxyEnabled']);
  document.querySelector(`input[name="backend"][value="${s.sgBackend || 'proxy'}"]`).checked = true;
  document.getElementById('enabled').checked = s.sgProxyEnabled !== false;
  const proxies = Array.isArray(s.sgProxies) ? s.sgProxies : [];
  document.getElementById('proxies').value = proxies.map(proxyToLine).join('\n');
}

async function save() {
  const backend = document.querySelector('input[name="backend"]:checked').value;
  const enabled = document.getElementById('enabled').checked;
  const lines = document.getElementById('proxies').value.split('\n');
  const proxies = lines.map(parseProxyLine).filter(Boolean);
  const bad = lines.filter(l => l.trim() && !l.trim().startsWith('#')).length - proxies.length;
  await chrome.storage.local.set({ sgBackend: backend, sgProxyEnabled: enabled, sgProxies: proxies, sgProxyIdx: 0 });
  const st = document.getElementById('status');
  st.textContent = `Saved — ${proxies.length} proxy(ies)${bad > 0 ? `, ${bad} line(s) ignored` : ''}.`;
  setTimeout(() => (st.textContent = ''), 4000);
}

document.getElementById('save').addEventListener('click', save);
document.querySelectorAll('button[data-ev]').forEach(btn => {
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ test: btn.dataset.ev }, resp => {
      const st = document.getElementById('status');
      st.textContent = resp ? `${btn.dataset.ev} → vpnOn=${resp.vpnOn} (${resp.backend})` : (chrome.runtime.lastError?.message || 'no response');
      setTimeout(() => (st.textContent = ''), 4000);
    });
  });
});

load();
