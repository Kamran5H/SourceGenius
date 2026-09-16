# ⚡ Source Genius — Autonomous Amazon Brand Website Finder

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Playwright](https://img.shields.io/badge/Playwright-Automated%20Browser-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev/)
[![VPN Controller](https://img.shields.io/badge/Stealth-Auto--Rotating%20VPN%20Proxy-FF4500?style=for-the-badge)](https://github.com/Kamran5H/SourceGenius)
[![Throughput](https://img.shields.io/badge/Throughput-10k%2B%20Brands%20%2F%20Day-10B981?style=for-the-badge)](https://github.com/Kamran5H/SourceGenius)

**Enterprise-grade Amazon wholesale sourcing pipeline combining a Manifest V3 Chrome Extension, anti-bot Playwright brand reader, automated VPN rotator, and multi-engine DNS discovery cascade.**

[Architecture](#-system-architecture) • [Components](#-core-components) • [Search Cascade](#-multi-tier-website-search-cascade) • [Quickstart](#-quick-start) • [License](#-license)

</div>

---

## 🌟 Executive Overview

**Source Genius** is a full-stack automated intelligence platform built for professional Amazon wholesale distributors, private-label sourcers, and e-commerce aggregators. It automates the tedious manual bottleneck of locating direct manufacturer and brand owner websites from raw Amazon ASINs and product listings.

By orchestrating an anti-detection Chrome sidepanel extension, a local headless browser reader, an automated Windows VPN rotator, and a 6-tier search cascade, Source Genius reliably uncovers official brand domains, wholesale inquiry contact endpoints, and direct supplier relationships at scale.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    A[Amazon Product Listing / ASIN Batch] --> B[Chrome Extension: Manifest V3 Sidepanel]
    B -->|Local Loopback API: 127.0.0.1| C[Playwright Brand Reader Daemon]
    
    subgraph AntiDetection [Resilient Ingestion Engine]
        C -->|Anti-Bot Flags Patched| D[Amazon DOM Parser]
        E[VPN Controller Daemon] -->|Auto-Rotate IP on Challenge| D
    end
    
    D -->|Extract Verified Brand Entity| F{Multi-Tier Domain Cascade}
    
    subgraph SearchCascade [Autonomous Verification Cascade]
        F --> G1[Tier 1: Direct DNS & WHOIS Probing]
        F --> G2[Tier 2: DuckDuckGo Zero-Telemetry]
        F --> G3[Tier 3: Yahoo & Mojeek Search Fallback]
        F --> G4[Tier 4: Brave Search API]
    end
    
    SearchCascade -->|Rank & Validate Domain| H[Official Brand Domain Resolved]
    H --> B
    H -->|Cloud Streaming POST| I[Google Sheets / Apps Script Sync]
    H --> J[(Local SQLite Warehouse / CSV Export)]
```

---

## 🧩 Core Components

### 1. `brand-finder-extension-v7.1.11/` — Manifest V3 Chrome Extension
The primary operator console. Running natively in the Chrome Sidepanel, it provides:
- Live status telemetry, real-time extraction queues, and lead tables
- Automated tab listener extracting ASINs directly as you browse Amazon
- Integrated `watchdog.js` to ensure 24/7 background worker stability
- Direct streaming to Google Sheets via `user-livewrite.gs`

### 2. `brand_reader_v2.py` — Playwright Brand Reader Daemon
A local HTTP daemon running on `127.0.0.1:8766`. It controls an anti-bot patched Chromium instance to fetch and parse Amazon product pages using real browser fingerprints, entirely bypassing CAPTCHA blocks.

### 3. `vpn_controller.py` — Automated Network Rotator
A background sentinel that monitors network health. If Amazon serves a soft block or high latency is detected, the VPN controller automatically switches server nodes via local CLI commands (Mullvad, WireGuard, or OpenVPN) and resumes the pipeline transparently.

### 4. `BrandScrapers/` — Data Pipeline Engine
Batch CSV processing tools, Keepa historical sales velocity integration, and Google Sheets reconciliation utilities for enterprise workloads.

---

## 🔍 Multi-Tier Website Search Cascade

Source Genius validates official brand domains through an intelligent fallback cascade:

| Tier | Engine / Protocol | Characteristics |
| :--- | :--- | :--- |
| **Tier 1** | **Direct DNS Probing** | Tries `[brand].com`, `[brand].co`, `get[brand].com` with MX/A record verification. |
| **Tier 2** | **DuckDuckGo API** | High-precision zero-telemetry search matching brand keywords and trademark entities. |
| **Tier 3** | **Yahoo & Mojeek** | Independent search index fallback avoiding Google rate limits. |
| **Tier 4** | **Brave Search API** | Global privacy-preserving web index for ambiguous or international brand names. |

---

## ⚡ Quick Start

### 1. Clone & Initialize
```bash
git clone https://github.com/Kamran5H/SourceGenius.git
cd SourceGenius

# Setup Python environment
python -m venv .venv
.venv\Scripts\activate

# Install dependencies
pip install playwright requests beautifulsoup4
playwright install chromium
```

### 2. Launch Local Reader
```bash
# Start the local Playwright brand reader
python brand_reader_v2.py
```

### 3. Load Extension in Chrome
1. Navigate to `chrome://extensions/` in Google Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `brand-finder-extension-v7.1.11/` folder.
4. Open the Source Genius Sidepanel and begin sourcing!

---

## 📜 License

This project is open-source and released under the [MIT License](LICENSE).  
Copyright (c) 2024-2026 **Kamran Ashraf**.
