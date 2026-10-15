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
  return Array.from(new Set(rows.map((r) => r[0]).filter(Boolean)));
}

async function syncOrdersWithUserOAuth(orders) {
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
  const existingOrderNumbers = new Set();

  for (let i = 1; i < existingRows.length; i++) {
    const r = existingRows[i];
    if (r[2]) existingOrderNumbers.add(r[2]);
  }

  // Group items by Order Number so all cards fit in a single row with line breaks
  const orderGroups = {};
  for (const item of orders) {
    if (!orderGroups[item.orderNumber]) {
      orderGroups[item.orderNumber] = {
        orderDate: item.orderDate,
        orderNumber: item.orderNumber,
        seller: item.seller,
        tracking: item.tracking,
        orderUrl: item.orderUrl,
        qtys: [],
        cards: [],
        sets: [],
        conditions: []
      };
    }
    orderGroups[item.orderNumber].qtys.push(String(item.quantity));
    orderGroups[item.orderNumber].cards.push(item.cardName);
    orderGroups[item.orderNumber].sets.push(item.setDetails);
    orderGroups[item.orderNumber].conditions.push(item.condition);
  }

  const rowsToAppend = [];
  if (existingRows.length === 0) {
    rowsToAppend.push([
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
    ]);
  }

  for (const orderNum in orderGroups) {
    if (!existingOrderNumbers.has(orderNum)) {
      const group = orderGroups[orderNum];
      rowsToAppend.push([
        false,
        group.orderDate,
        group.orderNumber,
        group.seller,
        group.qtys.join("\n"),
        group.cards.join("\n"),
        group.sets.join("\n"),
        group.conditions.join("\n"),
        group.tracking,
        group.orderUrl
      ]);
    }
  }

  if (rowsToAppend.length > 0) {
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Orders!A1:append?valueInputOption=USER_ENTERED`;
    const appendRes = await fetch(appendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: rowsToAppend })
    });
    const appendData = await appendRes.json();
    if (appendData.error) throw new Error(appendData.error.message);
  }

  // Always apply explicit column widths, top alignment, wrapping, and checkboxes
  await applySheetFormattingAndCheckboxes(token, sheetId);

  const addedCount = existingRows.length === 0 ? Math.max(0, rowsToAppend.length - 1) : rowsToAppend.length;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

  return { added: addedCount, sheetUrl, isNewSheet };
}

async function applySheetFormattingAndCheckboxes(token, sheetId) {
  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const meta = await metaRes.json();
  const targetSheet = meta.sheets?.find((s) => s.properties.title === "Orders") || meta.sheets?.[0];
  const numericSheetId = targetSheet ? targetSheet.properties.sheetId : 0;

  // Explicit pixel widths for Columns A (0) through J (9)
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

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [
        // 1. Apply fixed, clean pixel widths to Columns A-J
        ...widthRequests,

        // 2. Add Checkboxes to Column A (Rows 2 to 5000)
        {
          setDataValidation: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: 5000,
              startColumnIndex: 0,
              endColumnIndex: 1
            },
            rule: {
              condition: { type: "BOOLEAN" },
              showCustomUi: true
            }
          }
        },

        // 3. Wrap text and TOP-align Columns A to I so multi-line cards align line-by-line
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: 5000,
              startColumnIndex: 0,
              endColumnIndex: 9
            },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "WRAP",
                verticalAlignment: "TOP"
              }
            },
            fields: "userEnteredFormat(wrapStrategy,verticalAlignment)"
          }
        },

        // 4. Center-align Column A (Checkboxes) and Column E (Qty)
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: 5000,
              startColumnIndex: 0,
              endColumnIndex: 1
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: "CENTER",
                verticalAlignment: "TOP"
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
              endRowIndex: 5000,
              startColumnIndex: 4,
              endColumnIndex: 5
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: "CENTER",
                verticalAlignment: "TOP",
                wrapStrategy: "WRAP"
              }
            },
            fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)"
          }
        },

        // 5. Clip long URLs in Column J so they don't stretch row height
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 1,
              endRowIndex: 5000,
              startColumnIndex: 9,
              endColumnIndex: 10
            },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "CLIP",
                verticalAlignment: "TOP"
              }
            },
            fields: "userEnteredFormat(wrapStrategy,verticalAlignment)"
          }
        },

        // 6. Format Header Row (Dark background, white bold text, frozen row)
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
        }
      ]
    })
  });
}