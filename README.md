# TCGplayer Order History to Google Sheets Sync

A custom Manifest V3 Google Chrome Extension that automatically scrapes your TCGplayer buyer order history, groups multi-item orders into clean multi-row layouts with interactive package checkboxes, and syncs everything directly to a formatted Google Sheet via Google OAuth.

Designed specifically to bypass strict Google Advanced Protection Program blocks by utilizing secure, direct REST API calls with user-authenticated OAuth tokens (`drive.file` scope).

---

## Features

- **Smart DOM & Background Scraping:** Intelligently parses TCGplayer's React Single-Page Application (SPA) order history, capturing exact card names, quantities, sets, and conditions. Automatically fetches order detail pages in the background if an order row is collapsed.
- **Clean Multi-Row Layout:** Each individual card gets its own row for precise tracking, while package-level data (Order Date, Order Number, Seller, Tracking, and URL) is grouped and vertically merged into a single clean block.
- **Interactive Checkboxes:** Automatically generates functional checkboxes in Column A anchored to each package.
- **Arrived Highlighting (Conditional Formatting):** Checking a package's "Arrived?" checkbox automatically highlights the entire order row in a soft, elegant mint green (`#d1e7dd`).
- **Incremental Crawling:** Features an optional toggle to automatically stop crawling when it detects orders that have already been synced to your sheet.
- **Advanced Protection Compatible:** Bypasses policy-enforced blocks by communicating directly with the Google Sheets REST API using your personal Google account OAuth token via `chrome.identity`.

---

## Project Structure

```text
tcgplayer-sheets-sync/
├── manifest.json       # Extension manifest (v3, permissions, OAuth client ID)
├── background.js       # Background service worker (OAuth token management & Google Sheets API sync)
└── content.js          # Injected content script (TCGplayer DOM scraper & floating UI widget)
```
