import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

// Reduce an ExcelJS cell value to a primitive (handles rich text / formula / hyperlink cells).
function cellVal(c) {
  if (c === null || c === undefined) return null;
  if (typeof c === 'object') {
    if ('text' in c) return c.text;
    if ('result' in c) return c.result;
    if ('hyperlink' in c) return c.text ?? c.hyperlink;
    return String(c);
  }
  return c;
}

/**
 * Parse a warehouse Stock-On-Hand sheet into [{ code, qty, name }], where `code` is whatever
 * identifies the item — a barcode or a SKU. The caller resolves it against the store.
 *
 * The template is two columns, "SKU / Barcode" and "QTY", but columns are detected by header
 * name, so the older warehouse layout (Product/Barcode | Product | SOH | Product Category)
 * still imports unchanged. Accepts .xlsx and .csv.
 */
export async function parseSoh(buffer) {
  const wb = new ExcelJS.Workbook();
  const isXlsx = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b; // 'PK' zip magic
  if (isXlsx) {
    await wb.xlsx.load(buffer);
  } else {
    await wb.csv.read(Readable.from(buffer.toString('utf8')));
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('No sheet found in the file.');

  // Rows as 0-indexed arrays of primitives.
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push(vals.map(cellVal));
  });

  // Find the header row (first row naming an item column + a stock column).
  const isCodeHeader = (c) =>
    c.includes('barcode') || c.includes('sku') || c.includes('ean') || c.includes('upc') ||
    c.includes('code') || c.includes('item no') || c.includes('row label');
  const isQtyHeader = (c) =>
    c.includes('soh') || c.includes('stock') || c === 'qty' || c.includes('quantity') || c.includes('on hand');

  // A value that could be an item code: a barcode, or a barcode with a suffix like "…T" / "…vial".
  const looksLikeCode = (v) => /^[A-Za-z0-9][A-Za-z0-9._\/-]{3,}$/.test(String(v ?? '').trim()) && /\d/.test(String(v ?? ''));

  // Which column holds the codes, when no header says so? Pivot-table exports label it
  // "Row Labels", and other systems invent their own names, so fall back to looking at the
  // data: the first column (other than the quantity) whose values read like item codes.
  function guessCodeCol(headerIdx, qtyCol, width) {
    const sample = rows.slice(headerIdx + 1, headerIdx + 41);
    let best = -1, bestScore = 0;
    for (let c = 0; c < width; c++) {
      if (c === qtyCol) continue;
      const vals = sample.map((r) => (r || [])[c]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
      if (vals.length < 3) continue;
      const score = vals.filter(looksLikeCode).length / vals.length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore >= 0.6 ? best : -1;
  }

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map((c) => String(c ?? '').toLowerCase());
    if (cells.some(isQtyHeader)) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find a header row with a QTY (or SOH / stock) column.');
  }

  const header = (rows[headerIdx] || []).map((c) => String(c ?? '').trim().toLowerCase());
  const qtyCol = header.findIndex(isQtyHeader);
  const width = Math.max(header.length, ...rows.slice(headerIdx + 1, headerIdx + 41).map((r) => (r || []).length));
  let bcCol = header.findIndex(isCodeHeader);
  if (bcCol === -1) bcCol = guessCodeCol(headerIdx, qtyCol, width);
  // Optional, ignored on import — it is only there so the sheet reads well to a person.
  const nameCol = header.findIndex((h, i) => i !== bcCol && h.includes('product') && !h.includes('category'));

  if (bcCol === -1 || qtyCol === -1) {
    throw new Error('Sheet is missing a SKU / Barcode column or a QTY column.');
  }

  const items = [];
  const byCode = new Map();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    let code = r[bcCol];
    if (code === null || code === undefined || String(code).trim() === '') continue;
    // Long barcodes may arrive as numbers → normalise to a clean digit string.
    code = String(code).trim().replace(/\.0$/, '');
    // Pivot exports end with a "Grand Total" line; it is a sum, not an item.
    if (/^(grand\s+)?total$|^subtotal$/i.test(code)) continue;

    let qty = r[qtyCol];
    qty = qty === null || qty === undefined || qty === '' ? 0 : Math.round(Number(qty));
    if (!Number.isFinite(qty)) qty = 0;

    const name = nameCol !== -1 ? String(r[nameCol] ?? '').trim() : '';

    // Sum quantities if the same item appears on more than one row.
    const key = code.toLowerCase();
    if (byCode.has(key)) {
      byCode.get(key).qty += qty;
    } else {
      const item = { code, qty, name };
      byCode.set(key, item);
      items.push(item);
    }
  }
  return items;
}
