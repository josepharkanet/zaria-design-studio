// Dispatch: invoice + shipping label for Shopify orders.
// Zaria is not VAT registered, so nothing here splits net from VAT and the document
// is an Invoice, not a Tax Invoice. Prices are simply what the customer paid.
// Mounted into the Inventory & Dispatch app (reuses its Shopify token via gql()).
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql } from './shopify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---- Company / branding ---------------------------------------------------
const COMPANY = {
  brandName: 'Zaria',
  legal: 'Zaria Fashion FZE',
  addr1: 'Block B-B58-155, Sharjah Research Technology and Innovation Park',
  addr2: 'Sharjah, United Arab Emirates',
  email: 'hello@zaria.ae',
  web: 'www.zaria.ae',
  phone: process.env.COMPANY_PHONE || '',
  licence: process.env.COMPANY_LICENCE || '11696',
};

// ---- Quiqup courier API (create job, release, label PDF, cancel) -----------
// Last-mile API. Two ways in, and the docs say to prefer the first:
//   1. QUIQUP_TOKEN  — a Bearer key generated in Quiqdash (Organization > API keys).
//      Self-serve and immediate. Set its expiry to Never; a key made with a duration
//      is the usual cause of an integration that works and then 401s out of nowhere.
//   2. QUIQUP_CLIENT_ID / _SECRET — OAuth2, issued by Quiqup support only, exchanged
//      at /oauth/token. The token lasts seven days, not the hour one might assume.
// Either credential works on both of Quiqup's APIs and on either environment, but a
// credential is tied to the environment it was made on: a staging key will not
// authenticate against production.
// QUIQUP_BASE DEFAULTS TO STAGING on purpose: a mistake in development must not put a
// real driver on a real road.
const QUIQUP = {
  base: (process.env.QUIQUP_BASE || 'https://api.staging.quiqup.com').replace(/\/+$/, ''),
  token: (process.env.QUIQUP_TOKEN || '').trim(),
  id: process.env.QUIQUP_CLIENT_ID || '',
  secret: process.env.QUIQUP_CLIENT_SECRET || '',
  // Same Day, Next Day, 4-hour and export are each enabled per account by the account
  // manager, and only Same Day is checked at creation, so a wrong kind here fails late
  // rather than at the API. Confirm the account has this service before going live.
  kind: process.env.QUIQUP_KIND || 'partner_4hr',
  shipper: {
    name: process.env.SHIPPER_NAME || COMPANY.legal,
    phone: process.env.SHIPPER_PHONE || '',
    addr1: process.env.SHIPPER_ADDR1 || '',
    city: process.env.SHIPPER_CITY || 'Dubai',
    country: process.env.SHIPPER_COUNTRY || 'AE',
  },
};
const quiqupLive = () => /api-ae\.quiqup\.com/.test(QUIQUP.base);

