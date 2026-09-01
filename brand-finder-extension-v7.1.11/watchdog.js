// Source Genius — watchdog.js
// Content script that detects a dead/unresponsive background service worker and
// forces the extension to reload so long runs never wedge silently.
// Runs in the extension's isolated world (not MAIN) so chrome.runtime.* is available.
//
// v7.1.51: content scripts do NOT get chrome.runtime.reload() — the old direct
// call here silently threw and never reloaded anything. Instead we:
//   1. ping the SW; a suspended SW is revived by the message itself and replies ok.
//   2. after MAX_FAILURES real failures, ask the SW to reload via a 'forceReload'
//      message (the SW-side handler drains + persists + chrome.runtime.reload()).
//   3. still attempt a direct reload as a best-effort fallback, in case a future
//      Chrome ever exposes it to content scripts (harmless no-op today).
// The SW-side requestSelfHealReload has a storage-backed 90s cooldown, so even
// though this watchdog runs in every open tab, only one reload actually fires.

(function () {
  'use strict';

  const PING_INTERVAL_MS  = 15000;  // ping every 15 seconds
  const MAX_FAILURES      = 3;      // escalate after 3 consecutive failures (~45s)
  const RELOAD_COOLDOWN   = 60000;  // this tab won't re-request a reload more than once/min

  let failures       = 0;
  let lastReloadReq   = 0;
  let _watchdogTimer  = null;

  function requestReload(reason) {
    const now = Date.now();
    if (now - lastReloadReq < RELOAD_COOLDOWN) return;
    lastReloadReq = now;
    // Primary: ask the SW to reload. The send also wakes a merely-suspended SW.
    try {
      chrome.runtime.sendMessage({ action: 'forceReload', reason }, () => void chrome.runtime.lastError);
    } catch (_) {}
    // Best-effort fallback (not available to content scripts today — never throws the loop).
    try { if (typeof chrome.runtime.reload === 'function') chrome.runtime.reload(); } catch (_) {}
  }

  function ping() {
    try {
      chrome.runtime.sendMessage({ action: 'ping' }, response => {
        if (chrome.runtime.lastError) {
          // No reply — SW is dead, crashed, or wedged.
          failures++;
          if (failures >= MAX_FAILURES) {
            failures = 0;
            requestReload('watchdog: SW unresponsive to ' + MAX_FAILURES + ' pings');
          }
        } else {
          // SW responded — healthy. Reset.
          failures = 0;
        }
      });
    } catch (_) {
      // chrome.runtime itself is gone (extension unloading) — stop pinging.
      if (_watchdogTimer) clearInterval(_watchdogTimer);
    }
  }

  _watchdogTimer = setInterval(ping, PING_INTERVAL_MS);
})();
