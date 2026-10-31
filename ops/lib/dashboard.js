// Orders dashboard for the Inventory & Dispatch app.
//
// A read-only overview of recent orders: where the order came from, who placed it,
// whether they are new or returning, where it is going and what it is worth. Nothing
// here writes to Shopify.
//
// "Source" is the visit Shopify attributes the order to (Google, Instagram, direct and
// so on) via customerJourneySummary, which is the same data behind the admin's
// Conversion summary. New vs returning uses customerOrderIndex, which is the order's
// position in that customer's history AT THE TIME IT WAS PLACED, so it stays correct
// later, unlike customer.numberOfOrders which keeps counting up.

import { gql } from './shopify.js';
import { NAV, HOME_CSS } from './dispatch.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RANGES = [7, 30, 90];
const MAX_PAGES = 12; // 100 per page; plenty for a 90 day window on this store

const ORDER_Q = `
  name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt
  paymentGatewayNames
  totalPriceSet{ shopMoney{ amount currencyCode } }
  shippingAddress{ city province country }
  customer{ displayName email numberOfOrders }
  channelInformation{ channelDefinition{ channelName } }
  customerJourneySummary{ customerOrderIndex
    firstVisit{ source } lastVisit{ source } }`;

async function fetchOrders(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await gql(
      `query($c:String,$q:String!){ orders(first:100, after:$c, query:$q, sortKey:CREATED_AT, reverse:true){
         pageInfo{ hasNextPage endCursor } nodes{ ${ORDER_Q} } } }`,
      { c: cursor, q: `created_at:>=${since}` }
    );
    const o = d.orders;
    out.push(...o.nodes);
    if (!o.pageInfo.hasNextPage) break;
    cursor = o.pageInfo.endCursor;
  }
  return out;
}

/** Shopify reports a few sources as empty, "direct" or the sentence "an unknown
 *  source"; tidy those so the grouping and the table read consistently. */
function sourceOf(o) {
  const j = o.customerJourneySummary || {};
  const s = ((j.lastVisit && j.lastVisit.source) || (j.firstVisit && j.firstVisit.source) || '').trim();
  const low = s.toLowerCase();
  if (!s || low === 'direct') return 'Direct';
  if (low.includes('unknown')) return 'Unknown';
  return s;
}

function isNew(o) {
  const idx = o.customerJourneySummary && o.customerJourneySummary.customerOrderIndex;
  if (typeof idx === 'number') return idx <= 1;
  // No journey data (POS, draft orders, older records): fall back to the live count.
  const n = o.customer && o.customer.numberOfOrders;
  return n == null ? null : Number(n) <= 1;
}

function placeOf(o) {
  const a = o.shippingAddress || {};
  const city = a.city || '';
  const region = a.province && a.province !== a.city ? a.province : '';
  const country = a.country || '';
  return [city, region].filter(Boolean).join(', ') || country || '';
}

const money = (n, cur) =>
  (Number(n) || 0).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (cur || 'AED');

function summarise(orders) {
  const live = orders.filter((o) => !o.cancelledAt);
  const total = live.reduce((s, o) => s + Number(o.totalPriceSet?.shopMoney?.amount || 0), 0);
  const cur = live[0]?.totalPriceSet?.shopMoney?.currencyCode || 'AED';
  let newN = 0, repeatN = 0;
  const bySource = {}, byPlace = {};
  for (const o of live) {
    const n = isNew(o);
    if (n === true) newN++; else if (n === false) repeatN++;
    const s = sourceOf(o);
    bySource[s] = (bySource[s] || 0) + 1;
    const p = placeOf(o) || 'Unknown';
    byPlace[p] = (byPlace[p] || 0) + 1;
  }
  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return {
    count: live.length, cancelled: orders.length - live.length,
    total, cur, avg: live.length ? total / live.length : 0,
    newN, repeatN, sources: top(bySource), places: top(byPlace),
  };
}

function csv(orders) {
  const head = ['Order', 'Date', 'Customer', 'Email', 'Type', 'Source', 'Location', 'Value', 'Currency', 'Payment', 'Financial', 'Fulfilment'];
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = orders.map((o) => [
    o.name, String(o.createdAt).slice(0, 16).replace('T', ' '),
    o.customer?.displayName || '', o.customer?.email || '',
    isNew(o) === null ? 'Unknown' : isNew(o) ? 'New' : 'Returning',
    sourceOf(o), placeOf(o),
    Number(o.totalPriceSet?.shopMoney?.amount || 0).toFixed(2),
    o.totalPriceSet?.shopMoney?.currencyCode || '',
    (o.paymentGatewayNames || []).join(' / '),
    o.cancelledAt ? 'CANCELLED' : o.displayFinancialStatus || '',
    o.displayFulfillmentStatus || '',
  ].map(q).join(','));
  return [head.map(q).join(','), ...rows].join('\n');
}