// Quiqup treats `uuid` as the idempotency key: resending one returns the original
// job instead of creating a second. Deriving it from the Shopify order id rather than
// generating a random one means a double click, a retry, or a wiped data file can
// never double-book. The local record is bookkeeping; this is the real guarantee.
const UUID_NS = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'); // RFC 4122 URL namespace
function orderUuid(orderId) {
  const h = crypto.createHash('sha1').update(Buffer.concat([UUID_NS, Buffer.from(String(orderId), 'utf8')])).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// A Quiqdash key is the bearer token as-is, with no exchange and nothing to refresh.
// Only the OAuth pair needs the round trip, and its token is cached until just before
// it expires.
let qToken = { value: '', expires: 0 };
async function quiqupToken(force = false) {
  if (QUIQUP.token) return QUIQUP.token;
  if (!QUIQUP.id || !QUIQUP.secret) throw new Error('Set QUIQUP_TOKEN (a Quiqdash API key), or QUIQUP_CLIENT_ID and QUIQUP_CLIENT_SECRET.');
  if (!force && qToken.value && Date.now() < qToken.expires) return qToken.value;
  const r = await fetch(`${QUIQUP.base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: QUIQUP.id, client_secret: QUIQUP.secret }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Quiqup auth ${r.status}: ${txt.slice(0, 300)}`);
  let d; try { d = JSON.parse(txt); } catch { throw new Error('Quiqup auth returned non-JSON: ' + txt.slice(0, 200)); }
  const tok = d.access_token || d.token;
  if (!tok) throw new Error('Quiqup auth returned no access_token: ' + txt.slice(0, 200));
  // Renew a minute early so a request never travels with a token that expires mid-flight.
  qToken = { value: tok, expires: Date.now() + (Number(d.expires_in || 604800) - 60) * 1000 };
  return tok;
}

// Every Quiqup call goes through here so the 401-refresh-retry happens in one place.
async function quiqup(method, pathname, body, { raw = false } = {}) {
  const send = async (tok) => fetch(`${QUIQUP.base}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let r = await send(await quiqupToken());
  // A 401 on an OAuth token is worth one refresh. On a Quiqdash key it means the key
  // is wrong, revoked, or was created with an expiry, so there is nothing to retry.
  if (r.status === 401 && !QUIQUP.token) r = await send(await quiqupToken(true));
  if (raw) return r;
  const txt = await r.text();
  if (!r.ok) throw new Error(`Quiqup ${method} ${pathname} ${r.status}: ${txt.slice(0, 400)}`);
  try { return txt ? JSON.parse(txt) : {}; } catch { return { raw: txt.slice(0, 300) }; }
}

const QUIQUP_TRACK_TPL = process.env.QUIQUP_TRACK_URL || 'https://quiqup.com/track/{awb}';
const quiqupTrackUrl = (awb) => QUIQUP_TRACK_TPL.replace('{awb}', encodeURIComponent(String(awb || '')));
// Zaria is black on white with no accent colour: the storefront's footer sets the house
// style and it carries none. BRAND_ACCENT stays overridable, but the default is ink.
const ACCENT = process.env.BRAND_ACCENT || '#111111';
const PREFIX = process.env.INVOICE_PREFIX || 'ZA';
const SEQ_PAD = parseInt(process.env.INVOICE_PAD || '4', 10);
const SEQ_START = parseInt(process.env.INVOICE_START || '1', 10);

// ---- helpers --------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n2 = (x) => Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (x, cur = 'AED') => `${n2(x)} ${cur}`;
function fmtDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
// Order list: relative time + DD/MM/YY (date in the store's Dubai timezone).
function relDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = Math.max(0, Date.now() - d.getTime());
  const min = Math.floor(diff / 60000), hr = Math.floor(diff / 3600000), day = Math.floor(diff / 86400000);
  let rel;
  if (min < 1) rel = 'just now';
  else if (min < 60) rel = min + (min === 1 ? ' min ago' : ' mins ago');
  else if (hr < 24) rel = hr + (hr === 1 ? ' hr ago' : ' hrs ago');
  else if (day < 30) rel = day + (day === 1 ? ' day ago' : ' days ago');
  else { const mo = Math.floor(day / 30); rel = mo + (mo === 1 ? ' mo ago' : ' mos ago'); }
  const dstr = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: '2-digit', year: '2-digit' });
  return rel + ' · ' + dstr;
}
function logoDataUri() {
  try { return 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'zaria-logo.png')).toString('base64'); }
  catch { return ''; }
}
function words(n) {
  const ones = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function below1000(x) {
    let s = '';
    if (x >= 100) { s += ones[Math.floor(x / 100)] + ' Hundred'; x %= 100; if (x) s += ' And '; }
    if (x >= 20) { s += tens[Math.floor(x / 10)]; if (x % 10) s += '-' + ones[x % 10]; }
    else if (x > 0) { s += ones[x]; }
    return s;
  }
  n = Math.floor(n);
  if (n === 0) return 'Zero';
  let out = '';
  for (const [name, val] of [['Billion', 1e9], ['Million', 1e6], ['Thousand', 1e3]]) {
    if (n >= val) { out += (out ? ' ' : '') + below1000(Math.floor(n / val)) + ' ' + name; n %= val; }
  }
  if (n > 0) out += (out ? ' ' : '') + below1000(n);
  return out.trim();
}
function amountInWords(amount) {
  const whole = Math.floor(amount + 1e-9);
  const frac = Math.round((amount - whole) * 100);
  let s = words(whole) + ' Dirham';
  if (frac > 0) s += ' and ' + words(frac) + ' Fils';
  return s;
}

// ---- numbering (file-backed; mount a volume at DATA_DIR to persist) --------
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'dispatch.json');
function loadDb() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { nextSeq: SEQ_START, orders: {} }; } }
function saveDb(db) {
  // Say which directory is at fault. An unmounted or read-only DATA_DIR used to surface as a
  // bare ENOENT from writeFileSync, several frames from anything that names the volume, on
  // the first invoice rather than at boot.
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { throw new Error(`Cannot write ${DB_FILE}: ${e.code || e.message}. DATA_DIR must exist and be writable, or invoice numbers and courier bookings are lost.`); }
}
// Check it once at boot, so a misconfigured volume is a line in the startup log rather than
// a 500 the first time someone prints an invoice.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.warn(`[dispatch] DATA_DIR ${DATA_DIR} is not writable (${e.code || e.message}). Invoice numbers and courier bookings will not persist.`);
}
let db = loadDb();
function peekNo(orderId) { return db.orders[orderId] || null; }
function assignNo(orderId, createdAtISO) {
  // One number per order, handed out in order of first printing and never reused.
  const existing = db.orders[orderId];
  if (existing) return existing;
  const seq = Number.isFinite(db.nextSeq) ? db.nextSeq : SEQ_START;
  const rec = { invoiceNo: PREFIX + String(seq).padStart(SEQ_PAD, '0'), seq, invoiceDate: fmtDate(createdAtISO) };
  db.orders[orderId] = rec; db.nextSeq = seq + 1; saveDb(db);
  return rec;
}

// Invoice numbers run as a plain sequence from ZA0001, assigned the first time an order's
// invoice is drawn and then frozen, so reprinting never moves a number. The counter lives in
// the data file, which is why DATA_DIR must be a persistent volume in production.
async function resolveNo(order) {
  return assignNo(order.id, order.createdAt);
}

// ---- Shopify order reads --------------------------------------------------
const ORDER_FIELDS = `
  id name createdAt currencyCode taxesIncluded displayFinancialStatus paymentGatewayNames
  totalPriceSet{ shopMoney{ amount currencyCode } }
  totalShippingPriceSet{ shopMoney{ amount } }
  totalDiscountsSet{ shopMoney{ amount } }
  totalTaxSet{ shopMoney{ amount } }
  discountCodes
  shippingAddress{ name address1 address2 city province country phone zip }
  billingAddress{ name address1 address2 city province country phone zip }
  email customer{ displayName email }
  customAttributes{ key value }
  lineItems(first:100){ nodes{ title quantity
    variant{ barcode sku product{
      brandRef: metafield(namespace:"custom",key:"brand"){ reference{ ... on Metaobject{ field(key:"name"){ value } } } }
      brandDesc: metafield(namespace:"global",key:"description_tag"){ value } } }
    originalUnitPriceSet{ shopMoney{ amount } } originalTotalSet{ shopMoney{ amount } } discountedTotalSet{ shopMoney{ amount } }
    discountAllocations{ allocatedAmountSet{ shopMoney{ amount } } } } }`;

async function recentOrders(limit = 30) {
  const d = await gql(`query($n:Int!){ orders(first:$n, sortKey:CREATED_AT, reverse:true){ nodes{
    id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{ shopMoney{ amount currencyCode } } customer{ displayName } customAttributes{ key value } } } }`, { n: limit });
  return d.orders.nodes;
}
// Order names on this store carry a space ("EL 1042"), so the name MUST be quoted in the
// search query. Unquoted, the space splits it into `name:#EL` plus a loose `1042`, and that
// loose term full-text matches any order with 1042 anywhere in it (EL 1037's street number,
// for one) and can outrank the real order, so `first:1` served the wrong invoice. Quoted, it
// stays one phrase match on the name. The exact-name check is the backstop: never hand back
// an order we were not asked for, because the caller may print its label or book its courier.
async function orderByName(name) {
  const clean = String(name).replace(/^#/, '').replace(/"/g, '').trim();
  const d = await gql(`query($q:String!){ orders(first:5, query:$q){ nodes{ ${ORDER_FIELDS} } } }`, { q: `name:"#${clean}"` });
  const nodes = d.orders.nodes || [];
  const key = (s) => String(s || '').replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
  const exact = nodes.find((n) => key(n.name) === key(clean));
  // A bare number typed into the search box ("1042") never equals the full name, but a quoted
  // search returning exactly one order is unambiguous, so scanning a bare number still works.
  return exact || (nodes.length === 1 ? nodes[0] : null);
}
async function orderById(numericId) {
  const d = await gql(`query($id:ID!){ order(id:$id){ ${ORDER_FIELDS} } }`, { id: `gid://shopify/Order/${String(numericId).replace(/\D/g, '')}` });
  return d.order;
}

// Brands whose own capitalisation title-casing would get wrong.
const GATEWAY_NAMES = { paypal: 'PayPal', applepay: 'Apple Pay', apple_pay: 'Apple Pay',
  googlepay: 'Google Pay', google_pay: 'Google Pay', shop_pay: 'Shop Pay', shopify_payments: 'Shopify Payments' };

// Shopify hands back gateway handles, so the invoice was printing "shopify_payments" at
// the customer. Make them readable without inventing a payment method that was not used.
function prettyGateway(names) {
  return String(names || '').split(',').map((g) => g.trim()).filter(Boolean)
    .map((g) => GATEWAY_NAMES[g.toLowerCase()]
      || g.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(', ');
}

function normalize(order, invoiceNo, invoiceDate) {
  const m = (s) => (s && s.shopMoney ? Number(s.shopMoney.amount) : 0);
  const gateways = (order.paymentGatewayNames || []).join(', ');
  const isCOD = /cash on delivery|cod/i.test(gateways);
  const total = m(order.totalPriceSet);
  const ca = order.customAttributes || [];
  const giftWrap = ca.some((a) => a.key === 'Gift wrap' && String(a.value).toLowerCase() === 'yes');
  const giftMsg = (ca.find((a) => a.key === 'Greeting card message') || {}).value || '';
  return {
    id: order.id, name: order.name, email: order.email || order.customer?.email || '', invoice_no: invoiceNo, gift_wrap: giftWrap, gift_message: giftMsg,
    invoice_date: invoiceDate || fmtDate(order.createdAt), created_at: fmtDate(order.createdAt),
    currency: order.totalPriceSet?.shopMoney?.currencyCode || order.currencyCode || 'AED',
    taxes_included: order.taxesIncluded !== false,
    payment: isCOD ? 'Cash on Delivery' : (prettyGateway(gateways) || order.displayFinancialStatus || ''),
    shipping: m(order.totalShippingPriceSet), cod_amount: isCOD ? total : 0, total: total,
    order_discount: m(order.totalDiscountsSet), order_tax: m(order.totalTaxSet),
    discount_codes: (order.discountCodes || []).filter(Boolean),
    shipping_address: order.shippingAddress || order.billingAddress || {},
    line_items: (order.lineItems?.nodes || []).map((li) => {
      const orig = m(li.originalTotalSet);
      const v = li.variant || {};
      const p = v.product || {};
      let brand = p.brandRef?.reference?.field?.value || '';        // canonical (needs read_metaobjects)
            const brandName = brand;
      const allocated = (li.discountAllocations || []).reduce((a, x) => a + m(x.allocatedAmountSet), 0);
      // Allocations cover BOTH per-line and order-level discounts, so they are the single
      // source of truth; deriving it from discountedTotalSet alone misses voucher codes.
      const lineDiscount = allocated > 0 ? allocated : Math.max(0, orig - m(li.discountedTotalSet));
      return { barcode: v.barcode || '', sku: v.sku || '', brand: brandName, title: li.title, quantity: li.quantity,
        unit_price: m(li.originalUnitPriceSet), discount: lineDiscount };
    }),
  };
}

// ---- invoice + label render ----------------------------------------------
function computeLine(li) {
  const qty = Number(li.quantity || 1);
  const gross0 = Number(li.unit_price || 0) * qty;
  const amount = Math.max(0, gross0 - Number(li.discount || 0));
  // A fee/charge (COD fee etc.) isn't a product: no code + fee-ish name -> hide qty/unit/disc.
  const code = li.barcode || li.sku || '';
  const isCharge = !code && /\b(fee|charge|surcharge|cod|handling|delivery|tip|gratuity)\b/i.test(li.title || '');
  // The Amount column carries the GROSS line, and discounts are taken off once in the totals
  // block. Netting them off here as well made the column sum to the Total while the Subtotal
  // printed beside it was the gross figure, so a discounted invoice could not be added up.
  return { barcode: code, brand: li.brand || '', title: li.title || '', qty, unit: Number(li.unit_price || 0), isCharge,
    discPct: gross0 > 0 ? (Number(li.discount || 0) / gross0) * 100 : 0, gross: gross0, amount };
}

function renderInvoice(order) {
  const cur = order.currency || 'AED';
  const lines = (order.line_items || []).map((li) => computeLine(li));
  // Shipping is normally 0 (the store ships free); itemise it only when a
  // charge was actually applied, so the invoice total matches what was paid.
  const shipGross = Number(order.shipping || 0);
  // Discount taken off the order, shown so the invoice explains the figure that was charged.
  const discTotal = (order.line_items || []).reduce((a, li) => a + Number(li.discount || 0), 0);
  const subtotal = lines.reduce((a, l) => a + l.gross, 0) + shipGross;
  const total = subtotal - discTotal;
  const codes = (order.discount_codes || []).join(', ');
  const totalQty = lines.reduce((a, l) => a + (l.isCharge ? 0 : l.qty), 0);
  const sa = order.shipping_address || {};
  const addr = [sa.address1, sa.address2, [sa.city, sa.province].filter(Boolean).join(', '), sa.country, sa.phone].filter(Boolean);
  const rows = lines.map((l) => `<tr><td class="bc-cell">${l.barcode ? `<svg class="prod-barcode" data-barcode="${esc(l.barcode)}"></svg><span class="bc-num">${esc(l.barcode)}</span>` : ''}</td><td class="desc">${l.brand ? `<span class="li-brand">${esc(l.brand)}</span>` : ''}${esc(l.title)}</td><td class="r">${l.isCharge ? '' : l.qty.toFixed(2)}</td><td class="r">${l.isCharge ? '' : n2(l.unit)}</td><td class="r">${money(l.gross, cur)}</td></tr>`).join('');
  const shipRow = shipGross > 0 ? `<tr><td class="mono"></td><td class="desc">Shipping</td><td class="r">1.00</td><td class="r">${n2(shipGross)}</td><td class="r">${money(shipGross, cur)}</td></tr>` : '';
  const logo = logoDataUri();
  return `<section class="doc invoice">
  <header class="inv-head">
    <div class="brand">${logo ? `<img class="logo" src="${logo}" alt="Zaria">` : `<div class="wordmark">Zaria</div>`}
      <div class="legal"><strong>${esc(COMPANY.legal)}</strong><br>${esc(COMPANY.addr1)}<br>${esc(COMPANY.addr2)}</div></div>
    <div class="title-box"><div class="title">INVOICE</div>
      <table class="meta"><tr><td>Invoice No</td><th>${esc(order.invoice_no || '')}</th></tr><tr><td>Invoice Date</td><th>${esc(order.invoice_date || '')}</th></tr><tr><td>Order Ref</td><th>${esc(order.name || '')}</th></tr><tr><td>Payment</td><th>${esc(order.payment || '')}</th></tr></table><svg class="barcode inv-barcode" preserveAspectRatio="none" data-barcode="${esc((order.name || '').replace('#', '') || order.invoice_no || '')}"></svg></div>
  </header>
  <div class="parties"><div class="bill"><div class="lbl">Bill To</div><strong>${esc(sa.name || 'Walk-in Customer')}</strong>${addr.map((x) => `<div>${esc(x)}</div>`).join('')}</div><div class="qty-note">Total Quantity: ${totalQty.toFixed(2)} Units</div></div>
  <table class="items"><thead><tr><th>Barcode</th><th class="desc">Description</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Amount</th></tr></thead><tbody>${rows}${shipRow}</tbody></table>
  <div class="foot-grid"><div class="words"><div class="lbl">Total amount in words</div><div class="words-val">${esc(amountInWords(total))}</div><div class="inv-note">This is a system-generated invoice and requires no signature.<br>For terms &amp; conditions, visit ${esc(COMPANY.web)}/terms</div></div>
    <table class="totals">${discTotal > 0.004 ? `<tr><td>Subtotal</td><th>${money(subtotal, cur)}</th></tr><tr class="disc"><td>Discount${codes ? ` <span class="disc-code">${esc(codes)}</span>` : ''}</td><th>&minus;${money(discTotal, cur)}</th></tr>` : ''}<tr class="grand"><td>Total</td><th>${money(total, cur)}</th></tr></table></div>
  <div class="inv-bottom"><div class="inv-thanks">Thank you for choosing Zaria</div>
  <footer class="inv-foot">${[COMPANY.web, COMPANY.email, COMPANY.phone].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ')}</footer></div>
</section>`;
}

function renderLabel(order) {
  const sa = order.shipping_address || {};
  const addr = [sa.address1, sa.address2, [sa.city, sa.province].filter(Boolean).join(', '), sa.country].filter(Boolean);
  const cod = order.cod_amount ? money(order.cod_amount, order.currency || 'AED') : '';
  const itemCount = (order.line_items || []).reduce((a, l) => a + Number(l.quantity || 1), 0);
  const barcodeVal = (order.name || '').replace('#', '') || '';
  const logo = logoDataUri();
  return `<section class="doc label">
  <div class="lbl-head">${logo ? `<img class="lbl-logo" src="${logo}">` : `<div class="wordmark">Zaria</div>`}<div class="lbl-order">Order ${esc(order.name || '')}</div></div>
  <div class="lbl-from"><span>From:</span> ${esc(COMPANY.legal)}, ${esc(COMPANY.addr1)}, ${esc(COMPANY.addr2)}</div>
  <div class="lbl-to"><div class="lbl-to-tag">DELIVER TO</div><div class="lbl-name">${esc(sa.name || '')}</div>${addr.map((x) => `<div class="lbl-addr">${esc(x)}</div>`).join('')}${sa.phone ? `<div class="lbl-phone">${esc(sa.phone)}</div>` : ''}</div>
  <div class="lbl-meta"><div>Items: <strong>${itemCount}</strong></div>${cod ? `<div class="cod">COD ${esc(cod)}</div>` : `<div class="prepaid">PREPAID</div>`}</div>
  <svg class="barcode" data-barcode="${esc(barcodeVal)}"></svg><div class="lbl-barnum">${esc(order.name || barcodeVal)}</div>
</section>`;
}

// ---- pickup / packing slip (warehouse pick list) --------------------------
function renderPickupSlip(order) {
  const sa = order.shipping_address || {};
  const items = (order.line_items || []).filter((li) => {
    const code = li.barcode || li.sku || '';
    return !(!code && /\b(fee|charge|surcharge|cod|handling|delivery|tip|gratuity)\b/i.test(li.title || ''));
  });
  const totalQty = items.reduce((a, l) => a + Number(l.quantity || 1), 0);
  const rows = items.map((l, i) => `<tr><td class="c">${i + 1}</td><td class="pk-brand">${esc(l.brand || '')}</td><td class="desc">${esc(l.title || '')}</td><td class="mono">${esc(l.sku || '')}</td><td class="pk-bc">${l.barcode ? `<svg class="prod-barcode" data-barcode="${esc(l.barcode)}"></svg><span class="bc-num">${esc(l.barcode)}</span>` : (l.sku ? `<span class="bc-num">${esc(l.sku)}</span>` : '')}</td><td class="c pk-qty">${Number(l.quantity || 1)}</td><td class="c"><span class="pk-box"></span></td></tr>`).join('');
  const logo = logoDataUri();
  return `<section class="doc pickup">
  <header class="pk-head">
    <div class="brand">${logo ? `<img class="logo" src="${logo}" alt="Zaria">` : `<div class="wordmark">Zaria</div>`}</div>
    <div class="title-box"><div class="title">PICKUP SLIP</div>
      <table class="meta"><tr><td>Order</td><th>${esc(order.name || '')}</th></tr><tr><td>Date</td><th>${esc(order.invoice_date || order.created_at || '')}</th></tr><tr><td>Customer</td><th>${esc(sa.name || '')}</th></tr><tr><td>Total</td><th>${totalQty} unit(s)</th></tr>${order.gift_wrap ? '<tr><td>Gift wrap</td><th class="pk-gift">YES</th></tr>' : ''}</table></div>
  </header>
  <table class="items pk-items"><thead><tr><th class="c">#</th><th>Brand</th><th class="desc">Product</th><th>SKU</th><th>Barcode</th><th class="c">Qty</th><th class="c">Picked</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="pk-foot"><span>Picked by ______________________</span><span>Checked by ______________________</span><span>${esc(order.name || '')}</span></div>
</section>`;
}

// ---- greeting card templates (message = the customer's own content) -------
const GOLD_CORNER = `<svg viewBox="0 0 44 44" fill="none" stroke="#C79A6B" stroke-width="1.3" stroke-linecap="round"><path d="M3 16 V3 H16"/><path d="M8 19 V8 H19"/><circle cx="5" cy="5" r="1.5" fill="#C79A6B" stroke="none"/></svg>`;
const SPRIG_SVG = `<svg viewBox="0 0 120 120" fill="none" stroke="#111111" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10 112 C 36 92 54 64 62 30"/><path d="M25 94 C 12 92 8 81 17 77 C 26 81 30 90 25 94 Z" fill="#111111" fill-opacity=".12"/><path d="M35 79 C 46 73 57 75 55 84 C 46 90 37 87 35 79 Z" fill="#111111" fill-opacity=".12"/><path d="M43 62 C 30 60 26 49 35 45 C 44 49 48 58 43 62 Z" fill="#111111" fill-opacity=".12"/><path d="M51 46 C 62 40 73 42 71 51 C 62 57 53 54 51 46 Z" fill="#111111" fill-opacity=".12"/><g transform="translate(62 28)"><path d="M0 -5 C 6 -11 14 -7 9 0 C 14 7 6 11 0 5 C -6 11 -14 7 -9 0 C -14 -7 -6 -11 0 -5 Z" fill="#111111" fill-opacity=".18" stroke-width="1.1"/><circle r="2" fill="#111111" stroke="none"/></g></svg>`;
const RIBBON_SVG = `<svg viewBox="0 0 120 420" preserveAspectRatio="xMidYMin meet" fill="none"><path d="M53 0 C 47 110 57 165 60 196" stroke="#111111" stroke-width="8"/><path d="M67 0 C 73 110 63 165 60 196" stroke="#111111" stroke-width="8"/><g fill="#111111"><path d="M60 197 C 33 171 6 180 13 204 C 20 227 49 216 60 205 Z"/><path d="M60 197 C 87 171 114 180 107 204 C 100 227 71 216 60 205 Z"/><path d="M55 205 L 42 262 L 56 246 Z"/><path d="M65 205 L 78 262 L 64 246 Z"/></g><ellipse cx="60" cy="201" rx="8" ry="11" fill="#000000"/></svg>`;

const CARD_TPLS = [['classic', 'Classic'], ['golden', 'Golden Frame'], ['botanical', 'Botanical'], ['gift', 'Gift Ribbon']];

function cardFontSize(len) {
  if (len <= 30) return 46;
  if (len <= 55) return 40;
  if (len <= 95) return 33;
  if (len <= 135) return 27;
  return 22;
}
function cardVariant(key, m, fs) {
  const brand = `<div class="card-foot"><span class="l"></span><span class="card-brand">Zaria</span><span class="l"></span></div>`;
  if (key === 'golden') {
    return `<span class="gc gc-tl">${GOLD_CORNER}</span><span class="gc gc-tr">${GOLD_CORNER}</span><span class="gc gc-bl">${GOLD_CORNER}</span><span class="gc gc-br">${GOLD_CORNER}</span><div class="gold-fr" aria-hidden="true"></div><div class="card-inner"><div class="card-top card-top--gold">A note, just for you</div><div class="card-msg" style="font-size:${fs}px">${m}</div>${brand}</div>`;
  }
  if (key === 'botanical') {
    return `<span class="sprig sprig-tl" aria-hidden="true">${SPRIG_SVG}</span><span class="sprig sprig-br" aria-hidden="true">${SPRIG_SVG}</span><div class="card-inner"><div class="card-top">With love</div><div class="card-msg" style="font-size:${fs}px">${m}</div>${brand}</div>`;
  }
  if (key === 'gift') {
    return `<div class="card-inner card-inner--gift"><div class="card-top">A gift, just for you</div><div class="card-msg" style="font-size:${fs}px">${m}</div>${brand}</div><span class="gift-ribbon" aria-hidden="true">${RIBBON_SVG}</span>`;
  }
  return `<div class="card-frame" aria-hidden="true"></div><div class="card-inner"><div class="card-top">A note, just for you</div><div class="card-msg" style="font-size:${fs}px">${m}</div>${brand}</div>`;
}

function renderCard(order, withPicker) {
  const msg = order.gift_message || '';
  if (!msg) return '';
  const m = esc(msg);
  const fs = cardFontSize(msg.length);
  if (!withPicker) {
    return `<section class="doc card card--classic on" data-tpl="classic">${cardVariant('classic', m, fs)}</section>`;
  }
  const picker = `<div class="cardpicker no-print"><span class="cardpick-lbl">Card design</span>${CARD_TPLS.map(([k, l], i) => `<button type="button" class="cardpick-btn${i === 0 ? ' on' : ''}" data-tpl="${k}" onclick="pickCard('${k}')">${esc(l)}</button>`).join('')}</div>`;
  const cards = CARD_TPLS.map(([k], i) => `<section class="doc card card--${k}${i === 0 ? ' on' : ''}" data-tpl="${k}">${cardVariant(k, m, fs)}</section>`).join('');
  return picker + cards;
}

function renderPrintPage(order) {
  // Saved-PDF filename = the invoice number (Chrome uses <title>); sanitise for filesystems.
  const docName = (order.invoice_no || order.name || 'Zaria').replace(/[\/\\:*?"<>|#]/g, '-');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Great+Vibes&family=Jost:wght@300;400;500;600&family=Playfair+Display:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="toolbar no-print"><div class="tb-title">Zaria Dispatch · ${esc(order.name || '')} · ${esc(order.invoice_no || '')}</div>
<div class="tb-actions"><a class="back" href="/dispatch">← Orders</a><button onclick="printSel('invoice')">Print Invoice · A4</button><button onclick="printSel('pickup')">Print Pickup Slip · A4</button><button onclick="printSel('label')">Print Label · A6</button>${order.gift_message ? `<button class="primary" onclick="printSel('card')">Print Card · A6</button>` : ''}<button class="cour primary" onclick="bookCourier(this)">Book Quiqup + Label</button><button class="cour-x" onclick="cancelCourier(this)">Cancel Quiqup</button><button class="cour-l" onclick="printCourierLabel()">Quiqup Label</button><button class="cour-t" onclick="trackCourier()">Track</button></div></div>
<main class="sheet">${renderInvoice(order)}${renderPickupSlip(order)}${renderLabel(order)}${renderCard(order, true)}</main>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<script>document.querySelectorAll('svg.barcode,svg.prod-barcode').forEach(function(el){var p=el.classList.contains('prod-barcode');try{JsBarcode(el,el.getAttribute('data-barcode')||'',{format:'CODE128',displayValue:false,margin:0,height:p?26:54,width:p?1.2:2});}catch(e){}});
var docBase=${JSON.stringify(docName)};
function printSel(c){var pg=document.getElementById('dynpage')||document.head.appendChild(Object.assign(document.createElement('style'),{id:'dynpage'}));pg.textContent='@page{size:'+(c==='invoice'||c==='pickup'?'A4':c==='card'?'126mm 97mm':'105mm 148mm')+';margin:0}';document.title=docBase+(c==='label'?' - Label':c==='card'?' - Card':c==='pickup'?' - Pickup Slip':'');document.body.classList.add('only-'+c);window.print();setTimeout(function(){document.body.classList.remove('only-'+c);document.title=docBase;},300);}
function pickCard(k){document.querySelectorAll('.card').forEach(function(c){c.classList.toggle('on',c.getAttribute('data-tpl')===k);});document.querySelectorAll('.cardpick-btn').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-tpl')===k);});}
var orderName=${JSON.stringify(order.name || '')};
function openPdf(b64){try{var bin=atob(b64),arr=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);var url=URL.createObjectURL(new Blob([arr],{type:'application/pdf'}));window.open(url,'_blank');}catch(e){alert('Could not open label PDF: '+e);}}
function courierUrl(sfx){return '/dispatch/courier/'+encodeURIComponent(orderName.replace(/^#/,''))+(sfx||'');}
function bookCourier(btn){
  if(!confirm('Book a Quiqup job for order '+orderName+'?\\n\\nThis releases it for collection and emails the customer their tracking.'))return;
  var t=btn.textContent;btn.disabled=true;btn.textContent='Booking…';
  fetch(courierUrl(),{method:'POST'}).then(function(r){return r.json();}).then(function(d){
    if(d.error){alert('Quiqup error: '+d.error);btn.disabled=false;btn.textContent=t;return;}
    btn.textContent='Quiqup '+d.awb+(d.emailed?' · emailed':'');
    if(!d.live)btn.textContent+=' (staging)';
    var warn=d.emailed?'':'\\n\\nNote: the customer dispatch email was NOT sent'+(d.emailError?' ('+d.emailError+')':'')+'.';
    if(d.cached){alert('Already booked. Job '+d.awb+'.'+warn);}else if(warn){alert('Booked job '+d.awb+'.'+warn);}
    window.open(courierUrl('/label'),'_blank');
  }).catch(function(e){alert('Quiqup request failed: '+e);btn.disabled=false;btn.textContent=t;});
}
function cancelCourier(btn){
  if(!confirm('Cancel the Quiqup job for order '+orderName+'?'))return;
  var t=btn.textContent;btn.disabled=true;btn.textContent='Cancelling…';
  fetch(courierUrl('/cancel'),{method:'POST'}).then(function(r){return r.json();}).then(function(d){
    btn.disabled=false;btn.textContent=t;
    if(d.error){alert('Cancel failed: '+d.error);return;}
    alert('Cancelled job '+d.awb+(d.message?' ('+d.message+')':''));
  }).catch(function(e){btn.disabled=false;btn.textContent=t;alert('Cancel request failed: '+e);});
}
function printCourierLabel(){window.open(courierUrl('/label'),'_blank');}
function trackCourier(){
  fetch(courierUrl('/track')).then(function(r){return r.json();}).then(function(d){
    if(d.error){alert('Track: '+d.error);return;}
    alert('Quiqup job '+d.awb+'\\nStatus: '+(d.state||d.status||'unknown'));
  }).catch(function(e){alert('Track failed: '+e);});
}</script>
</body></html>`;
}

// ---- embedded home (order search + recent list) ---------------------------
const GIFT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>`;

function renderHome(orders, err) {
  const list = orders || [];
  // Top filter chips: count orders per financial status (+ a Gift chip).
  const statusCount = {};
  let giftCount = 0;
  list.forEach((o) => {
    const s = (o.displayFinancialStatus || '').toUpperCase();
    if (s) statusCount[s] = (statusCount[s] || 0) + 1;
    const a = o.customAttributes || [];
    if (a.some((x) => x.key === 'Gift wrap' && String(x.value).toLowerCase() === 'yes') || a.some((x) => x.key === 'Greeting card message' && x.value)) giftCount++;
  });
  const STATUS_ORDER = ['PAID', 'PARTIALLY_PAID', 'AUTHORIZED', 'PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED', 'EXPIRED'];
  const present = Object.keys(statusCount).sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a), ib = STATUS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const nice = (s) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
  const chip = (f, label, count, extra) => `<button type="button" class="fchip${f === 'all' ? ' on' : ''}${extra || ''}" data-f="${esc(f)}">${esc(label)}<span class="fc">${count}</span></button>`;

  // Whether an order has shipped is the question this page exists to answer, so it gets its
  // own group rather than being mixed in with how it was paid for.
  const ful = { UNFULFILLED: 0, PARTIALLY_FULFILLED: 0, FULFILLED: 0 };
  list.forEach((o) => { const f = (o.displayFulfillmentStatus || '').toUpperCase(); if (f in ful) ful[f]++; });

  let chips = chip('all', 'All', list.length);
  if (ful.UNFULFILLED) chips += chip('fl:unfulfilled', 'To dispatch', ful.UNFULFILLED, ' fchip-todo');
  if (ful.PARTIALLY_FULFILLED) chips += chip('fl:partially_fulfilled', 'Part sent', ful.PARTIALLY_FULFILLED);
  if (ful.FULFILLED) chips += chip('fl:fulfilled', 'Dispatched', ful.FULFILLED);
  present.forEach((s) => { chips += chip('st:' + s.toLowerCase(), nice(s), statusCount[s]); });
  if (giftCount) chips += chip('gift', 'Gift', giftCount, ' fchip-gift');

  const sorter = `<label class="sortbox">Sort
    <select id="sortsel">
      <option value="new">Newest first</option>
      <option value="old">Oldest first</option>
      <option value="hi">Value, high to low</option>
      <option value="lo">Value, low to high</option>
      <option value="cust">Customer A to Z</option>
    </select></label>`;

  const rows = list.map((o) => {
    const amt = o.totalPriceSet?.shopMoney;
    const fin = (o.displayFinancialStatus || '').toUpperCase();
    const done = peekNo(o.id)?.invoiceNo;
    const num = o.name.replace('#', '');
    // Gift wrap + greeting card come through as order note attributes (set in cart/PDP).
    const attrs = o.customAttributes || [];
    const gwOn = attrs.some((a) => a.key === 'Gift wrap' && String(a.value).toLowerCase() === 'yes');
    const gMsg = (attrs.find((a) => a.key === 'Greeting card message') || {}).value || '';
    const hasGift = gwOn || !!gMsg;
    const giftBtn = hasGift
      ? `<button type="button" class="giftbtn" title="Gift wrap${gMsg ? ' + message' : ''} — click to view" aria-label="Gift wrap details" onclick="var n=document.getElementById('gn-${esc(num)}');if(n){n.hidden=!n.hidden;}">${GIFT_SVG}</button>`
      : '';
    const giftNote = hasGift
      ? `<div class="giftnote" id="gn-${esc(num)}" hidden><span class="gn-ic">${GIFT_SVG}</span><div class="gn-body"><strong>Gift wrap requested</strong>${gMsg ? `<div class="gn-msg">${esc(gMsg)}</div>` : ` <span class="gn-dim">— no card message</span>`}</div></div>`
      : '';
    const ff = (o.displayFulfillmentStatus || '').toUpperCase();
    const shipped = ff === 'FULFILLED';
    const fLabel = shipped ? 'Dispatched' : (ff === 'PARTIALLY_FULFILLED' ? 'Part sent' : 'To dispatch');
    // Only offered while something is still open to fulfil, so the button never promises
    // an action Shopify would refuse.
    const markBtn = shipped ? '' :
      `<button type="button" class="markbtn" data-order="${esc(num)}" title="Mark this order dispatched in Shopify">Mark sent</button>`;
    return `<div class="row" data-status="${esc(fin.toLowerCase())}" data-ful="${esc(ff.toLowerCase())}" data-gift="${hasGift ? '1' : '0'}" data-date="${esc(o.createdAt || '')}" data-amt="${esc(String(amt ? Number(amt.amount) : 0))}" data-cust="${esc((o.customer?.displayName || 'Guest').toLowerCase())}">
      <input type="checkbox" class="sel" value="${esc(num)}" aria-label="Select ${esc(o.name)}">
      <a class="rowlink" href="/dispatch/o/${encodeURIComponent(num)}" target="_blank" rel="noopener">
        <span class="nm">${esc(o.name)}</span><span class="date">${esc(relDate(o.createdAt))}</span><span class="cust">${esc(o.customer?.displayName || 'Guest')}</span>
        ${done ? `<span class="pill done">${esc(done)}</span>` : ''}
        <span class="pill ${shipped ? 'sent' : 'todo'}">${esc(fLabel)}</span>
        <span class="pill ${fin === 'PAID' ? 'paid' : (fin ? 'pend' : '')}">${esc(fin || '—')}</span>
        <span class="amt">${amt ? esc(Number(amt.amount).toFixed(2) + ' ' + amt.currencyCode) : ''}</span></a>${markBtn}${giftBtn}</div>${giftNote}`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatch — Invoices & Labels</title><style>${HOME_CSS}</style></head><body>
<div class="wrap">
  ${NAV('dispatch')}
  <h1>Dispatch</h1><p class="sub">Open one order to print its <b>invoice and shipping label</b>, or tick several and print them together.</p>
  <form class="search" onsubmit="window.open('/dispatch/o/'+encodeURIComponent(this.q.value.replace('#','')),'_blank');this.q.value='';return false">
    <input name="q" placeholder="Order number (e.g. 1042) — type or scan" autofocus><button>Open ↗</button></form>
  ${err ? `<div class="err">Could not load recent orders: ${esc(err)}</div>` : ''}
  <div class="filterbar" id="filterbar">${chips}</div>
  <div class="selbar"><label class="selall"><input type="checkbox" id="selall"> Select all</label>
    <span id="selcount" class="muted">0 selected</span>
    ${sorter}
    <button id="printsel" class="printsel" disabled onclick="printSelected()">Print selected ↗</button></div>
  <div class="list">${rows || '<div class="row">No orders.</div>'}</div>
  <p class="tip">Invoices open in a new tab for clean printing. Each order's number (${esc(PREFIX)}/…) is assigned on first open and reused on reprint.</p>
</div>
<script>
  var boxes=function(){return [].slice.call(document.querySelectorAll('.sel'));};
  function update(){var n=boxes().filter(function(b){return b.checked;}).length;
    document.getElementById('selcount').textContent=n+' selected';
    var b=document.getElementById('printsel');b.disabled=!n;b.textContent=(n?'Print selected ('+n+')':'Print selected')+' ↗';
    var all=document.getElementById('selall');all.checked=n>0&&n===boxes().length;}
  document.getElementById('selall').addEventListener('change',function(e){boxes().forEach(function(b){b.checked=e.target.checked;});update();});
  document.addEventListener('change',function(e){if(e.target.classList.contains('sel'))update();});
  function printSelected(){var ids=boxes().filter(function(b){return b.checked;}).map(function(b){return b.value;});
    if(ids.length)window.open('/dispatch/print?o='+encodeURIComponent(ids.join(',')),'_blank');}
  var fchips=[].slice.call(document.querySelectorAll('.fchip'));
  function applyFilter(f){
    fchips.forEach(function(c){c.classList.toggle('on',c.getAttribute('data-f')===f);});
    [].slice.call(document.querySelectorAll('.list>.row')).forEach(function(r){
      var show=f==='all'?true:(f==='gift'?r.getAttribute('data-gift')==='1'
        :(f.indexOf('fl:')===0?('fl:'+(r.getAttribute('data-ful')||''))===f
        :('st:'+(r.getAttribute('data-status')||''))===f));
      r.style.display=show?'':'none';
      var nx=r.nextElementSibling;if(nx&&nx.classList.contains('giftnote'))nx.style.display=show?'':'none';
      if(!show){var cb=r.querySelector('.sel');if(cb&&cb.checked)cb.checked=false;}
    });
    update();
  }
  fchips.forEach(function(c){c.addEventListener('click',function(){applyFilter(c.getAttribute('data-f'));});});

  // Sorting moves the rows themselves, so a gift note stays with the order it belongs to.
  var listEl=document.querySelector('.list');
  function sortBy(mode){
    var rows=[].slice.call(listEl.querySelectorAll(':scope>.row'));
    rows.sort(function(a,b){
      if(mode==='hi'||mode==='lo'){var d=parseFloat(a.getAttribute('data-amt')||0)-parseFloat(b.getAttribute('data-amt')||0);return mode==='hi'?-d:d;}
      if(mode==='cust')return (a.getAttribute('data-cust')||'').localeCompare(b.getAttribute('data-cust')||'');
      var t=(a.getAttribute('data-date')||'').localeCompare(b.getAttribute('data-date')||'');
      return mode==='old'?t:-t;
    });
    rows.forEach(function(r){
      var note=r.nextElementSibling&&r.nextElementSibling.classList.contains('giftnote')?r.nextElementSibling:null;
      listEl.appendChild(r); if(note)listEl.appendChild(note);
    });
  }
  var sortSel=document.getElementById('sortsel');
  if(sortSel)sortSel.addEventListener('change',function(){sortBy(sortSel.value);});

  // Mark an order dispatched without booking a courier, for anything that went out by hand.
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('.markbtn'); if(!b)return;
    var name=b.getAttribute('data-order');
    if(!confirm('Mark order #'+name+' as dispatched in Shopify?\\n\\nThe customer is emailed if they have an address on file. This does not book a courier.'))return;
    b.disabled=true; b.textContent='Marking…';
    fetch('/dispatch/o/'+encodeURIComponent(name)+'/fulfil',{method:'POST',headers:{'Content-Type':'application/json'}})
      .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
      .then(function(res){
        if(!res.ok||res.d.error){b.disabled=false;b.textContent='Mark sent';alert('Could not mark it dispatched: '+(res.d.error||'unknown error'));return;}
        var row=b.closest('.row'); row.setAttribute('data-ful','fulfilled');
        var pill=row.querySelector('.pill.todo'); if(pill){pill.classList.remove('todo');pill.classList.add('sent');pill.textContent='Dispatched';}
        b.remove();
      })
      .catch(function(err){b.disabled=false;b.textContent='Mark sent';alert('Could not mark it dispatched: '+err.message);});
  });
</script>
</body></html>`;
}

function renderBulkPage(orders) {
  const blocks = orders.map((o) => `${renderInvoice(o)}${renderLabel(o)}${renderCard(o)}`).join('');
  const docName = 'Zaria Dispatch - ' + orders.length + ' orders';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Great+Vibes&family=Jost:wght@300;400;500;600&family=Playfair+Display:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="toolbar no-print"><div class="tb-title">Zaria Dispatch · ${orders.length} orders <span class="tb-hint">— print each type on its own paper</span></div>
<div class="tb-actions"><a class="back" href="/dispatch">← Orders</a><button onclick="printSel('invoice')">Print Invoices · A4</button><button onclick="printSel('label')">Print Labels · A6</button><button class="primary" onclick="printSel('card')">Print Cards · A6</button><button class="cour primary" onclick="bookCourierBulk(this)">Book Quiqup</button><button class="cour-x" onclick="cancelCourierBulk(this)">Cancel Quiqup</button><button class="cour-l" onclick="printCourierLabelBulk()">Quiqup Labels</button></div></div>
<main class="sheet">${blocks}</main>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<script>document.querySelectorAll('svg.barcode,svg.prod-barcode').forEach(function(el){var p=el.classList.contains('prod-barcode');try{JsBarcode(el,el.getAttribute('data-barcode')||'',{format:'CODE128',displayValue:false,margin:0,height:p?26:54,width:p?1.2:2});}catch(e){}});
var docBase=${JSON.stringify(docName)};
function printSel(c){var pg=document.getElementById('dynpage')||document.head.appendChild(Object.assign(document.createElement('style'),{id:'dynpage'}));pg.textContent='@page{size:'+(c==='invoice'?'A4':c==='card'?'126mm 97mm':'105mm 148mm')+';margin:0}';document.title=docBase+' - '+(c==='invoice'?'Invoices':c==='label'?'Labels':'Cards');document.body.classList.add('only-'+c);window.print();setTimeout(function(){document.body.classList.remove('only-'+c);document.title=docBase;},400);}
var orderNames=${JSON.stringify(orders.map((o) => o.name || ''))};
function openPdf(b64){try{var bin=atob(b64),arr=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);var url=URL.createObjectURL(new Blob([arr],{type:'application/pdf'}));window.open(url,'_blank');}catch(e){alert('Could not open label: '+e);}}
function bulkUrl(nm,sfx){return '/dispatch/courier/'+encodeURIComponent(String(nm).replace(/^#/,''))+(sfx||'');}
async function bookCourierBulk(btn){
  if(!confirm('Book Quiqup job(s) for '+orderNames.length+' order(s)?\\n\\nEach is released for collection.'))return;
  var t=btn.textContent;btn.disabled=true;btn.textContent='Booking…';var ok=[],errs=[];
  for(var i=0;i<orderNames.length;i++){var nm=orderNames[i];
    try{var r=await fetch(bulkUrl(nm),{method:'POST'});var d=await r.json();
      if(d.error){errs.push(nm+': '+d.error);continue;}
      ok.push(nm+' -> '+d.awb+(d.cached?' (already booked)':'')+(d.emailed?' [emailed]':''));
      window.open(bulkUrl(nm,'/label'),'_blank');
    }catch(e){errs.push(nm+': '+e);}}
  btn.disabled=false;btn.textContent=t;
  var parts=[];if(ok.length)parts.push('Booked: '+ok.join('; '));if(errs.length)parts.push('Errors: '+errs.join('; '));
  alert(parts.join('   |   ')||'Nothing booked.');
}
async function cancelCourierBulk(btn){
  if(!confirm('Cancel Quiqup job(s) for '+orderNames.length+' order(s)?'))return;
  var t=btn.textContent;btn.disabled=true;btn.textContent='Cancelling…';var ok=[],errs=[];
  for(var i=0;i<orderNames.length;i++){var nm=orderNames[i];
    try{var r=await fetch(bulkUrl(nm,'/cancel'),{method:'POST'});var d=await r.json();
      if(d.error){errs.push(nm+': '+d.error);}else{ok.push(nm+' '+d.awb);}
    }catch(e){errs.push(nm+': '+e);}}
  btn.disabled=false;btn.textContent=t;
  var parts=[];if(ok.length)parts.push('Cancelled: '+ok.join('; '));if(errs.length)parts.push('Errors: '+errs.join('; '));
  alert(parts.join('   |   ')||'Nothing cancelled.');
}
function printCourierLabelBulk(){orderNames.forEach(function(nm){window.open(bulkUrl(nm,'/label'),'_blank');});}</script>
</body></html>`;
}

// Four tabs, because the Design Studio and the operations app are one dashboard now.
// Design Requests belongs to the Studio and is simply linked; everything else is ours.
function NAV(active) {
  const tab = (href, label, key) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  return `<nav class="topnav">${tab('/studio', 'Design Requests', 'studio')}${tab('/inventory', 'Inventory', 'inventory')}${tab('/dispatch', 'Dispatch', 'dispatch')}${tab('/dashboard', 'Dashboard', 'dashboard')}</nav>`;
}

// ---- routes ---------------------------------------------------------------
// Create the Quiqup job, release it for collection, and return { awb, uuid, status }.
// One call books the shipment AND returns the printable AWB label (base64 PDF).
async function quiqupCreateJob(order) {
  const sa = order.shipping_address || {};
  if (!QUIQUP.shipper.addr1) throw new Error('SHIPPER_ADDR1 is not set: Quiqup needs the real collection address.');
  if (!QUIQUP.shipper.phone) throw new Error('SHIPPER_PHONE is not set.');
  if (!sa.address1) throw new Error('The order has no shipping address line.');
  if (!sa.phone) throw new Error('The order has no delivery phone number, which Quiqup requires.');
  // Same courtesy for our own end. Quiqup rejects a job with an empty origin, but the error
  // it returns names neither field, so say which env var is missing before spending the call.
  if (!QUIQUP.shipper.addr1) throw new Error('No collection address configured. Set SHIPPER_ADDR1.');
  if (!QUIQUP.shipper.phone) throw new Error('No collection phone configured. Set SHIPPER_PHONE.');

  const cod = Number(order.cod_amount || 0);
  const body = {
    kind: QUIQUP.kind,
    // payment_amount is for collection on delivery only, and Quiqup rejects anything at or
    // below 1, so a prepaid order must not carry the field at all.
    payment_mode: cod > 0 ? 'paid_on_delivery' : 'pre_paid',
    ...(cod > 1 ? { payment_amount: cod } : {}),
    partner_order_id: String(order.name || ''),
    uuid: orderUuid(order.id),
    origin: {
      contact_name: QUIQUP.shipper.name,
      contact_phone: QUIQUP.shipper.phone,
      address: { address1: QUIQUP.shipper.addr1, city: QUIQUP.shipper.city, country: QUIQUP.shipper.country },
    },
    destination: {
      contact_name: String(sa.name || 'Customer').slice(0, 150),
      contact_phone: String(sa.phone),
      contact_email: order.email || '',
      notes: [sa.address2, sa.province].filter(Boolean).join(', ').slice(0, 200),
      address: { address1: String(sa.address1).slice(0, 200), city: String(sa.city || 'Dubai'), country: 'AE' },
    },
    // One entry per parcel. An empty parcel_barcode asks Quiqup to generate one.
    items: [{ name: `${COMPANY.brandName} order ${order.name || ''}`.trim(), quantity: 1, parcel_barcode: '' }],
  };

  const created = await quiqup('POST', '/orders', body);
  const id = created.id || created.order_id || (created.order && created.order.id);
  if (!id) throw new Error('Quiqup created no order id: ' + JSON.stringify(created).slice(0, 300));
  // A new job sits in `pending` and no one is dispatched until it is released.
  await quiqup('PUT', `/orders/${encodeURIComponent(id)}/ready_for_collection`);
  return { awb: String(id), uuid: body.uuid, status: 'ready_for_collection' };
}

// Quiqup answers a label request for an unknown id with HTTP 200 and an empty body,
// so the length is checked rather than the status, or a zero-byte "PDF" gets saved.
async function quiqupLabel(id) {
  const r = await quiqup('GET', `/order_label/${encodeURIComponent(id)}`, null, { raw: true });
  if (!r.ok) throw new Error(`Quiqup label ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error(`Quiqup returned an empty label for job ${id}. Check the job id.`);
  return buf;
}

// Cancellation is only accepted while the job is pending or ready_for_collection.
// Once it is out_for_collection the API refuses and it has to be done in Quiqdash.
async function quiqupCancel(id) {
  const d = await quiqup('PUT', '/orders/batch/set_cancelled', { order_ids: [Number(id) || id] });
  return { awb: String(id), message: d && d.message ? d.message : 'cancelled' };
}

async function quiqupTrack(id) {
  return quiqup('GET', `/orders/${encodeURIComponent(id)}`);
}

// Fulfil the order in Shopify and email the customer a branded dispatch notice with
// Quiqup tracking. Shopify's shipping-confirmation email (already Zaria-branded) is
// sent when notifyCustomer:true. Fails soft: the courier booking must not depend on it.
// Needs app scopes: read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders.
// awb is optional: a courier booking passes one so the customer gets tracking, while
// "Mark dispatched" on the list fulfils an order that went out another way (collected in
// person, delivered by the atelier) and simply has nothing to track.
async function notifyDispatched(order, awb) {
  if (!order || !order.id) return { ok: false, error: 'missing order id' };
  if (awb && !order.email) return { ok: false, error: 'order has no email address on file' };
  const q = await gql(`query($id:ID!){ order(id:$id){ fulfillmentOrders(first:20){ nodes{ id status } } } }`, { id: order.id });
  const fos = (q.order?.fulfillmentOrders?.nodes || []).filter((f) => f.status === 'OPEN' || f.status === 'IN_PROGRESS');
  if (!fos.length) return { ok: false, error: 'no open fulfillment (order may already be fulfilled)' };
  const input = {
    notifyCustomer: !!order.email,
    ...(awb ? { trackingInfo: { number: awb, company: 'Quiqup', url: quiqupTrackUrl(awb) } } : {}),
    lineItemsByFulfillmentOrder: fos.map((f) => ({ fulfillmentOrderId: f.id })),
  };
  const m = await gql(`mutation($f:FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id status } userErrors{ field message } } }`, { f: input });
  const errs = m.fulfillmentCreate?.userErrors || [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
  return { ok: true };
}

export function mountDispatch(app) {
  app.get('/dispatch', async (_req, res) => {
    let orders = [], err = '';
    try { orders = await recentOrders(30); } catch (e) { err = String(e.message || e).slice(0, 200); }
    res.send(renderHome(orders, err));
  });
  // Mark an order dispatched in Shopify without a courier booking, for pieces collected in
  // person or delivered by the atelier. Same fulfilment path the courier uses, minus tracking.
  app.post('/dispatch/o/:name/fulfil', async (req, res) => {
    try {
      const order = await orderByName(req.params.name);
      if (!order) return res.status(404).json({ error: 'Order not found.' });
      const out = await notifyDispatched(order, null);
      if (!out.ok) return res.status(409).json({ error: out.error });
      res.json({ ok: true, name: order.name });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Bulk: /dispatch/print?o=1014,1013,... → all selected invoices + labels on one print page
  app.get('/dispatch/print', async (req, res) => {
    try {
      const names = String(req.query.o || '').split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean).slice(0, 60);
      if (!names.length) return res.status(400).send(`<p style="font-family:sans-serif;padding:40px">No orders selected. <a href="/dispatch">← back</a></p>`);
      const fetched = await Promise.all(names.map((nm) => orderByName(nm).catch(() => null)));
      const orders = await Promise.all(fetched.filter(Boolean).map(async (order) => {
        const rec = await resolveNo(order);
        return normalize(order, rec.invoiceNo, rec.invoiceDate);
      }));
      if (!orders.length) return res.status(404).send(`<p style="font-family:sans-serif;padding:40px">No matching orders. <a href="/dispatch">← back</a></p>`);
      res.send(renderBulkPage(orders));
    } catch (e) { res.status(500).send('Error: ' + esc(String(e.message || e))); }
  });
  const openOrder = async (order, res, ref) => {
    if (!order) return res.status(404).send(`<p style="font-family:sans-serif;padding:40px">Order ${esc(ref)} not found. <a href="/dispatch">← back</a></p>`);
    const rec = await resolveNo(order);
    res.send(renderPrintPage(normalize(order, rec.invoiceNo, rec.invoiceDate)));
  };
  app.get('/dispatch/o/:name', async (req, res) => {
    try { await openOrder(await orderByName(req.params.name), res, req.params.name); }
    catch (e) { res.status(500).send('Error: ' + esc(String(e.message || e))); }
  });
  app.get('/dispatch/oid/:id', async (req, res) => {
    try { await openOrder(await orderById(req.params.id), res, req.params.id); }
    catch (e) { res.status(500).send('Error: ' + esc(String(e.message || e))); }
  });
  // Registered BEFORE /dispatch/courier/:name. Express matches in order, and 'webhook'
  // is a valid :name, so the booking route would otherwise swallow every Quiqup callback
  // and try to book a courier for an order called "webhook".
  // Quiqup webhook: keep the latest delivery status against the order.
  // Signed as hex HMAC-SHA256 over "{timestamp}.{raw body}", sent in X-Quiqup-Signature
  // with X-Quiqup-Timestamp alongside. The raw body is required, so this route parses
  // its own instead of using a JSON parser that would have already consumed it.
  app.post('/dispatch/courier/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const secret = process.env.QUIQUP_WEBHOOK_SECRET || '';
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    // Fail closed. This route is reachable without a sign-in, by necessity, so with no
    // secret configured there is nothing separating Quiqup from anyone who knows the URL,
    // and a forged POST could mark an order delivered. Refuse rather than trust it.
    if (!secret) return res.status(503).json({ error: 'webhook not configured' });
    {
      const sig = String(req.get('X-Quiqup-Signature') || '');
      const ts = String(req.get('X-Quiqup-Timestamp') || '');
      // Reject anything older than five minutes so a captured delivery cannot be replayed.
      if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).json({ error: 'stale or missing timestamp' });
      const want = crypto.createHmac('sha256', secret).update(ts + '.' + raw.toString('utf8')).digest('hex');
      const a = Buffer.from(sig, 'utf8'), b = Buffer.from(want, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad signature' });
    }
    let b = {};
    try { b = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ error: 'bad json' }); }
    const p = b.payload || b;
    const id = String(p.order_id || p.id || '');
    const state = String(p.state || p.status || b.event || '');
    if (id && state) {
      db.courier = db.courier || {};
      for (const [k, rec] of Object.entries(db.courier)) {
        if (String(rec.awb) === id) { rec.status = state; rec.statusAt = new Date().toISOString(); db.courier[k] = rec; break; }
      }
      // A 500 here is correct: Quiqup retries, and webhooks are the only record of a
      // transition. But answer in JSON rather than letting Express return a stack trace.
      try { saveDb(db); }
      catch (e) { console.error('[quiqup webhook]', e.message); return res.status(500).json({ error: 'could not record status' }); }
    }
    res.json({ ok: true });
  });

  // Book the Quiqup job and release it for collection. Idempotent twice over: the stored
  // record short-circuits a repeat call, and Quiqup's own uuid would return the original
  // job even if that record were lost.
  app.post('/dispatch/courier/:name', async (req, res) => {
    try {
      const order = await orderByName(req.params.name);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      const norm = normalize(order, '', '');
      const key = norm.name;
      db.courier = db.courier || {};
      if (db.courier[key] && db.courier[key].awb) {
        const rec = db.courier[key];
        let emailed = !!rec.notified, emailError = '';
        // If the dispatch email never went out (scopes added later, say), retry it now.
        if (!rec.notified) {
          try { const note = await notifyDispatched(norm, rec.awb); emailed = note.ok; emailError = note.error || ''; if (note.ok) { rec.notified = true; saveDb(db); } }
          catch (e) { emailError = String(e.message || e); }
        }
        return res.json({ awb: rec.awb, cached: true, emailed, emailError, live: quiqupLive() });
      }
      const result = await quiqupCreateJob(norm);
      db.courier[key] = { awb: result.awb, uuid: result.uuid, status: result.status, at: new Date().toISOString(), live: quiqupLive() };
      // Branded dispatch + tracking email. Must never fail the booking.
      let emailed = false, emailError = '';
      try { const note = await notifyDispatched(norm, result.awb); emailed = note.ok; emailError = note.error || ''; }
      catch (e) { emailError = String(e.message || e); }
      db.courier[key].notified = emailed;
      saveDb(db);
      res.json(Object.assign({}, result, { emailed, emailError, live: quiqupLive() }));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Cancel the booked job. Quiqup only accepts this while it is pending or
  // ready_for_collection, so the error says where to go once it is past that.
  app.post('/dispatch/courier/:name/cancel', async (req, res) => {
    try {
      const order = await orderByName(req.params.name);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      const key = normalize(order, '', '').name;
      db.courier = db.courier || {};
      const rec = db.courier[key];
      if (!rec || !rec.awb) return res.status(404).json({ error: 'No courier booking on record for this order.' });
      let result;
      try {
        result = await quiqupCancel(rec.awb);
      } catch (e) {
        return res.status(409).json({ error: String(e.message || e) + ' — once a job is out for collection it can only be cancelled in Quiqdash.' });
      }
      delete db.courier[key];
      saveDb(db);
      res.json({ awb: rec.awb, cancelled: true, message: (result && result.message) || 'Cancelled' });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Fetch the label PDF from Quiqup. A reprint, never a booking.
  app.get('/dispatch/courier/:name/label', async (req, res) => {
    try {
      const order = await orderByName(req.params.name).catch(() => null);
      const key = order ? normalize(order, '', '').name : ('#' + String(req.params.name).replace(/^#/, ''));
      const rec = (db.courier || {})[key];
      if (!rec || !rec.awb) return res.status(404).send('No courier booking for this order yet. Book it first.');
      const pdf = await quiqupLabel(rec.awb);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Quiqup-${rec.awb}.pdf"`);
      res.send(pdf);
    } catch (e) { res.status(500).send('Error: ' + String(e.message || e)); }
  });

  // Current Quiqup status for the order.
  app.get('/dispatch/courier/:name/track', async (req, res) => {
    try {
      const order = await orderByName(req.params.name).catch(() => null);
      const key = order ? normalize(order, '', '').name : ('#' + String(req.params.name).replace(/^#/, ''));
      const rec = (db.courier || {})[key];
      if (!rec || !rec.awb) return res.status(404).json({ error: 'No courier booking for this order.' });
      const data = await quiqupTrack(rec.awb);
      res.json(Object.assign({ awb: rec.awb }, data));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

}

export { NAV, HOME_CSS };

// ---- styles ---------------------------------------------------------------
const HOME_CSS = `
:root{--accent:${ACCENT};--ink:#111;--muted:#6a6a6a;--line:#ededed;--bg:#f7f6f4;}
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
.wrap{max-width:900px;margin:0 auto;padding:24px 20px 80px}
.topnav{display:flex;gap:6px;margin-bottom:22px;border-bottom:1px solid var(--line)}
.topnav a{padding:10px 16px;text-decoration:none;color:var(--muted);font-size:14px;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px}
.topnav a.on{color:var(--accent);border-bottom-color:var(--accent)}
h1{font-weight:600;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 22px;font-size:14px}
.search{display:flex;gap:10px;margin-bottom:24px}
.search input{flex:1;font:inherit;font-size:16px;padding:13px 16px;border:1px solid #ccc;border-radius:10px}
.search button{font:inherit;font-weight:600;padding:13px 22px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
h2{font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.selbar{display:flex;align-items:center;gap:16px;margin-bottom:10px}
.selall{display:flex;align-items:center;gap:6px;font-size:13px;color:#555;cursor:pointer}
.selall input{width:16px;height:16px;cursor:pointer}
.printsel{margin-left:auto;font:inherit;font-size:13px;font-weight:600;padding:9px 18px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.printsel:disabled{opacity:.4;cursor:not-allowed}
.muted{color:#999;font-size:13px}
.filterbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.fchip{font:inherit;font-size:13px;font-weight:500;padding:7px 13px;border:1px solid var(--line);border-radius:20px;background:#fff;color:#555;cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:background .15s,border-color .15s,color .15s}
.fchip:hover{border-color:var(--accent);color:var(--accent)}
.fchip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.fchip .fc{font-size:11px;font-variant-numeric:tabular-nums;opacity:.7}.fchip.on .fc{opacity:.9}
.fchip-gift{color:var(--accent)}
.fchip-todo{border-color:#111;color:#111}
.sortbox{margin-left:auto;display:inline-flex;align-items:center;gap:8px;font-size:8.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}
.sortbox select{font:inherit;font-size:12px;letter-spacing:normal;text-transform:none;color:var(--ink);padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer}
.pill.todo{background:#fff;border:1px solid #111;color:#111}
.pill.sent{background:#111;border:1px solid #111;color:#fff}
.markbtn{font:inherit;font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:7px 12px;margin-left:8px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--muted);cursor:pointer;flex:0 0 auto;transition:border-color .15s,color .15s}
.markbtn:hover{border-color:#111;color:#111}
.markbtn:disabled{opacity:.5;cursor:default}
.list{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row{display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}.row:hover{background:#faf9f8}
.sel{width:16px;height:16px;cursor:pointer;flex:0 0 auto}
.rowlink{display:flex;align-items:center;gap:14px;flex:1;padding:14px 0;text-decoration:none;color:inherit}
.nm{font-weight:700;min-width:64px}.date{font-size:12px;color:var(--muted);white-space:nowrap;flex:0 0 auto;min-width:140px}.cust{flex:1;color:#333}.amt{font-variant-numeric:tabular-nums;font-weight:600}
@media(max-width:620px){.date{min-width:0;font-size:11px}}
.pill{font-size:11px;padding:3px 9px;border-radius:20px;border:1px solid var(--line);color:var(--muted)}
.pill.paid{color:#2e7d32;border-color:#bfe3c0}.pill.pend{color:#b26a00;border-color:#f0d6a8}.pill.done{background:var(--accent);color:#fff;border-color:var(--accent)}
.giftbtn{flex:0 0 auto;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--accent);cursor:pointer;transition:background .15s,border-color .15s}
.giftbtn:hover{background:#faf1ec;border-color:var(--accent)}.giftbtn svg{width:16px;height:16px}
.giftnote{display:flex;gap:10px;align-items:flex-start;padding:12px 18px 14px 46px;background:#faf6f3;border-bottom:1px solid var(--line);font-size:13px;color:#333}
.giftnote .gn-ic{color:var(--accent);flex:0 0 auto;margin-top:1px}.giftnote .gn-ic svg{width:16px;height:16px}
.gn-body strong{font-weight:600}.gn-msg{margin-top:4px;font-style:italic;color:#1a1a1a;line-height:1.5;white-space:pre-wrap}.gn-dim{color:var(--muted)}
.list>:last-child{border-bottom:0}
.err{color:#c0392b;font-size:13px;margin-bottom:14px}.tip{color:var(--muted);font-size:12px;margin-top:16px}
`;

const CSS = `
/* The house style is the storefront footer: white, ink #111, hairlines, muted grey for
   anything secondary, Playfair for the wordmark and the figures that carry weight, Jost
   everywhere else, uppercase labels tracked wide. No fills, no ornament, no second colour. */
:root{--accent:${ACCENT};--ink:#111;--muted:#6a6a6a;--line:#ededed;--paper:#f3f2f0;}
*{box-sizing:border-box}html,body{margin:0;background:var(--paper);color:var(--ink);font-family:'Jost',system-ui,-apple-system,sans-serif;font-weight:300;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.serif{font-family:'Playfair Display',Georgia,serif}

/* ---- screen chrome, never printed ---- */
.toolbar{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:13px 22px;background:#111;color:#fff}
.tb-title{font-weight:400;letter-spacing:.12em;text-transform:uppercase;font-size:11px}.tb-hint{color:#8d8d8d}
.tb-actions{display:flex;align-items:center;gap:7px}.tb-actions .back{color:#9a9a9a;text-decoration:none;font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin-right:8px}
.tb-actions button{font:inherit;font-size:11px;font-weight:400;letter-spacing:.1em;text-transform:uppercase;padding:9px 16px;border:1px solid #3a3a3a;background:transparent;color:#e8e8e8;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.tb-actions button:hover{border-color:#fff;color:#fff}
.tb-actions button.primary{background:#fff;border-color:#fff;color:#111}
.sheet{max-width:820px;margin:26px auto;display:flex;flex-direction:column;gap:26px;padding:0 16px 70px}
.doc{background:#fff;box-shadow:0 1px 20px rgba(0,0,0,.07)}

/* ---- invoice ---- */
.invoice{padding:46px 48px 30px;font-size:12px;line-height:1.6}
.inv-head{display:flex;justify-content:space-between;align-items:flex-start;gap:28px;padding-bottom:26px;border-bottom:1px solid var(--ink)}
.brand .logo{width:152px;height:auto;margin-bottom:18px;display:block}
.brand .wordmark{font-family:'Playfair Display',Georgia,serif;font-size:27px;font-weight:400;letter-spacing:.3em;text-transform:uppercase;color:var(--ink);margin-bottom:14px}
.legal{font-size:10px;line-height:1.75;color:var(--muted);letter-spacing:.02em}
.legal strong{display:block;font-weight:500;color:var(--ink);letter-spacing:.14em;text-transform:uppercase;font-size:9.5px;margin-bottom:3px}
.title-box{text-align:right;min-width:250px}
.title{font-size:13px;font-weight:500;letter-spacing:.3em;text-transform:uppercase;color:var(--ink);margin-bottom:14px}
table.meta{margin-left:auto;border-collapse:collapse;font-size:10px}
table.meta td{color:var(--muted);text-align:right;padding:3px 14px 3px 0;letter-spacing:.14em;text-transform:uppercase;font-size:8.5px}
table.meta th{text-align:right;font-weight:400;padding:3px 0;white-space:nowrap;font-size:11px;letter-spacing:.04em}
.parties{display:flex;justify-content:space-between;align-items:flex-end;gap:30px;margin:34px 0 0}
.bill{line-height:1.75}.bill strong{display:block;font-family:'Playfair Display',Georgia,serif;font-weight:400;font-size:16px;letter-spacing:.01em;margin:2px 0 4px}
.bill div{font-size:11.5px;color:#444}
.lbl{font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.qty-note{font-size:8.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
table.items{width:100%;border-collapse:collapse;margin-top:30px}
table.items thead th{background:none;color:var(--muted);font-weight:400;font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;padding:0 8px 11px;text-align:left;border-bottom:1px solid var(--ink)}
table.items th.r,table.items td.r{text-align:right}table.items th.c,table.items td.c{text-align:center}
table.items td{padding:18px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-size:11.5px}
table.items td.desc{font-weight:400;color:var(--ink);line-height:1.5;padding-right:26px}
table.items td.r{font-variant-numeric:tabular-nums;color:#333}
.mono{font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--muted)}
.li-brand{display:block;font-size:8px;font-weight:400;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.foot-grid{display:flex;justify-content:space-between;gap:36px;margin-top:40px}.words{flex:1}
.words-val{font-family:'Playfair Display',Georgia,serif;font-style:italic;font-size:12.5px;color:#333;max-width:340px;line-height:1.65}
.sign{margin-top:44px}.sign-line{width:200px;border-top:1px solid var(--line);margin-bottom:5px}
table.totals{border-collapse:collapse;min-width:260px;align-self:flex-start}
table.totals td{color:var(--muted);padding:7px 20px 7px 0;font-size:8.5px;letter-spacing:.22em;text-transform:uppercase}
table.totals th{text-align:right;font-weight:400;padding:7px 0;font-size:12px;font-variant-numeric:tabular-nums}
table.totals tr.grand td{color:var(--ink)}
table.totals tr.grand td,table.totals tr.grand th{border-top:1px solid var(--ink);padding-top:12px}
table.totals tr.grand th{font-family:'Playfair Display',Georgia,serif;font-size:17px}
table.totals tr.disc td,table.totals tr.disc th{color:var(--muted)}
table.totals .disc-code{font-size:8px;letter-spacing:.16em;opacity:.8}
.inv-note{margin-top:18px;font-size:8.5px;line-height:1.7;color:#9b9b9b;letter-spacing:.04em}
.inv-thanks{text-align:center;margin-top:30px;font-size:9px;letter-spacing:.34em;text-transform:uppercase;color:var(--muted)}
.inv-foot{margin-top:14px;padding-top:13px;border-top:1px solid var(--line);text-align:center;font-size:9px;letter-spacing:.14em;color:var(--muted)}

/* ---- A6 shipping label ---- */
.label{width:105mm;padding:9mm 9mm 7mm;align-self:center;font-size:12px}
.lbl-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--ink);padding-bottom:8px}
.lbl-logo{width:128px;height:auto}
.lbl-order{font-weight:400;font-size:11px;letter-spacing:.16em;text-transform:uppercase}
.lbl-from{font-size:9px;color:var(--muted);margin:9px 0;line-height:1.6;letter-spacing:.04em}
.lbl-to{border:1px solid var(--ink);padding:10px 12px}
.lbl-to-tag{font-size:8px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted)}
.lbl-name{font-family:'Playfair Display',Georgia,serif;font-size:19px;font-weight:400;margin:4px 0 5px}
.lbl-addr{font-size:12.5px;line-height:1.5;color:#333}
.lbl-phone{font-size:12.5px;margin-top:4px;font-variant-numeric:tabular-nums}
.lbl-meta{display:flex;justify-content:space-between;align-items:center;margin:11px 0 4px}
.lbl-meta .cod{background:var(--ink);color:#fff;padding:5px 12px;font-size:10px;font-weight:400;letter-spacing:.16em;text-transform:uppercase}
.lbl-meta .prepaid{border:1px solid var(--ink);color:var(--ink);padding:4px 12px;font-size:10px;font-weight:400;letter-spacing:.16em;text-transform:uppercase}
svg.barcode{display:block;width:100%;height:56px;margin-top:8px}
.lbl-barnum{text-align:center;font-variant-numeric:tabular-nums;letter-spacing:.3em;font-size:11px;margin-top:3px;color:var(--muted)}
svg.inv-barcode{display:block;width:180px;height:38px;margin:16px 0 0 auto;opacity:.9}
td.bc-cell{white-space:nowrap}
svg.prod-barcode{display:block;width:112px;height:24px;opacity:.9}
.bc-num{display:block;font-variant-numeric:tabular-nums;font-size:8.5px;letter-spacing:.14em;color:var(--muted);margin-top:4px}

/* ---- gift card picker (screen only) ---- */
.cardpicker{max-width:820px;margin:28px auto 0;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:0 16px}
.cardpick-lbl{font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-right:6px}
.cardpick-btn{font:inherit;font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:9px 16px;border:1px solid #d9d9d9;background:#fff;color:var(--muted);cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.cardpick-btn:hover{border-color:var(--ink);color:var(--ink)}
.cardpick-btn.on{background:var(--ink);border-color:var(--ink);color:#fff}

/* ---- gift cards: the one place ornament is allowed, because it is the gift ---- */
.card{display:none;width:126mm;height:97mm;align-self:center;position:relative;overflow:hidden;background:#fff}
.card.on{display:block}
.card-inner{position:relative;z-index:1;height:97mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:9mm 16mm}
.card-top{font-family:'Jost',sans-serif;font-size:9px;font-weight:400;letter-spacing:.34em;text-transform:uppercase;color:var(--muted);margin-bottom:6mm}
.card-msg{font-family:'Great Vibes',cursive;font-size:42px;line-height:1.4;color:#23201e;max-width:110mm;white-space:pre-wrap;word-break:break-word}
.card-foot{display:flex;align-items:center;gap:12px;margin-top:7mm;color:var(--ink)}
.card-foot .l{width:34px;height:1px;background:rgba(17,17,17,.3)}
.card-brand{font-family:'Playfair Display',Georgia,serif;font-size:12px;font-weight:400;letter-spacing:.34em;text-transform:uppercase}
.card--classic .card-frame{position:absolute;inset:5mm;border:1px solid rgba(17,17,17,.4);pointer-events:none}
.card--classic .card-frame::after{content:'';position:absolute;inset:1.6mm;border:1px solid rgba(17,17,17,.18)}
.card--golden{background:#fdfbf7}
.card--golden .gold-fr{position:absolute;inset:9mm;border:1px solid rgba(199,154,107,.55);pointer-events:none}
.card--golden .card-top--gold,.card--golden .card-brand{color:#b98a58}
.card--golden .card-foot{color:#b98a58}.card--golden .card-foot .l{background:rgba(199,154,107,.6)}
.gc{position:absolute;width:15mm;height:15mm;z-index:2}.gc svg{width:100%;height:100%}
.gc-tl{top:5mm;left:5mm}.gc-tr{top:5mm;right:5mm;transform:rotate(90deg)}.gc-br{bottom:5mm;right:5mm;transform:rotate(180deg)}.gc-bl{bottom:5mm;left:5mm;transform:rotate(270deg)}
.sprig{position:absolute;width:42mm;height:42mm;z-index:2}.sprig svg{width:100%;height:100%}
.sprig-tl{top:0;left:0}.sprig-br{bottom:0;right:0;transform:rotate(180deg)}
.card--botanical .card-inner{padding:20mm 26mm}
.card--gift{background:#ffffff}
.card--gift .card-inner--gift{align-items:flex-start;text-align:left;padding:16mm 48mm 16mm 22mm}
.card--gift .card-msg{max-width:86mm}
.gift-ribbon{position:absolute;top:0;right:18mm;width:30mm;height:100%;z-index:2}.gift-ribbon svg{width:100%;height:100%}

/* ---- pickup slip ---- */
.pickup{padding:40px 44px;font-size:12px;line-height:1.6}
.pk-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:1px solid var(--ink);padding-bottom:18px}
.pickup .brand .logo{margin-bottom:0}
.pk-items{margin-top:26px}
.pk-items td{padding:13px 8px;font-size:11.5px}
.pk-items .pk-brand{font-size:8.5px;font-weight:400;text-transform:uppercase;letter-spacing:.22em;color:var(--muted);white-space:nowrap;vertical-align:top}
.pk-items td.desc{font-weight:400}
.pk-items .pk-qty{font-family:'Playfair Display',Georgia,serif;font-weight:400;font-size:15px}
.pk-box{display:inline-block;width:15px;height:15px;border:1px solid var(--ink);vertical-align:middle}
.pk-gift{color:var(--ink)}
.pk-foot{display:flex;justify-content:space-between;gap:20px;margin-top:38px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
@media print{html,body{background:#fff}.no-print{display:none!important}.sheet{margin:0;max-width:none;padding:0;gap:0;display:block}.doc{box-shadow:none}
.invoice{padding:16mm 16mm;min-height:289mm;display:flex;flex-direction:column}
.invoice .inv-bottom{margin-top:auto}
.pickup{padding:16mm 16mm}
/* Only the chosen doc type prints. printSel() injects ONE @page with the right paper size + margin:0.
   margin:0 removes Chrome's date/title/URL header & footer; a single unnamed @page is the only way
   Chrome's Save-as-PDF honours a non-A4 size (named per-element @page sizes are silently ignored). */
body.only-invoice .label,body.only-invoice .card,body.only-invoice .pickup{display:none}
body.only-pickup .invoice,body.only-pickup .label,body.only-pickup .card{display:none}
body.only-label .invoice,body.only-label .card,body.only-label .pickup{display:none}
body.only-card .invoice,body.only-card .label,body.only-card .pickup{display:none}
/* Break only BETWEEN items of the same type (bulk); the first of each type has no leading break, so no blank trailing page. */
body.only-invoice .invoice~.invoice{page-break-before:always}
body.only-pickup .pickup~.pickup{page-break-before:always}
body.only-label .label~.label{page-break-before:always}
body.only-card .card.on~.card.on{page-break-before:always}}
`;
