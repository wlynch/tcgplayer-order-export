(function () {
  // Remove any stale widget left over from a previous extension reload
  const existingPanel = document.getElementById("tcg-sheets-sync-panel");
  if (existingPanel) {
    existingPanel.remove();
  }

  const panel = document.createElement("div");
  panel.id = "tcg-sheets-sync-panel";
  panel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #111827;
    color: #f9fafb;
    padding: 14px 16px;
    border-radius: 10px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.45);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    width: 300px;
    border: 1px solid #374151;
  `;

  panel.innerHTML = `
    <div style="font-weight:700; font-size:14px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
      <span>🃏 TCGplayer → Google Sheet</span>
      <span id="tcg-sync-status" style="font-size:11px; color:#10b981;">Ready (v3.1)</span>
    </div>

    <label style="display:flex; gap:6px; align-items:center; margin-bottom:10px; font-size:12px; color:#d1d5db; cursor:pointer;">
      <input id="tcg-incremental-toggle" type="checkbox" checked style="cursor:pointer;" />
      <span>Stop when reaching already-synced orders</span>
    </label>

    <button id="tcg-btn-sync-all" style="width:100%; padding:9px 10px; margin-bottom:6px; background:#059669; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">
      🚀 Sync Orders to Google Sheet
    </button>

    <button id="tcg-btn-test" style="width:100%; padding:6px 10px; margin-bottom:6px; background:#374151; color:#d1d5db; border:none; border-radius:6px; font-weight:500; font-size:11px; cursor:pointer;">
      🔍 Preview Page Scrape in Console
    </button>

    <button id="tcg-btn-stop" style="width:100%; padding:7px 10px; margin-bottom:6px; background:#dc2626; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer; display:none;">
      ⏹ Stop & Save Collected So Far
    </button>

    <a id="tcg-open-sheet" href="#" target="_blank" style="display:none; text-align:center; font-size:12px; color:#60a5fa; text-decoration:none; margin-top:4px;">
      📊 Open My Tracker Sheet ↗
    </a>
  `;

  document.body.appendChild(panel);

  const statusEl = document.getElementById("tcg-sync-status");
  const incrementalToggle = document.getElementById("tcg-incremental-toggle");
  const syncBtn = document.getElementById("tcg-btn-sync-all");
  const testBtn = document.getElementById("tcg-btn-test");
  const stopBtn = document.getElementById("tcg-btn-stop");
  const openSheetLink = document.getElementById("tcg-open-sheet");

  function setStatus(text, color = "#10b981") {
    statusEl.textContent = text;
    statusEl.style.color = color;
  }

  /**
   * Safe wrapper for chrome.runtime.sendMessage to gracefully catch invalidated contexts.
   */
  function sendExtensionMessage(payload, callback) {
    if (!chrome?.runtime?.id) {
      setStatus("Extension updated — refresh tab!", "#f87171");
      alert("The extension was reloaded. Please refresh this TCGplayer tab (F5) and click the button again.");
      return;
    }
    try {
      chrome.runtime.sendMessage(payload, callback);
    } catch (err) {
      setStatus("Extension updated — refresh tab!", "#f87171");
      alert("Extension context was updated. Please refresh this page (F5) and try again.");
    }
  }

  if (chrome?.runtime?.id) {
    chrome.storage.sync.get(["tcgTrackerSheetId"], (res) => {
      if (res?.tcgTrackerSheetId) {
        openSheetLink.href = `https://docs.google.com/spreadsheets/d/${res.tcgTrackerSheetId}/edit`;
        openSheetLink.style.display = "block";
      }
    });

    chrome.storage.local.get(["crawlState"], (data) => {
      if (data?.crawlState && data.crawlState.active) {
        resumeCrawl(data.crawlState);
      }
    });
  }

  const ORDER_ID_REGEX = /\b([0-9A-Z]{6,10}-[0-9A-Z]{4,10}-[0-9A-Z]{4,10})\b/;
  const ORDER_ID_GLOBAL_REGEX = /\b([0-9A-Z]{6,10}-[0-9A-Z]{4,10}-[0-9A-Z]{4,10})\b/g;
  const COND_REGEX = /(Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged|Unopened)(\s+Foil|\s+1st Edition|\s+Reverse Holofoil|\s+Unlimited|\s+Etched|\s+Holofoil)?/i;

  /**
   * Finds the exact isolated DOM container for each Order Number on the page
   * without ever matching nested child or parent duplicates.
   */
  function getIsolatedOrderContainers(rootDoc = document) {
    const orderMap = new Map();

    const walker = rootDoc.createTreeWalker(rootDoc.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || "";
      const match = text.match(ORDER_ID_REGEX);
      if (match) {
        const orderNum = match[1].trim();
        if (!orderMap.has(orderNum)) {
          let container = node.parentElement;
          while (container && container !== rootDoc.body) {
            const parent = container.parentElement;
            if (!parent || parent === rootDoc.body) break;

            // Stop walking up if the parent contains OTHER order numbers
            const parentText = parent.innerText || parent.textContent || "";
            const allMatchesInParent = new Set(
              [...parentText.matchAll(ORDER_ID_GLOBAL_REGEX)].map((m) => m[1].trim())
            );
            if (allMatchesInParent.size > 1) {
              break;
            }
            container = parent;
          }
          if (container) {
            orderMap.set(orderNum, container);
          }
        }
      }
    }
    return orderMap;
  }

  /**
   * Extracts product rows from an order container (or fetched detail document).
   */
  function extractProductsFromNode(container) {
    const products = [];
    const seenRowElements = new Set();

    // Find all links pointing to TCGplayer products inside this order container
    const productLinks = container.querySelectorAll(
      "a[href*='/product/'], a[href*='/Product/'], a[href*='Product.aspx'], .orderHistoryItems a, td a"
    );

    productLinks.forEach((link) => {
      const href = link.getAttribute("href") || "";
      const linkText = (link.innerText || link.textContent || "").trim();

      // Skip navigation/seller/tracking/help links
      if (
        !linkText ||
        linkText.length < 2 ||
        /View Order|Contact Seller|Track|Seller|Help|Rate|Return|Message|Details|Invoice/i.test(linkText) ||
        /orderhistory|myaccount|seller|feedback|help\.tcgplayer/i.test(href)
      ) {
        return;
      }

      // Find the row (<tr> or item container) that holds this product link
      const row = link.closest("tr, li, [class*='item'], [class*='product'], [class*='row']") || link.parentElement;
      if (!row || seenRowElements.has(row)) return;
      seenRowElements.add(row);

      let cardName = linkText.replace(/\s+/g, " ").trim();
      let setDetails = "-";
      let condition = "Near Mint";
      let quantity = 1;

      // If it's a table row (<tr>), inspect its cells (<td>) directly
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) {
        const cellTexts = Array.from(cells).map((td) =>
          (td.innerText || td.textContent || "").trim()
        );

        // Cell 0 usually has Card Name + Set Name (often on separate lines inside Cell 0)
        const firstCellLines = cellTexts[0]
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (firstCellLines.length >= 2) {
          const otherLines = firstCellLines.filter((l) => l !== cardName && !COND_REGEX.test(l));
          if (otherLines.length > 0) setDetails = otherLines[0];
        }

        // Scan all cells in the row for Condition and Quantity
        for (let idx = 0; idx < cellTexts.length; idx++) {
          const cText = cellTexts[idx];

          const condMatch = cText.match(COND_REGEX);
          if (condMatch) {
            condition = condMatch[0].trim();
            const detailLines = cText
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l && !COND_REGEX.test(l) && !/^Condition|Rarity|Card Number/i.test(l));
            if (setDetails === "-" && detailLines.length > 0) {
              setDetails = detailLines[0];
            }
          }

          // Check for Quantity: either a pure integer cell (e.g., "1", "4") or labeled "Qty: 2" / "2x"
          if (/^\d{1,3}$/.test(cText)) {
            quantity = parseInt(cText, 10);
          } else {
            const qMatch =
              cText.match(/(?:Qty|Quantity)\s*[:\-]?\s*(\d+)/i) ||
              cText.match(/^(\d+)\s*[xX]\b/);
            if (qMatch) {
              quantity = parseInt(qMatch[1], 10);
            }
          }
        }
      } else {
        // Non-table layout (React/div cards)
        const rowText = (row.innerText || row.textContent || "").trim();
        const condMatch = rowText.match(COND_REGEX);
        if (condMatch) condition = condMatch[0].trim();

        const lines = rowText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (/^\d{1,3}$/.test(line)) {
            quantity = parseInt(line, 10);
          } else {
            const qMatch =
              line.match(/(?:Qty|Quantity)\s*[:\-]?\s*(\d+)/i) ||
              line.match(/^(\d+)\s*[xX]\s+/) ||
              line.match(/\b(\d+)\s+of\s+\$/i);
            if (qMatch) quantity = parseInt(qMatch[1], 10);
          }
          if (
            setDetails === "-" &&
            line !== cardName &&
            !COND_REGEX.test(line) &&
            !/\$|Qty|Quantity|^\d+$/i.test(line)
          ) {
            setDetails = line;
          }
        }
      }

      products.push({
        cardName,
        setDetails,
        condition,
        quantity: quantity || 1
      });
    });

    return products;
  }

  /**
   * Scrapes all orders on the current page. If an order is collapsed and doesn't show its products,
   * it fetches the order's detail URL in the background so card names are still extracted.
   */
  async function scrapeCurrentPage() {
    const items = [];
    const orderContainers = getIsolatedOrderContainers(document);

    for (const [orderNumber, container] of orderContainers.entries()) {
      const text = (container.innerText || container.textContent || "").trim();

      // 1. Extract Order Date
      const dateMatch =
        text.match(/(?:Order Date|Ordered on|Date|Placed)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i) ||
        text.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4})\b/i);
      const orderDate = dateMatch ? dateMatch[1].trim() : new Date().toISOString().split("T")[0];

      // 2. Extract Seller Name
      let seller = "TCGplayer Seller";
      const sellerMatch = text.match(/(?:Seller|Sold by|Shipped by|Package from|Store)\s*[:\-]?\s*([^\r\n\t|]+)/i);
      if (sellerMatch) {
        seller = sellerMatch[1].replace(/View Order.*|Contact.*$/i, "").trim();
      }

      // 3. Extract Tracking / Status
      let tracking = "Ordered";
      const trackingMatch = text.match(/(?:Tracking|Status)\s*(?:#|Number)?\s*[:\-]?\s*([A-Z0-9]{10,30}|Shipped|Delivered|Processing|In Transit|Not Available)/i);
      if (trackingMatch) {
        tracking = trackingMatch[1].trim();
      }

      // 4. Extract Products directly from the DOM container
      let products = extractProductsFromNode(container);

      // 5. If 0 products found (because the order is collapsed on a summary table),
      // look for a "View Order" / detail link and fetch it in the background
      if (products.length === 0) {
        const detailLink = container.querySelector(
          `a[href*='${orderNumber}'], a[href*='orderhistory/'], a[href*='OrderDetails']`
        );
        if (detailLink && detailLink.href) {
          try {
            const resp = await fetch(detailLink.href, { credentials: "include" });
            if (resp.ok) {
              const html = await resp.text();
              const doc = new DOMParser().parseFromString(html, "text/html");
              products = extractProductsFromNode(doc.body);
            }
          } catch (e) {
            console.warn("Could not fetch detail page for", orderNumber, e);
          }
        }
      }

      // 6. Push extracted products (or a SINGLE clean fallback row if details couldn't be loaded)
      if (products.length > 0) {
        products.forEach((prod) => {
          items.push({
            orderDate,
            orderNumber,
            seller,
            quantity: prod.quantity,
            cardName: prod.cardName,
            setDetails: prod.setDetails,
            condition: prod.condition,
            tracking,
            orderUrl: window.location.href
          });
        });
      } else {
        items.push({
          orderDate,
          orderNumber,
          seller,
          quantity: 1,
          cardName: `[Order ${orderNumber}]`,
          setDetails: "-",
          condition: "-",
          tracking,
          orderUrl: window.location.href
        });
      }
    }

    return items;
  }

  function findNextPageButton() {
    const candidates = document.querySelectorAll(
      "a[aria-label*='Next' i], button[aria-label*='Next' i], a.nextPage, .pagination a, .tcg-pagination__next, button.tcg-button"
    );
    for (const el of candidates) {
      const text = (el.innerText || el.getAttribute("aria-label") || "").trim();
      const isDisabled =
        el.disabled ||
        el.classList.contains("disabled") ||
        el.getAttribute("aria-disabled") === "true";
      if (!isDisabled && (/^next\b/i.test(text) || text === ">" || text === "›" || text === "»")) {
        return el;
      }
    }
    return null;
  }

  function waitForPageChange(previousFirstOrder, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const containers = getIsolatedOrderContainers(document);
        const firstOrderNow = containers.keys().next().value || "";
        if (firstOrderNow && firstOrderNow !== previousFirstOrder) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 400);
    });
  }

  async function resumeCrawl(state) {
    syncBtn.style.display = "none";
    stopBtn.style.display = "block";
    incrementalToggle.checked = state.stopOnExisting;

    const knownOrdersSet = new Set(state.knownOrderNumbers || []);

    while (state.active) {
      setStatus(`Scraping page ${state.currentPage}...`, "#60a5fa");

      await new Promise((r) => setTimeout(r, 900));
      const pageOrders = await scrapeCurrentPage();
      const firstOrderBefore = pageOrders[0]?.orderNumber || "";

      const existingMap = new Map(
        state.collected.map((o) => [`${o.orderNumber}||${o.cardName}||${o.condition}`, o])
      );
      pageOrders.forEach((o) => {
        existingMap.set(`${o.orderNumber}||${o.cardName}||${o.condition}`, o);
      });
      state.collected = Array.from(existingMap.values());

      if (
        state.stopOnExisting &&
        pageOrders.length > 0 &&
        pageOrders.every((o) => knownOrdersSet.has(o.orderNumber))
      ) {
        setStatus("Caught up to existing orders!", "#10b981");
        break;
      }

      const nextBtn = findNextPageButton();
      if (!nextBtn) {
        setStatus(`Finished all ${state.currentPage} page(s)!`, "#10b981");
        break;
      }

      state.currentPage += 1;
      await chrome.storage.local.set({ crawlState: state });

      nextBtn.click();

      const changed = await waitForPageChange(firstOrderBefore);
      if (!changed) break;
    }

    await finishCrawlAndPush(state.collected);
  }

  async function finishCrawlAndPush(collectedOrders) {
    await chrome.storage.local.set({ crawlState: { active: false, collected: [] } });
    syncBtn.style.display = "block";
    stopBtn.style.display = "none";

    if (!collectedOrders || collectedOrders.length === 0) {
      setStatus("No orders found!", "#f87171");
      return;
    }

    setStatus(`Syncing ${collectedOrders.length} items to Sheet...`, "#60a5fa");
    sendExtensionMessage(
      { action: "PUSH_TO_SHEETS", orders: collectedOrders },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setStatus(`Error: ${response?.error || "Failed"}`, "#f87171");
          alert(`Google Sheets Error:\n${response?.error || chrome.runtime.lastError?.message}`);
        } else {
          setStatus(`✅ Added ${response.added} new order(s)!`, "#10b981");
          if (response.sheetUrl) {
            openSheetLink.href = response.sheetUrl;
            openSheetLink.style.display = "block";
            if (response.isNewSheet) {
              window.open(response.sheetUrl, "_blank");
            }
          }
        }
      }
    );
  }

  // Preview Button: lets you inspect the exact scraped rows in DevTools Console (F12) before syncing
  testBtn.addEventListener("click", async () => {
    setStatus("Testing scrape...", "#60a5fa");
    const results = await scrapeCurrentPage();
    console.table(results);
    setStatus(`Found ${results.length} item(s) (See Console)`, "#10b981");
  });

  syncBtn.addEventListener("click", () => {
    setStatus("Checking existing sheet...", "#60a5fa");
    const stopOnExisting = incrementalToggle.checked;

    let responded = false;
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        setStatus("Error: Background script timed out.", "#f87171");
        alert("Background script timed out. Check extension service worker console.");
      }
    }, 8000);

    sendExtensionMessage({ action: "GET_EXISTING_ORDERS" }, async (res) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeout);

      if (!res?.ok) {
        setStatus(`Error: ${res?.error || "Auth failed"}`, "#f87171");
        alert(`OAuth / Sheets Error:\n${res?.error || "Failed to connect to Google Sheets."}`);
        return;
      }

      const knownOrderNumbers = res.orderNumbers || [];
      const initialState = {
        active: true,
        currentPage: 1,
        stopOnExisting,
        knownOrderNumbers,
        collected: []
      };
      await chrome.storage.local.set({ crawlState: initialState });
      resumeCrawl(initialState);
    });
  });

  stopBtn.addEventListener("click", async () => {
    const data = await chrome.storage.local.get(["crawlState"]);
    const collected = data.crawlState?.collected || [];
    await finishCrawlAndPush(collected);
  });
})();