function render(orders, days, err) {
  const s = summarise(orders);
  const pct = (n) => (s.count ? Math.round((n / s.count) * 100) : 0);

  const tile = (label, value, sub) =>
    `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ''}</div>`;

  const bar = (list, total) => list.slice(0, 6).map(([k, n]) =>
    `<div class="brow"><span class="bk">${esc(k)}</span>
       <span class="btrack"><i style="width:${total ? Math.round((n / total) * 100) : 0}%"></i></span>
       <span class="bn">${n}</span></div>`).join('');

  const rows = orders.map((o) => {
    const n = isNew(o);
    const cancelled = !!o.cancelledAt;
    const fin = cancelled ? 'CANCELLED' : (o.displayFinancialStatus || '');
    const num = o.name.replace('#', '');
    return `<tr class="${cancelled ? 'cx' : ''}">
      <td><a href="/dispatch/o/${encodeURIComponent(num)}" target="_blank">${esc(o.name)}</a></td>
      <td class="muted">${esc(String(o.createdAt).slice(0, 10))}</td>
      <td>${esc(o.customer?.displayName || '-')}</td>
      <td>${n === null ? '<span class="pill pu">?</span>' : n ? '<span class="pill pn">New</span>' : '<span class="pill pr">Returning</span>'}</td>
      <td>${esc(sourceOf(o))}</td>
      <td class="muted">${esc(placeOf(o) || '-')}</td>
      <td class="num">${esc(money(o.totalPriceSet?.shopMoney?.amount, o.totalPriceSet?.shopMoney?.currencyCode))}</td>
      <td><span class="st st-${esc(fin.toLowerCase())}">${esc(fin ? fin.charAt(0) + fin.slice(1).toLowerCase().replace(/_/g, ' ') : '-')}</span></td>
    </tr>`;
  }).join('');

  const chips = RANGES.map((d) =>
    `<a class="rchip${d === days ? ' on' : ''}" href="/dashboard?days=${d}">${d} days</a>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard - Orders overview</title><style>${HOME_CSS}
.wrap{max-width:1120px}
.rbar{display:flex;gap:8px;align-items:center;margin:0 0 18px;flex-wrap:wrap}
.rchip{padding:7px 14px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--muted);font-size:13px;font-weight:600;background:#fff}
.rchip.on{border-color:var(--brass);color:var(--brass)}
.rbar .sp{flex:1}
.dl{padding:7px 14px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--muted);font-size:13px;font-weight:600;background:#fff}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin:0 0 20px}
.tile{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tl{font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
.tv{font-size:23px;font-weight:600;margin-top:4px;line-height:1.2}
.ts{font-size:12px;color:var(--muted);margin-top:2px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 22px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h3{margin:0 0 10px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.brow{display:flex;align-items:center;gap:10px;margin:0 0 7px;font-size:13.5px}
.bk{flex:0 0 38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btrack{flex:1;height:7px;background:#f0ece9;border-radius:4px;overflow:hidden}
.btrack i{display:block;height:100%;background:var(--brass)}
.bn{flex:0 0 28px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13.5px}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{background:#fbf9f8;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
tr:last-child td{border-bottom:0}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.muted,.muted{color:var(--muted)}
tr.cx td{opacity:.5;text-decoration:line-through}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
.pn{background:#eaf6ec;color:#2b7a39}.pr{background:#fbf1ea;color:var(--brass)}.pu{background:#f0efed;color:#888}
.st{font-size:12px;color:var(--muted)}
.st-paid{color:#2b7a39}.st-pending,.st-authorized{color:#9a6b1f}.st-refunded,.st-voided,.st-cancelled{color:#a33}
.err{background:#fdecec;border:1px solid #f5b5b5;padding:10px 14px;border-radius:8px;margin:0 0 16px}
@media(max-width:780px){.cols{grid-template-columns:1fr}table{font-size:12.5px}th,td{padding:7px 8px}}
</style></head><body>
<div class="wrap">
  ${NAV('dashboard')}
  <h1>Dashboard</h1>
  <p class="sub">Where orders come from, who is placing them and what they are worth. Read only, nothing here changes Shopify.</p>
  ${err ? `<div class="err">Could not load orders: ${esc(err)}</div>` : ''}
  <div class="rbar">${chips}<span class="sp"></span><a class="dl" href="/dashboard.csv?days=${days}">Download CSV</a></div>
  <div class="tiles">
    ${tile('Orders', s.count, s.cancelled ? `${s.cancelled} cancelled, not counted` : '')}
    ${tile('Revenue', esc(money(s.total, s.cur)), `last ${days} days`)}
    ${tile('Average order', esc(money(s.avg, s.cur)), '')}
    ${tile('New customers', `${pct(s.newN)}%`, `${s.newN} new, ${s.repeatN} returning`)}
    ${tile('Top source', esc(s.sources[0] ? s.sources[0][0] : '-'), s.sources[0] ? `${s.sources[0][1]} orders` : '')}
  </div>
  <div class="cols">
    <div class="card"><h3>Where orders come from</h3>${bar(s.sources, s.count) || '<p class="muted">No data.</p>'}</div>
    <div class="card"><h3>Where they are going</h3>${bar(s.places, s.count) || '<p class="muted">No data.</p>'}</div>
  </div>
  <table>
    <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Type</th><th>Source</th><th>Delivery</th><th class="num">Value</th><th>Status</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="muted">No orders in this period.</td></tr>'}</tbody>
  </table>
  <p class="tip">Source is the visit Shopify attributes the order to, the same figure as the admin's Conversion summary. New or returning is judged at the time the order was placed, so it does not drift as the customer buys again. Order numbers open the invoice and label.</p>
</div></body></html>`;
}

export function mountDashboard(app) {
  const range = (req) => {
    const d = parseInt(req.query.days, 10);
    return RANGES.includes(d) ? d : 30;
  };
  app.get('/dashboard', async (req, res) => {
    const days = range(req);
    let orders = [], err = '';
    try { orders = await fetchOrders(days); } catch (e) { err = String(e.message || e).slice(0, 200); }
    res.send(render(orders, days, err));
  });
  app.get('/dashboard.csv', async (req, res) => {
    const days = range(req);
    try {
      const orders = await fetchOrders(days);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="zaria-orders-${days}d.csv"`);
      res.send('﻿' + csv(orders)); // BOM so Excel reads UTF-8 names correctly
    } catch (e) {
      res.status(500).send('Error: ' + String(e.message || e));
    }
  });
}
