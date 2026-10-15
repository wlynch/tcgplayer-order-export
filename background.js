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
  const existingOrdersMap = parseExistingSheetOrders(existingRows);

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
  let currentRowIdx = 1;

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

  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const meta = await metaRes.json();
  const targetSheet = meta.sheets?.find((s) => s.properties.title === "Orders") || meta.sheets?.[0];
  const numericSheetId = targetSheet ? targetSheet.properties.sheetId : 0;
  const currentGridRows = targetSheet?.properties?.gridProperties?.rowCount || 1000;
  const existingMerges = targetSheet?.merges || [];
  const staleHighlightRuleIndices = (targetSheet?.conditionalFormats || [])
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => {
      const condition = rule.booleanRule?.condition;
      return (
        condition?.type === "CUSTOM_FORMULA" &&
        condition.values?.some(({ userEnteredValue }) => {
          if (typeof userEnteredValue !== "string") return false;
          return (
            userEnteredValue === "=$A2=TRUE" ||
            userEnteredValue.includes("LOOKUP(2,1/") ||
            /^=\$A\$\d+=TRUE$/.test(userEnteredValue)
          );
        })
      );
    })
    .map(({ index }) => index)
    .sort((a, b) => b - a);

  const resetRequests = [
    {
      unmergeCells: {
        range: { sheetId: numericSheetId }
      }
    },
    ...existingMerges.map((m) => ({
      unmergeCells: { range: m }
    })),
    ...staleHighlightRuleIndices.map((index) => ({
      deleteConditionalFormatRule: { sheetId: numericSheetId, index }
    })),
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

  if (allGridRows.length + 20 > currentGridRows) {
    resetRequests.push({
      appendDimension: {
        sheetId: numericSheetId,
        dimension: "ROWS",
        length: allGridRows.length + 100 - currentGridRows
      }
    });
  }

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests: resetRequests })
  });

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Orders!A1:J${Math.max(currentGridRows, allGridRows.length)}:clear`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    }
  );

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

  if (allGridRows.length > 1) {
    await applySheetFormattingAndMerges(token, sheetId, numericSheetId, orderSpans, allGridRows.length, finalOrdersMap);
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  return { added: addedOrdersCount, sheetUrl, isNewSheet };
}

async function applySheetFormattingAndMerges(token, sheetId, numericSheetId, orderSpans, totalRows, finalOrdersMap) {
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

  const packageCols = [0, 1, 2, 3, 8, 9];
  const packageRequests = [];

  const ordersArr = Array.from(finalOrdersMap.values());

  for (let idx = 0; idx < orderSpans.length; idx++) {
    const span = orderSpans[idx];
    const orderObj = ordersArr[idx];

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

    // Write the boolean state separately from the checkbox validation rule.
    packageRequests.push({
      updateCells: {
        range: {
          sheetId: numericSheetId,
          startRowIndex: span.startRow,
          endRowIndex: span.startRow + 1,
          startColumnIndex: 0,
          endColumnIndex: 1
        },
        rows: [
          {
            values: [
              {
                userEnteredValue: { boolValue: Boolean(orderObj?.arrived) }
              }
            ]
          }
        ],
        fields: "userEnteredValue"
      }
    });

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
          strict: true,
          showCustomUi: true
        }
      }
    });

    packageRequests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [
            {
              sheetId: numericSheetId,
              startRowIndex: span.startRow,
              endRowIndex: span.endRow,
              startColumnIndex: 1,
              endColumnIndex: 10
            }
          ],
          booleanRule: {
            condition: {
              type: "CUSTOM_FORMULA",
              values: [{ userEnteredValue: `=$A$${span.startRow + 1}=TRUE` }]
            },
            format: {
              backgroundColor: { red: 0.82, green: 0.93, blue: 0.85 }
            }
          }
        },
        index: idx
      }
    });

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

  const formatRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
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
  const formatData = await formatRes.json();
  if (formatData.error) throw new Error(formatData.error.message);
}