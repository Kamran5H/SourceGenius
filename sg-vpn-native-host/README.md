# Source Genius — auto IP switcher

Automatically switches IP while Source Genius runs:

- **Amazon hard-blocks** → connect (or, if already on, rotate to a new IP).
- **Amazon slows / rate-limits** → rotate IP.
- **Amazon clean for ~90s / run stops** → disconnect.

There are **two backends** (choose in the controller's Options page):

### ✅ Proxy (recommended — deterministic, 100% reliable mechanism)
The controller drives `chrome.proxy` directly. connect/rotate/disconnect are
exact API calls — **no clicking, no calibration, nothing to break.** It routes
only `amazon.*` traffic through your proxy; everything else stays direct.
It **replaces** Urban VPN (turn Urban VPN off). You supply proxy endpoints —
a single **rotating residential** endpoint is ideal (it changes IP itself).
Whether Amazon still blocks depends only on proxy IP quality.

**Setup:** load `sg-vpn-controller/` unpacked → right-click it → **Options** →
pick **Proxy**, paste your proxy list (`scheme://user:pass@host:port`, one per
line), Save. Set `SG_VPN_CONTROLLER_ID` in Source Genius (step 2 below), reload.
Test with the Options page buttons, then check `https://api.ipify.org`.
That's it — no native host, no AutoHotkey needed for proxy mode.

### ⚠️ Urban VPN (fallback — fragile)
If you'd rather keep Urban VPN, the controller drives it by **physically
clicking its popup** through the native host below. It must be **calibrated to
your screen once** and can break on any Chrome/Urban VPN UI or DPI change — it
is **best-effort, not 100%**. Everything below covers this backend only.

## Pieces

```
sg-vpn-controller/      ← a small Chrome extension (the "brain": decides connect/rotate/disconnect)
sg-vpn-native-host/     ← this folder (the "hands": native host + AutoHotkey clicker)
  host.mjs              native-messaging host (runs under bun or node)
  urbanvpn_host.bat     launcher Chrome invokes
  UrbanVPN.ahk          AutoHotkey v2 script that clicks Urban VPN
  install.ps1           registers the native host with Chrome
  img/                  ← YOU create these calibration screenshots (see below)
```

## Prerequisites

1. **AutoHotkey v2** — https://www.autohotkey.com/ (v2, not v1). Default install path is auto-detected; otherwise set an env var `SG_AHK_PATH` to your `AutoHotkey64.exe`.
2. **bun** (already installed) or **node** — the `.bat` uses whichever is on PATH.
3. **Urban VPN pinned to the toolbar** so its icon is always visible (Chrome puzzle-piece menu → pin Urban VPN).

## Setup (once)

### 1. Load the controller extension
- `chrome://extensions` → Developer mode ON → **Load unpacked** → select `sg-vpn-controller/`.
- Copy its **ID** (shown on the card).

### 2. Tell the two extensions about each other
- In `sg-vpn-controller/manifest.json`, replace `__SG_MAIN_EXTENSION_ID__` with your **Source Genius** extension ID, then reload the controller.
- In `brand-finder-extension-v7.1.11/background.js`, set `const SG_VPN_CONTROLLER_ID = '...'` to the **controller** ID you copied, then reload Source Genius.

### 3. Register the native host
From this folder, in PowerShell:
```powershell
.\install.ps1 -ControllerId <paste-the-controller-extension-id>
```
This writes `com.sourcegenius.vpn.json` (with an absolute path) and the registry key Chrome reads. Re-run it if you move this folder.

### 4. Calibrate the clicker  ← the important part
Create a folder `sg-vpn-native-host\img\` and capture these PNGs at your **current display scale / browser zoom** (use Snipping Tool, crop tight, no drop-shadow):

| File | What to capture |
|------|-----------------|
| `icon.png` | The Urban VPN **toolbar icon** |
| `connect.png` | The **Connect** button inside the popup |
| `disconnect.png` | The **Disconnect** button inside the popup |
| `location.png` | The **country / location** selector row in the popup |
| `country1.png`…`country4.png` | A few **country entries** to rotate between (optional; without these, "rotate" falls back to disconnect→reconnect) |

Test each action manually (open a terminal here):
```powershell
& "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe" .\UrbanVPN.ahk connect
& "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe" .\UrbanVPN.ahk rotate
& "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe" .\UrbanVPN.ahk disconnect
```
If a click misses: re-capture the image, or raise `TOL` (tolerance) near the top of `UrbanVPN.ahk`. A `vpn-clicker.log` is written here for debugging.

## Tuning

- **Cool-down before auto-disconnect** and **rotate rate-limit**: `CLEAN_DISCONNECT_MS` / `ROTATE_DEBOUNCE_MS` in `sg-vpn-controller/background.js`.
- **What counts as "blocked"**: driven by Source Genius's existing wall-breaker (8 consecutive Amazon blocks) — nothing to configure.

## Known limitations (read this)

- **Fragile by nature.** It clicks a popup by image match. A Chrome update, an Urban VPN UI change, a different monitor/scale, or moving the mouse mid-click can break it. Re-calibrate the images when that happens.
- **Windows + Chrome only.** For Edit see the note printed by `install.ps1`.
- **The popup steals a moment of focus** each time it fires. Don't be typing elsewhere when a block triggers a click.
- Urban VPN **free** doesn't let you pick a specific egress IP; "rotate" just changes country, which usually changes IP but isn't guaranteed.
- If a run's blocks are severe, a rotating **residential proxy via `chrome.proxy`** is far more reliable than clicking a VPN — that's the fallback if this proves too flaky.

## Uninstall

```powershell
Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sourcegenius.vpn'
```
Set `SG_VPN_CONTROLLER_ID = ''` in Source Genius and remove both extensions.
