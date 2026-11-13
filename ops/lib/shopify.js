// Minimal Shopify Admin GraphQL client + inventory helpers.
// Requires a custom-app token with:
//   read_products, write_products, read_inventory, write_inventory, read_locations

const STORE = process.env.SHOPIFY_STORE;                 // e.g. zaria-collections-2.myshopify.com
const STATIC_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;    // shpat_... (optional)
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;         // custom-app API key (optional)
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET; // custom-app secret shpss_... (optional)
const API_VER = process.env.SHOPIFY_API_VERSION || '2026-01';

if (!STORE || (!STATIC_TOKEN && !(CLIENT_ID && CLIENT_SECRET))) {
  console.warn('[shopify] set SHOPIFY_STORE + either SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET in .env');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token: use a static Admin token if given, otherwise exchange client credentials
// (cached, and refreshed once on a 401).
let cachedToken = STATIC_TOKEN || null;
async function getToken(force = false) {
  if (cachedToken && !force) return cachedToken;
  if (STATIC_TOKEN) { cachedToken = STATIC_TOKEN; return cachedToken; }
  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error('client_credentials token exchange failed: ' + JSON.stringify(j));
  cachedToken = j.access_token;
  return cachedToken;
}

export async function gql(query, variables = {}, tries = 0) {
  const token = await getToken();
  const res = await fetch(`https://${STORE}/admin/api/${API_VER}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && tries < 1) { await getToken(true); return gql(query, variables, tries + 1); }
  const json = await res.json().catch(() => ({}));
  const throttled = json.errors && JSON.stringify(json.errors).includes('THROTTLED');
  if ((res.status === 429 || throttled) && tries < 6) {
    await sleep(1000 * (tries + 1));
    return gql(query, variables, tries + 1);
  }
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/**
 * All store variants, keyed by barcode AND by SKU, so a sheet can identify an item by either.
 * Barcodes are claimed first: if some product's SKU happens to equal another's barcode, the
 * barcode wins rather than silently pointing the sheet at the wrong item.
 * SKUs are keyed lower-case; look them up with the same casing.
 */
export async function fetchVariantMap() {
  const map = new Map();
  const skus = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($c:String){ productVariants(first:200, after:$c){
         pageInfo{ hasNextPage endCursor }
         nodes{ id barcode sku inventoryPolicy inventoryQuantity
                product{ id title status }
                inventoryItem{ id tracked } } } }`,
      { c: cursor }
    );
    for (const v of data.productVariants.nodes) {
      if (v.barcode) map.set(String(v.barcode).trim(), v);
      if (v.sku) skus.push([String(v.sku).trim().toLowerCase(), v]);
    }
    cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (cursor);
  for (const [sku, v] of skus) if (!map.has(sku)) map.set(sku, v);
  return map;
}

/** Look a sheet code up as a barcode first, then as a SKU. */
export function findByCode(map, code) {
  const c = String(code == null ? '' : code).trim();
  if (!c) return undefined;
  return map.get(c) || map.get(c.toLowerCase());
}

/** Active locations; picks the preferred name if given, else the first. */
export async function getLocations() {
  const data = await gql(`{ locations(first:20){ nodes{ id name isActive } } }`);
  return data.locations.nodes.filter((l) => l.isActive);
}

export async function resolveLocationId(preferredName) {
  const locs = await getLocations();
  if (!locs.length) throw new Error('No active locations found (check read_locations scope).');
  if (preferredName) {
    const m = locs.find((l) => l.name.toLowerCase() === String(preferredName).toLowerCase());
    if (m) return { id: m.id, name: m.name };
  }
  return { id: locs[0].id, name: locs[0].name };
}

/** Enable tracking + set inventory policy + set the available quantity for one variant. */
async function applyOne(v, qty, locationId, policy) {
  const invItemId = v.inventoryItem.id;

  if (!v.inventoryItem.tracked) {
    await gql(
      `mutation($id:ID!){ inventoryItemUpdate(id:$id, input:{ tracked:true }){ userErrors{ message } } }`,
      { id: invItemId }
    );
  }

  // Cloth is reordered rather than discontinued, and a brief may ask for more than the bolt
  // holds, so a fabric always keeps selling past its count. What stops a sale is the count
  // reaching zero, which the storefront handles by saying "Available soon" and taking the
  // buying away. A sheet uploaded with "stop selling" would otherwise refuse every order
  // longer than the bolt.
  if (isCloth(v)) policy = 'CONTINUE';

  if (v.inventoryPolicy !== policy) {
    await gql(
      `mutation($pid:ID!,$vid:ID!,$pol:ProductVariantInventoryPolicy!){
         productVariantsBulkUpdate(productId:$pid, variants:[{ id:$vid, inventoryPolicy:$pol }]){ userErrors{ message } } }`,
      { pid: v.product.id, vid: v.id, pol: policy }
    );
  }

  // Make sure the item is stocked at this location (no-op if already active).
  await gql(
    `mutation($i:ID!,$l:ID!){ inventoryActivate(inventoryItemId:$i, locationId:$l){ userErrors{ message } } }`,
    { i: invItemId, l: locationId }
  ).catch(() => {});

  const setRes = await gql(
    `mutation($in:InventorySetQuantitiesInput!){
       inventorySetQuantities(input:$in){ userErrors{ field message } } }`,
    { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true,
            quantities: [{ inventoryItemId: invItemId, locationId, quantity: qty }] } }
  );
  const errs = setRes.inventorySetQuantities.userErrors;
  if (errs && errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/**
 * Apply a list of matched items. `policy` is 'DENY' (stop selling at 0) or 'CONTINUE'.
 * Runs with a small concurrency so ~400 items finish in a couple of minutes without tripping limits.
 */
export async function applyInventory(matched, locationId, policy, onProgress) {
  const updated = [];
  const failed = [];
  const CONCURRENCY = 4;
  let idx = 0;

  async function worker() {
    while (idx < matched.length) {
      const i = idx++;
      const m = matched[i];
      try {
        await applyOne(m.variant, m.qty, locationId, policy);
        updated.push({ barcode: m.barcode, qty: m.qty });
      } catch (e) {
        failed.push({ barcode: m.barcode, name: m.name, error: String(e.message || e) });
      }
      if (onProgress) onProgress(updated.length + failed.length, matched.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { updated, failed };
}

/**
 * Find variants by product name, barcode or SKU, with the stock each one holds at a location.
 * One free-text query covers all three — Shopify's variant search indexes barcode and SKU
 * alongside the product title.
 */
export async function searchVariants(term, locationId, limit = 25) {
  const q = String(term || '').trim();
  if (!q) return [];

  const run = (query) => gql(
    `query($q:String!,$loc:ID!,$n:Int!){ productVariants(first:$n, query:$q){
       nodes{ id title barcode sku inventoryPolicy
         product{ id title status }
         inventoryItem{ id tracked
           inventoryLevel(locationId:$loc){ quantities(names:["available"]){ quantity } } } } } }`,
    { q: query, loc: locationId, n: limit }
  );

  let data = await run(q);
  // Nothing on the exact term? Retry as a prefix, so half a barcode or half a name still finds it.
  if (!data.productVariants.nodes.length && !q.includes('*')) data = await run(q + '*');

  return data.productVariants.nodes.map((v) => ({
    variantId: v.id,
    title: v.product.title,
    variantTitle: v.title && v.title !== 'Default Title' ? v.title : '',
    status: v.product.status,
    barcode: v.barcode || '',
    sku: v.sku || '',
    tracked: v.inventoryItem.tracked,
    available: v.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity ?? null,
  }));
}

/** Set the stock of ONE variant by hand. Same write path the sheet import uses. */
export async function setVariantQuantity(variantId, qty, locationId, policy) {
  const data = await gql(
    `query($id:ID!){ productVariant(id:$id){
       id barcode inventoryPolicy product{ id title } inventoryItem{ id tracked } } }`,
    { id: variantId }
  );
  const v = data.productVariant;
  if (!v) throw new Error('That item no longer exists.');
  await applyOne(v, qty, locationId, policy);
  return { title: v.product.title, barcode: v.barcode || '' };
}

/**
 * Set a list of variants to zero. Used for store items the SOH sheet never mentions:
 * if the warehouse did not count it, it is not on the shelf.
 * Takes the same variant objects fetchVariantMap returns, so it reuses applyOne and
 * therefore turns tracking on and applies the sold-out policy exactly like an import.
 */
export async function zeroVariants(variants, locationId, policy, onProgress) {
  const updated = [];
  const failed = [];
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < variants.length) {
      const v = variants[idx++];
      try {
        await applyOne(v, 0, locationId, policy);
        updated.push({ barcode: v.barcode || '', title: v.product?.title || '' });
      } catch (e) {
        failed.push({ barcode: v.barcode || '', name: v.product?.title || '', error: String(e.message || e) });
      }
      if (onProgress) onProgress(updated.length + failed.length, variants.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { updated, failed };
}
