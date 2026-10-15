chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "GET_EXISTING_ORDERS") {
    getExistingOrderNumbers()
      .then((orderNumbers) => sendResponse({ ok: true, orderNumbers }))
      .catch((err) => {
        console.error("GET_EXISTING_ORDERS Error:", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg.action === "PUSH_TO_SHEETS") {
    syncOrdersWithUserOAuth(msg.orders)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => {
        console.error("PUSH_TO_SHEETS Error:", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }
});

function getUserAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "OAuth sign-in failed"));
      } else {
        resolve(token);
      }
    });
  });
}

async function createTrackerSheet(token) {
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties: { title: "TCGplayer Order Tracker" },
      sheets: [
        {
          properties: {
            title: "Orders",
            gridProperties: { frozenRowCount: 1 }
          }
        }
      ]
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const sheetId = data.spreadsheetId;
  await chrome.storage.sync.set({ tcgTrackerSheetId: sheetId });
  return sheetId;
}

async function getExistingOrderNumbers() {
  const stored = await chrome.storage.sync.get(["tcgTrackerSheetId"]);
  if (!stored.tcgTrackerSheetId) return [];

  const token = await getUserAuthToken();
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${stored.tcgTrackerSheetId}/values/Orders!C2:C5000`;
  const res = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) return [];
  const data = await res.json();
  const rows = data.values || [];
  return Array.from(new Set(rows.map((r) => (r[0] ? String(r[0]).trim() : "")).filter(Boolean)));
}

/**
 * Parses existing Google Sheet rows back into structured Order objects.
 * Preserves the user's checked/unchecked "Arrived?" status and splits any legacy \n cells.
 */
function parseExistingSheetOrders(existingRows) {
  const orderMap = new Map();
  let currentOrder = null;

  for (let i = 1; i < existingRows.length; i++) {
    const r = existingRows[i] || [];
    const rawOrderNum = r[2] ? String(r[2]).trim() : "";

    if (rawOrderNum !== "") {
      const arrivedVal = String(r[0] || "").trim().toUpperCase() === "TRUE";
      currentOrder = {
        arrived: arrivedVal,
        orderDate: r[1] ? String(r[1]).trim() : "",
        orderNumber: rawOrderNum,
        seller: r[3] ? String(r[3]).trim() : "",
        tracking: r[8] ? String(r[8]).trim() : "Ordered",
        orderUrl: r[9] ? String(r[9]).trim() : "",
        items: []
      };
      orderMap.set(rawOrderNum, currentOrder);
    }

    if (currentOrder) {
      const qtys = String(r[4] ?? "1").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const cards = String(r[5] ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const sets = String(r[6] ?? "-").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const conds = String(r[7] ?? "-").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

      const count = Math.max(cards.length, 1);
      for (let k = 0; k < count; k++) {
        const cardName = cards[k] || "";
        if (!cardName) continue;
        currentOrder.items.push({
          quantity: qtys[k] || "1",
          cardName,
          setDetails: sets[k] || "-",
          condition: conds[k] || "-"
        });
      }
    }
  }

  return orderMap;
}

async function syncOrdersWithUserOAuth(scrapedItems) {
  const token = await getUserAuthToken();
  const stored = await chrome.storage.sync.get(["tcgTrackerSheetId"]);
  let sheetId = stored.tcgTrackerSheetId;
  let isNewSheet = false;

  if (!sheetId) {
    sheetId = await createTrackerSheet(token);
    isNewSheet = true;
  }

  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Orders!A1:J5000`;
  let getRes = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (getRes.status === 404) {
    sheetId = await createTrackerSheet(token);
    isNewSheet = true;
    getRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Orders!A1:J5000`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }

  const getData = await getRes.json();
  if (getData.error) throw new Error(getData.error.message);

  const existingRows = getData.values || [];

  // 1. Parse existing orders from the sheet
  const existingOrdersMap = parseExistingSheetOrders(existingRows);

  // 2. Group newly scraped items by Order Number (deduplicating items within the same order)
  const scrapedOrdersMap = new Map();
  for (const item of scrapedItems) {
    if (!scrapedOrdersMap.has(item.orderNumber)) {
      scrapedOrdersMap.set(item.orderNumber, {
        arrived: false,
        orderDate: item.orderDate,
        orderNumber: item.orderNumber,
        seller: item.seller,
        tracking: item.tracking,
        orderUrl: item.orderUrl,
        items: []
      });
    }
    scrapedOrdersMap.get(item.orderNumber).items.push({
      quantity: String(item.quantity),
      cardName: item.cardName,
      setDetails: item.setDetails,
      condition: item.condition
    });
  }

  // 3. Combine new orders and existing orders (preserving unique Order Numbers so spans never overlap)
  let addedOrdersCount = 0;
  const finalOrdersMap = new Map();

  for (const [orderNum, newOrder] of scrapedOrdersMap.entries()) {
    if (!existingOrdersMap.has(orderNum)) {
      finalOrdersMap.set(orderNum, newOrder);
      addedOrdersCount++;
    } else {
      const existing = existingOrdersMap.get(orderNum);
      const hadPlaceholder =
        existing.items.length === 0 ||
        existing.items.some((i) => /Package Summary|\[Order /i.test(i.cardName));
      if (hadPlaceholder && newOrder.items.length > 0) {
        existing.items = newOrder.items;
      }
      if (newOrder.tracking && newOrder.tracking !== "Ordered") {
        existing.tracking = newOrder.tracking;
      }
    }
  }

  for (const [orderNum, existingOrder] of existingOrdersMap.entries()) {
    if (!finalOrdersMap.has(orderNum)) {
      finalOrdersMap.set(orderNum, existingOrder);
    }
  }

  // 4. Build the clean multi-row 2D grid and track exact [startRow, endRow) spans
  const allGridRows = [
    [
      "Arrived?",
      "Order Date",
      "Order Number",
      "Seller",
      "Qty",
      "Card / Item",
      "Set",
      "Condition",
      "Tracking / Status",
      "Order URL"
    ]
  ];

  const orderSpans = [];
  let currentRowIdx = 1; // 0-based index (Row 1 is index 0, first data row is index 1)

  for (const order of finalOrdersMap.values()) {
    const items =
      order.items.length > 0
        ? order.items
        : [{ quantity: "1", cardName: `[Order ${order.orderNumber}]`, setDetails: "-", condition: "-" }];

    const startRow = currentRowIdx;
    const endRow = startRow + items.length;

    items.forEach((card, idx) => {
      if (idx === 0) {
        allGridRows.push([
          Boolean(order.arrived),
          order.orderDate,
          order.orderNumber,
          order.seller,
          card.quantity,
          card.cardName,
          card.setDetails,
          card.condition,
          order.tracking,
          order.orderUrl
        ]);
      } else {
        allGridRows.push([
          null,
          null,
          null,
          null,
          card.quantity,
          card.cardName,
          card.setDetails,
          card.condition,
          null,
          null
        ]);
      }
    });

    orderSpans.push({ startRow, endRow });
    currentRowIdx = endRow;
  }

  // 5. Fetch sheet metadata (numeric sheetId, current rowCount, and exact existing merges)
  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const meta = await metaRes.json();
  const targetSheet = meta.sheets?.find((s) => s.properties.title === "Orders") || meta.sheets?.[0];
  const numericSheetId = targetSheet ? targetSheet.properties.sheetId : 0;
  const currentGridRows = targetSheet?.properties?.gridProperties?.rowCount || 1000;
  const existingMerges = targetSheet?.merges || [];

  // 6. Unbound unmerge: unmerge every existing merge on the sheet AND clear old validations/borders
  const resetRequests = [
    // Unmerge the ENTIRE sheet tab unconditionally so it can never split a partial merge!
    {
      unmergeCells: {
        range: {
          sheetId: numericSheetId
        }
      }
    },
    // Also explicitly unmerge each active merge reported by metadata just in case
    ...existingMerges.map((m) => ({
      unmergeCells: { range: m }
    })),
    // Clear all data validations on Column A across the entire sheet
    {
      setDataValidation: {
        range: {
          sheetId: numericSheetId,
          startRowIndex: 1,
          endRowIndex: currentGridRows,
          startColumnIndex: 0,
          endColumnIndex: 1
        }
      }
    },
    // Clear all borders in the data range
    {
      updateBorders: {
        range: {
          sheetId: numericSheetId,
          startRowIndex: 1,
          endRowIndex: currentGridRows,
          startColumnIndex: 0,
          endColumnIndex: 10
        },
        top: { style: "NONE" },
        bottom: { style: "NONE" },
        innerHorizontal: { style: "NONE" }
      }
    }
  ];

  // If our new grid has more rows than the sheet currently has, expand the sheet grid first
  if (allGridRows.length + 20 > currentGridRows) {
    resetRequests.push({
      appendDimension: {
        sheetId: numericSheetId,
        dimension: "ROWS",
        length: allGridRows.length + 100 - currentGridRows
      }
    });
  }

  const resetRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests: resetRequests })
  });
  const resetData = await resetRes.json();
  if (resetData.error) {
    console.error("Reset batchUpdate error:", resetData.error);
    throw new Error(`Reset error: ${resetData.error.message}`);
  }

  // Clear all existing cell values
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Orders!A1:J${Math.max(currentGridRows, allGridRows.length)}:clear`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  // 7. Write the clean, normalized multi-row grid starting at A1
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Orders!A1?valueInputOption=USER_ENTERED`;
  const writeRes = await fetch(writeUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values: allGridRows })
  });
  const writeData = await writeRes.json();
  if (writeData.error) throw new Error(writeData.error.message);

  // 8. Apply exact vertical merges, checkboxes, column widths, and borders
  if (allGridRows.length > 1) {
    await applySheetFormattingAndMerges(token, sheetId, numericSheetId, orderSpans, allGridRows.length);
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  return { added: addedOrdersCount, sheetUrl, isNewSheet };
}

async function applySheetFormattingAndMerges(token, sheetId, numericSheetId, orderSpans, totalRows) {
  const columnWidths = [
    75,  // A: Arrived?
    110, // B: Order Date
    180, // C: Order Number
    160, // D: Seller
    55,  // E: Qty
    320, // F: Card / Item
    200, // G: Set
    150, // H: Condition
    160, // I: Tracking / Status
    220  // J: Order URL
  ];

  const widthRequests = columnWidths.map((pixelSize, colIndex) => ({
    updateDimensionProperties: {
      range: {
        sheetId: numericSheetId,
        dimension: "COLUMNS",
        startIndex: colIndex,
        endIndex: colIndex + 1
      },
      properties: { pixelSize },
      fields: "pixelSize"
    }
  }));

  // Package-level columns to merge vertically: A(0), B(1), C(2), D(3), I(8), J(9)
  const packageCols = [0, 1, 2, 3, 8, 9];
  const packageRequests = [];

  for (const span of orderSpans) {
    // 1. Merge each package column vertically across the order's exact card rows
    if (span.endRow - span.startRow > 1) {
      for (const colIdx of packageCols) {
        packageRequests.push({
          mergeCells: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: span.startRow,
              endRowIndex: span.endRow,
              startColumnIndex: colIdx,
              endColumnIndex: colIdx + 1
            },
            mergeType: "MERGE_ALL"
          }
        });
      }
    }

    // 2. Apply Checkbox validation strictly to the top-left anchor cell of the merged range
    packageRequests.push({
      setDataValidation: {
        range: {
          sheetId: numericSheetId,
          startRowIndex: span.startRow,
          endRowIndex: span.startRow + 1,
          startColumnIndex: 0,
          endColumnIndex: 1
        },
        rule: {
          condition: { type: "BOOLEAN" },
          showCustomUi: true
        }
      }
    });

    // 3. Draw a solid bottom border across A-J at the end of each package
    packageRequests.push({
      updateBorders: {
        range: {
          sheetId: numericSheetId,
          startRowIndex: span.startRow,
          endRowIndex: span.endRow,
          startColumnIndex: 0,
          endColumnIndex: 10
        },
        bottom: {
          style: "SOLID_MEDIUM",
          color: { red: 0.6, green: 0.64, blue: 0.7 }
        },
        innerHorizontal: {
          style: "SOLID",
          color: { red: 0.9, green: 0.91, blue: 0.93 }
        }
      }
    });
  }

  const batchRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [
        ...widthRequests,

        // Format Header Row
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 10
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.12, green: 0.16, blue: 0.22 },
                verticalAlignment: "MIDDLE",
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 1, green: 1, blue: 1 }
                }
              }
            },
            fields: "userEnteredFormat(backgroundColor,verticalAlignment,textFormat)"
          }
        },
        {
          updateSheetProperties: {
            properties: {
              sheetId: numericSheetId,
              gridProperties: { frozenRowCount: 1 }
            },
            fields: "gridProperties.frozenRowCount"
          }
        },

        // Wrap text and MIDDLE-align Columns A to I
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: totalRows,
              startColumnIndex: 0,
              endColumnIndex: 9
            },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "WRAP",
                verticalAlignment: "MIDDLE"
              }
            },
            fields: "userEnteredFormat(wrapStrategy,verticalAlignment)"
          }
        },

        // Center-align Column A (Checkboxes) and Column E (Qty)
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: totalRows,
              startColumnIndex: 0,
              endColumnIndex: 1
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: "CENTER",
                verticalAlignment: "MIDDLE"
              }
            },
            fields: "userEnteredFormat(horizontalAlignment,verticalAlignment)"
          }
        },
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: totalRows,
              startColumnIndex: 4,
              endColumnIndex: 5
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: "CENTER",
                verticalAlignment: "MIDDLE"
              }
            },
            fields: "userEnteredFormat(horizontalAlignment,verticalAlignment)"
          }
        },

        // Clip long URLs in Column J
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: totalRows,
              startColumnIndex: 9,
              endColumnIndex: 10
            },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "CLIP",
                verticalAlignment: "MIDDLE"
              }
            },
            fields: "userEnteredFormat(wrapStrategy,verticalAlignment)"
          }
        },

        // Execute package merges, anchor-cell checkboxes, and borders
        ...packageRequests
      ]
    })
  });

  const batchData = await batchRes.json();
  if (batchData.error) {
    console.error("batchUpdate formatting error:", batchData.error);
    throw new Error(batchData.error.message);
  }
}