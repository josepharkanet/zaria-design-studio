// Inventory Update: upload a warehouse stock-on-hand sheet, dry-run the match,
// then write quantities to Shopify by barcode (falling back to SKU).
//
// Lifted out of server.js so the whole feature can be mounted into another Express
// app. The Design Studio hosts all of this now, and it is the one that owns the
// domain and the sign-in, so every piece of the operations app has to be mountable
// rather than assume it owns the process.
import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSoh } from './parseSoh.js';
import { buildSohTemplate } from './sohTemplate.js';
import {
  fetchVariantMap, findByCode, resolveLocationId, getLocations,
  applyInventory, zeroVariants, searchVariants, setVariantQuantity, metresOf,
} from './shopify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function mountInventory(app) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

  // The sheet UI lives at /inventory, not /, because the Design Studio owns the root.
  // Serve the page explicitly: static's own directory handling answers /inventory with a
  // 301 to /inventory/, and every nav link in the app points at the unslashed form.
  app.get('/inventory', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use('/inventory', express.static(PUBLIC_DIR, { redirect: false }));

  // Build the matched / unmatched / sold-out breakdown from an uploaded sheet.
  async function buildMatch(buffer, locationName) {
    const items = await parseSoh(buffer);
    const variantMap = await fetchVariantMap();
    const location = await resolveLocationId(locationName);

    const matched = [];
    const unmatched = [];
    for (const it of items) {
      const v = findByCode(variantMap, it.code);
      if (v) {
        matched.push({ ...it, variant: v, current: null, willSoldOut: it.qty <= 0,
                       barcode: v.barcode || it.code, productTitle: v.product.title });
      } else {
        unmatched.push({ ...it, barcode: it.code });
      }
    }

    // Store products the sheet never mentions. The warehouse did not count them, so the
    // operator is offered the choice to zero them; the variant rides along so apply can act
    // on exactly the ones they keep ticked. The map holds each variant under both its barcode
    // and its SKU, so iterate the variants, not the keys.
    const seen = new Set(matched.map((m) => m.variant.id));
    const notInSheet = [];
    for (const v of new Set(variantMap.values())) {
      if (seen.has(v.id)) continue;
      notInSheet.push({
        variantId: v.id, variant: v,
        barcode: v.barcode || '', sku: v.sku || '',
        name: v.product.title, status: v.product.status,
        current: typeof v.inventoryQuantity === 'number' ? metresOf(v, v.inventoryQuantity) : null,
        tracked: !!v.inventoryItem?.tracked,
      });
    }
    // The ones that actually change something first, so a long list stays readable.
    notInSheet.sort((a, b) => (b.current ?? -1) - (a.current ?? -1) || a.name.localeCompare(b.name));

    return { items, matched, unmatched, notInSheet, location };
  }

  // Blank SOH sheet in the shape the importer expects.
  app.get('/api/soh-template.xlsx', async (_req, res) => {
    try {
      const buf = await buildSohTemplate();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      // Date-stamped: the browser will not overwrite an existing download, so a fixed name
      // leaves last month's copy sitting there as "Zaria-SOH-template.xlsx" while the new one
      // lands as "(1)". The stamp makes the current one obvious.
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Disposition', `attachment; filename="Zaria-SOH-template-${stamp}.xlsx"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get('/api/locations', async (_req, res) => {
    try { res.json({ locations: await getLocations() }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Dry run — parse + match, change nothing.
  app.post('/api/preview', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const { matched, unmatched, notInSheet, location } = await buildMatch(req.file.buffer, req.body.location);
      res.json({
        location,
        counts: {
          sheetRows: matched.length + unmatched.length,
          matched: matched.length,
          soldOut: matched.filter((m) => m.willSoldOut).length,
          unmatched: unmatched.length,
          notInSheet: notInSheet.length,
        },
        sample: matched.slice(0, 25).map((m) => ({ barcode: m.barcode, name: m.productTitle, qty: m.qty })),
        soldOut: matched.filter((m) => m.willSoldOut).map((m) => ({ barcode: m.barcode, name: m.productTitle })),
        unmatchedSample: unmatched.slice(0, 25),
        // Full list, so every row can be ticked or skipped individually before anything is written.
        notInSheetList: notInSheet.map((n) => ({
          variantId: n.variantId, barcode: n.barcode, sku: n.sku,
          name: n.name, status: n.status, current: n.current, tracked: n.tracked,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Live — parse + match + write to Shopify.
  app.post('/api/apply', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const policy = (req.body.policy || 'DENY').toUpperCase() === 'CONTINUE' ? 'CONTINUE' : 'DENY';
      const { matched, notInSheet, location } = await buildMatch(req.file.buffer, req.body.location);
      const result = await applyInventory(matched, location.id, policy);

      // Items the operator chose to mark sold out because the sheet never mentioned them.
      // Only ids that are genuinely absent from the sheet are honoured, so a stale or
      // tampered list cannot zero something the sheet actually counted.
      let zeroIds = [];
      try { zeroIds = JSON.parse(req.body.zeroVariantIds || '[]'); } catch { zeroIds = []; }
      const allowed = new Map(notInSheet.map((n) => [n.variantId, n.variant]));
      const toZero = [...new Set(zeroIds)].map((id) => allowed.get(id)).filter(Boolean);
      const zeroed = toZero.length ? await zeroVariants(toZero, location.id, policy) : { updated: [], failed: [] };

      res.json({
        location: location.name,
        policy,
        attempted: matched.length,
        updated: result.updated.length,
        failed: result.failed,
        // Count what we actually accepted, not what was asked for: an id that is not in this
        // upload's not-in-sheet set was never a candidate, so it is not a failure either.
        zeroRequested: toZero.length,
        zeroIgnored: zeroIds.length - toZero.length,
        zeroUpdated: zeroed.updated.length,
        zeroFailed: zeroed.failed,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- update one item by hand (no sheet) ----
  // Find it by product name, barcode or SKU, then set its stock. Same write path as the
  // sheet import, so tracking and the sold-out policy are handled identically.
  app.get('/api/search', async (req, res) => {
    try {
      const location = await resolveLocationId(req.query.location);
      const items = await searchVariants(req.query.q, location.id);
      res.json({ location, items });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.post('/api/set-stock', express.json(), async (req, res) => {
    try {
      const { variantId, location } = req.body || {};
      if (!variantId) return res.status(400).json({ error: 'No item chosen.' });
      // Cloth is counted in metres and may be half of one; everything else is whole pieces.
      // The write path turns metres into the half-metre units Shopify holds.
      const qty = Math.round(Number(req.body.qty) * 2) / 2;
      if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'Enter a stock figure of 0 or more.' });
      const policy = String(req.body.policy || 'DENY').toUpperCase() === 'CONTINUE' ? 'CONTINUE' : 'DENY';
      const loc = await resolveLocationId(location);
      const out = await setVariantQuantity(variantId, qty, loc.id, policy);
      res.json({ ok: true, ...out, qty, location: loc.name });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
}
