/*
 * Zaria Design Studio.
 * Customer "Design Your Look" request + measurement capture, and a
 * password-protected designer dashboard with search, status board, notes,
 * archive, CSV export and optional new-request webhook alerts.
 * Self-contained (Express + SQLite), deployable on Coolify. No Shopify app needed.
 */
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const express = require("express");
const Database = require("better-sqlite3");
const PDFDocument = require("pdfkit");

const PORT = Number(process.env.PORT || 3000);
const BRAND = process.env.BRAND_NAME || "Zaria";
const STORE_URL = (process.env.STORE_URL || "https://zaria-collections-2.myshopify.com").replace(/\/+$/, "");
const STUDIO_USER = process.env.STUDIO_USER || "designer";
const STUDIO_PASS = process.env.STUDIO_PASS || "zaria";
const WHATSAPP = process.env.WHATSAPP || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
// Optional: POST a JSON alert to this URL whenever a new request arrives
// (e.g. a Slack/Make/n8n/WhatsApp-API webhook). Credential-free: URL only.
const NOTIFY_WEBHOOK = (process.env.NOTIFY_WEBHOOK || "").trim();

// ---- data ----------------------------------------------------------------
const db = new Database(path.join(DATA_DIR, "studio.db"));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new',
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  garment       TEXT,
  occasion      TEXT,
  fabric        TEXT,
  color         TEXT,
  budget        TEXT,
  event_date    TEXT,
  notes         TEXT,
  measurements  TEXT,
  reference_url TEXT,
  preferred_date TEXT,
  boutique      TEXT
)`);
// Migrations (safe to re-run)
for (const alter of [
  "ALTER TABLE requests ADD COLUMN product_ref TEXT",
  "ALTER TABLE requests ADD COLUMN designer_notes TEXT",
  "ALTER TABLE requests ADD COLUMN archived INTEGER DEFAULT 0",
]) { try { db.exec(alter); } catch (_) { /* column exists */ } }

const GARMENTS = ["Gown", "Abaya", "Jalabiya", "Kaftan", "Two-piece", "Other"];
const OCCASIONS = ["Wedding", "Engagement", "Eid", "Party / Evening", "Everyday", "Other"];
// Matches the 9 storefront fabric categories (+ an "advise me" option)
const FABRICS = ["Luxe Silks", "Fine Cottons", "Chiffons & Organza", "Linen Blends", "Velvets", "Tulle & 3D Work", "Silk Blends", "Sequins & Embroidery", "Hand-Painted", "Not sure, advise me"];
const BOUTIQUES = ["Dubai boutique", "Online / video consultation"];
// Mirrors the storefront ready-to-wear "Choose your size" form
// (snippets/zaria-measure-form.liquid). [hmin,hmax] are half-cm units
// (option value = n/2) so each dropdown steps in 0.5. Keys align with the
// cutting-pattern generator (bust / waist / hips / shoulder / sleeve / length).
const MEASURES = [
  ["neck_open", "Neck Open", 26, 35],
  ["shoulder", "Shoulder to Shoulder", 26, 37],
  ["sleeve_loose", "Sleeve Loose", 12, 25],
  ["sleeve", "Sleeve Length", 52, 68],
  ["sleeve_open", "Sleeve Open", 18, 25],
  ["bust", "Bust", 76, 117],
  ["waist", "Waist", 76, 124],
  ["hips", "Hip", 86, 136],
  ["length", "Length", 100, 130],
  ["bottom_open", "Bottom Open", 30, 48],
];
const RTW_SIZES = ["36 / XS", "38 / S", "40 / M", "42 / L", "44 / XL", "46 / XXL"];
const STATUSES = ["new", "contacted", "measured", "in production", "delivered"];
const STATUS_META = {
  "new": { label: "New", cls: "new" },
  "contacted": { label: "Contacted", cls: "contacted" },
  "measured": { label: "Measured", cls: "measured" },
  "in production": { label: "In production", cls: "production" },
  "delivered": { label: "Delivered", cls: "delivered" },
};

// ---- helpers -------------------------------------------------------------
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(title, body, { wide = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(BRAND)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600&family=Playfair+Display:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--ink:#111111;--paper:#ffffff;--bg:#ffffff;--muted:#6a6a6a;--line:#ededed;--soft:#fafafa;--wine:#7a1f34;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:"Jost",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    font-size:15.5px;line-height:1.7;letter-spacing:.01em;-webkit-font-smoothing:antialiased}
  .display{font-family:"Jost",sans-serif}
  .wrap{max-width:${wide ? "1120px" : "660px"};margin:0 auto;padding:56px 24px 88px}
  .brand{font-family:"Jost",sans-serif;font-weight:500;font-size:22px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink);line-height:1}
  .brand-logo{display:block;height:42px;width:auto}
  .topbar .brand-logo{height:34px}
  .eyebrow{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
  h1{font-family:"Jost",sans-serif;font-weight:400;font-size:clamp(28px,4.4vw,42px);line-height:1.14;letter-spacing:.05em;text-transform:uppercase;margin:0 0 16px}
  p.lede{color:var(--muted);font-size:16px;line-height:1.75;margin:0 0 30px;max-width:58ch}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:32px}
  label{display:block;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
  label .req{color:var(--wine)}
  .field{margin-bottom:20px}
  .picked{display:flex;align-items:center;gap:12px;padding:13px 15px;border:1px solid var(--line);border-left:3px solid var(--wine);border-radius:2px;background:#fbf7f8;font-size:15px;color:var(--ink)}
  .picked svg{flex:none;color:var(--wine)}
  .picked a{color:var(--muted);font-size:12px;letter-spacing:.02em;margin-left:auto;white-space:nowrap}
  .picked-note{font-size:12.5px;color:var(--muted);margin:8px 0 0;line-height:1.5}
  .fabric-banner{display:flex;align-items:center;gap:12px;margin:0 0 8px;padding:12px 16px;border:1px solid #efe0e4;border-radius:2px;background:#fbf6f7;font-size:14px;color:var(--ink)}
  .fabric-banner svg{flex:none;color:var(--wine)}
  .fabric-banner b{font-weight:500}
  input,select,textarea{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:2px;background:#fff;
    font:inherit;font-size:15px;color:var(--ink)}
  input::placeholder,textarea::placeholder{color:#a6a6a6}
  input:focus,select:focus,textarea:focus{outline:none;border-color:#111;box-shadow:0 0 0 3px rgba(17,17,17,.08)}
  textarea{min-height:104px;resize:vertical;line-height:1.6}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .section-h{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--ink);font-weight:600;margin:34px 0 8px;padding-top:26px;border-top:1px solid var(--line)}
  .hint{font-size:13px;color:var(--muted);margin:-10px 0 18px;line-height:1.6}
  .btn{display:inline-block;background:var(--ink);color:#fff;border:none;border-radius:2px;padding:15px 34px;
    font-family:"Jost",sans-serif;font-size:12px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;transition:opacity .2s ease;text-decoration:none}
  .btn:hover{opacity:.85}
  .btn-ghost{background:#fff;color:var(--ink);border:1px solid var(--ink)}
  .btn-ghost:hover{background:var(--ink);color:#fff;opacity:1}
  .btn-sm{padding:10px 20px}
  .btn-danger{background:#fff;color:var(--wine);border:1px solid #e2c3cb}
  .btn-danger:hover{background:var(--wine);color:#fff;opacity:1}
  a{color:var(--ink)}
  .muted{color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:14.5px}
  th,td{text-align:left;padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:600}
  tbody tr:hover{background:var(--soft)}
  tr.is-new td{box-shadow:inset 3px 0 0 var(--wine)}
  .pill{display:inline-block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;padding:4px 10px;border-radius:2px;border:1px solid var(--line);background:#f4f4f4;color:#333;white-space:nowrap}
  .pill.new{background:#111;color:#fff;border-color:#111}
  .pill.contacted{background:#fff;color:#111;border-color:#111}
  .pill.measured{background:#efefef;color:#111;border-color:#e0e0e0}
  .pill.production{background:#e6e6e6;color:#111;border-color:#dcdcdc}
  .pill.delivered{background:#fafafa;color:#8a8a8a;border-color:#eeeeee}
  .dl{display:grid;grid-template-columns:180px 1fr;gap:12px 20px;font-size:15px}
  .dl dt{color:var(--muted);font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding-top:3px}
  .dl dd{margin:0}
  .mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:10px}
  .mchip{border:1px solid var(--line);border-radius:2px;padding:10px 12px;background:#fff}
  .mchip b{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:2px}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px;flex-wrap:wrap;gap:12px}
  /* dashboard */
  .stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:0 0 22px}
  .stat{display:block;text-decoration:none;border:1px solid var(--line);border-radius:2px;padding:14px 15px;background:#fff;transition:border-color .15s ease,background .15s ease}
  .stat:hover{border-color:#111}
  .stat.is-active{border-color:var(--wine);background:#fbf7f8}
  .stat b{display:block;font-family:"Jost";font-size:26px;font-weight:400;line-height:1;color:var(--ink)}
  .stat span{display:block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-top:7px}
  .toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
  .toolbar form{display:flex;gap:8px;flex:1 1 260px}
  .toolbar input{flex:1}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
  .tab{font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:8px 14px;border:1px solid var(--line);border-radius:2px;color:var(--muted);text-decoration:none;background:#fff}
  .tab.is-active{border-color:#111;color:#111;background:#f6f6f6}
  footer{margin-top:56px;padding-top:22px;border-top:1px solid var(--line);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#9a9a9a;text-align:center}
  @media(max-width:820px){.stats{grid-template-columns:repeat(3,1fr)}}
  @media(max-width:560px){.row,.grid3{grid-template-columns:1fr}.dl{grid-template-columns:1fr;gap:4px 0}.dl dt{padding-top:12px}.wrap{padding:40px 20px 64px}.stats{grid-template-columns:repeat(2,1fr)}}
</style></head><body>${body}
<footer>${esc(BRAND)} Design Studio · by Arkanet</footer>
</body></html>`;
}

// ---- customer: the form --------------------------------------------------
function optionList(arr, name, required) {
  return `<select name="${name}" ${required ? "required" : ""}>
    <option value="">Please choose…</option>
    ${arr.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}
  </select>`;
}

// 0.5 cm dropdown options between two half-cm bounds (value = n/2).
function stepOptions(hmin, hmax) {
  let out = '<option value="">– Select –</option>';
  for (let h = hmin; h <= hmax; h++) {
    const lab = (h % 2 === 0) ? String(h / 2) : (Math.floor(h / 2) + ".5");
    out += `<option value="${lab}">${lab}</option>`;
  }
  return out;
}

function formPage(q = {}) {
  const pickedFabric = (q.fabric || "").toString().trim().slice(0, 200);
  const pickedProduct = (q.product || "").toString().trim().slice(0, 200);
  const fabricIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8c3 0 3 2 6 2s3-2 6-2 3 2 6 2M3 14c3 0 3 2 6 2s3-2 6-2 3 2 6 2"/></svg>';
  const productLink = pickedProduct ? `${STORE_URL}/products/${encodeURIComponent(pickedProduct)}` : "";
  const fabricBanner = pickedFabric
    ? `<div class="fabric-banner">${fabricIcon}<span>Designing with <b>${esc(pickedFabric)}</b>${productLink ? ` &middot; <a href="${esc(productLink)}" target="_blank" rel="noopener" style="color:var(--wine)">view fabric</a>` : ""}<br><span class="picked-note" style="margin:0">Selected from the Zaria collection, no need to choose it again.</span></span></div>`
    : "";
  const hiddenFabric = pickedFabric
    ? `<input type="hidden" name="fabric" value="${esc(pickedFabric)}"><input type="hidden" name="product_ref" value="${esc(pickedProduct)}">`
    : "";
  const pieceRow = pickedFabric
    ? `<div class="field"><label>Colour accents (optional)</label><input name="color" placeholder="e.g. ivory, emerald, black"></div>`
    : `<div class="row">
        <div class="field"><label>Fabric preference</label>${optionList(FABRICS, "fabric", false)}</div>
        <div class="field"><label>Colour</label><input name="color" placeholder="e.g. ivory, emerald, black"></div>
      </div>`;
  const sizeFields = MEASURES.map(
    ([k, label, hmin, hmax], i) => `<div class="field" style="margin-bottom:0">
      <label><span class="zmnum">${i + 1}</span> ${esc(label)} <span class="muted" style="letter-spacing:0;text-transform:none">(cm)</span></label>
      <select name="m_${k}" data-size-in="custom" disabled>${stepOptions(hmin, hmax)}</select>
    </div>`
  ).join("");

  // The Zaria journey: a couture 4-step process band (Freya-style, our own words).
  // Images are numbered placeholders for now; swap in /journey-N photos when ready.
  const journeySteps = [
    ["01", "consult", "The Vision", "It begins with a conversation. We listen to your story, your occasion and the feeling you want to carry, and a vision starts to take form."],
    ["02", "design", "The Design", "Silhouettes are sketched and fabrics are chosen, every detail considered until the design is unmistakably yours."],
    ["03", "craft", "The Atelier", "Skilled hands bring the design to life, transforming our finest fabrics into a piece made to be treasured."],
    ["04", "final", "The Fitting", "Every seam is refined and every fold perfected, until it is not simply a dress but an extension of you."],
  ];
  const journeyIcon = (k) => ({
    consult: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M15 5l4 4-9 9-4 1 1-4z"/></svg>',
    design: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="7" r="2.2"/><circle cx="6" cy="17" r="2.2"/><path d="M8 8.4 20 16M8 15.6 20 8"/></svg>',
    craft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c7-1 11-7 17-17"/><path d="M17 4l3 3"/><path d="M9 16l-2 5 5-2"/></svg>',
    final: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3l1.7 5.3L18 10l-5.3 1.7L11 17l-1.7-5.3L4 10l5.3-1.7z"/><path d="M18 14l.7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7z"/></svg>',
  }[k] || "");
  const journey = `<section class="journey"><div class="journey__inner">
      <p class="journey__eyebrow">The Zaria journey</p>
      <h2 class="journey__title">From first vision to a piece that is yours</h2>
      <div class="journey__grid">
        ${journeySteps.map(([num, ic, title, text], i) => `<article class="journey__step">
          <div class="journey__media">${journeyIcon(ic)}<span class="journey__num">${num}</span><span class="journey__ph">Image ${i + 1}</span></div>
          <h3 class="journey__step-title">${esc(title)}</h3>
          <p class="journey__step-text">${esc(text)}</p>
        </article>`).join("")}
      </div>
    </div></section>`;

  return layout("Design Your Look", `<div class="wrap">
    <img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}">
    <div style="height:34px"></div>
    <p class="eyebrow">The Design Studio</p>
    <h1>Design your look</h1>
    <p class="lede">Tell us about the piece you have in mind. One of our designers will reach out to refine the design, confirm your measurements and guide you to a finished garment made only for you.</p>
    ${fabricBanner}

    ${journey}

    <form class="card" method="post" action="/request">
      ${hiddenFabric}
      <p class="section-h" style="margin-top:0;border-top:none;padding-top:0">Your details</p>
      <div class="row">
        <div class="field"><label>Full name <span class="req">*</span></label><input name="name" required></div>
        <div class="field"><label>Phone / WhatsApp <span class="req">*</span></label><input name="phone" required></div>
      </div>
      <div class="field"><label>Email</label><input type="email" name="email" placeholder="optional"></div>

      <p class="section-h">The piece</p>
      <div class="row">
        <div class="field"><label>Garment <span class="req">*</span></label>${optionList(GARMENTS, "garment", true)}</div>
        <div class="field"><label>Occasion</label>${optionList(OCCASIONS, "occasion", false)}</div>
      </div>
      ${pieceRow}
      <div class="row">
        <div class="field"><label>Event date (if any)</label><input type="date" name="event_date"></div>
        <div class="field"><label>Budget range (optional)</label><input name="budget" placeholder="AED"></div>
      </div>
      <div class="field"><label>Describe the design</label>
        <textarea name="notes" placeholder="Silhouette, sleeves, neckline, embroidery, inspiration… paste reference image links here too."></textarea>
      </div>
      <div class="field"><label>Reference links (optional)</label>
        <input name="reference_url" placeholder="Pinterest / Instagram / image URLs"></div>

      <p class="section-h">Choose your size <span class="req">*</span></p>
      <p class="hint">Select <b>Readymade</b> for a standard size, or <b>Customized</b> to have it cut to your measurements. Unsure of the numbers? Pick Customized and leave them blank — our designer will measure you precisely at the fitting.</p>
      <div class="size-modes" data-size-modes>
        <label class="size-mode" data-size-modelabel><input type="radio" name="size_type" value="Readymade" data-size-mode="ready"> Readymade</label>
        <label class="size-mode" data-size-modelabel><input type="radio" name="size_type" value="Customized" data-size-mode="custom"> Customized</label>
      </div>
      <div class="size-panel" data-size-panel="ready" hidden>
        <div class="field" style="max-width:320px"><label>Size</label>
          <select name="size" data-size-in="ready" disabled><option value="">– Select –</option>${RTW_SIZES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select>
        </div>
      </div>
      <div class="size-panel" data-size-panel="custom" hidden>
        <p class="hint" style="margin:2px 0 12px"><b data-size-count>0</b> of ${MEASURES.length} measurements added</p>
        <div class="grid3">${sizeFields}</div>
      </div>
      <div class="field" style="margin-top:14px;max-width:320px"><label>Sheila (for abayas)</label>
        <select name="sheila"><option value="">Not applicable</option><option value="With Sheila">With Sheila</option><option value="Without Sheila">Without Sheila</option></select>
      </div>

      <p class="section-h">Consultation</p>
      <div class="row">
        <div class="field"><label>Preferred date</label><input type="date" name="preferred_date"></div>
        <div class="field"><label>Where</label>${optionList(BOUTIQUES, "boutique", false)}</div>
      </div>

      <div style="margin-top:24px"><button class="btn" type="submit">Send my design request</button></div>
      ${WHATSAPP ? `<p class="hint" style="margin-top:16px">Prefer to chat? WhatsApp us at ${esc(WHATSAPP)}.</p>` : ""}
    </form>
  </div>
  <style>
    .size-modes{display:flex;gap:10px;margin:12px 0 0}
    .size-mode{flex:1 1 0;display:flex;align-items:center;justify-content:center;gap:9px;cursor:pointer;border:1px solid #d7d2ca;background:#fff;padding:14px 12px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#4a4a4a;transition:border-color .15s,color .15s,background .15s}
    .size-mode:hover{border-color:#161616;color:#161616}
    .size-mode input{accent-color:var(--wine,#7a1f34);width:16px;height:16px;margin:0}
    .size-mode.is-active{border-color:var(--wine,#7a1f34);color:#161616;background:#fbf7f8}
    .size-panel{margin-top:16px}
    .size-panel[hidden]{display:none}
    .zmnum{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#f1ece3;color:#8a7a53;border:1px solid #e0d8c8;font-size:11px;margin-right:4px;vertical-align:middle}
    .journey{margin:14px calc(50% - 50vw) 44px;background:#0e0e0e;color:#fff;padding:66px 24px;overflow:hidden}
    .journey__inner{max-width:1160px;margin:0 auto}
    .journey__eyebrow{font-family:"Jost",sans-serif;font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#b99a6b;margin:0 0 12px;text-align:center}
    .journey__title{font-family:"Jost",sans-serif;font-weight:300;font-size:clamp(21px,3.4vw,32px);letter-spacing:.03em;text-align:center;margin:0 0 44px;color:#fff}
    .journey__grid{display:grid;grid-template-columns:repeat(4,1fr);gap:30px}
    .journey__step{min-width:0}
    .journey__media{position:relative;aspect-ratio:16/10;background:linear-gradient(135deg,#1c1c1c,#131313);border:1px solid #2a2a2a;display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:18px}
    .journey__media svg{width:42px;height:42px;color:var(--wine,#7a1f34);opacity:.92}
    .journey__media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .journey__num{position:absolute;top:8px;left:12px;font-family:"Jost",sans-serif;font-size:34px;font-weight:200;color:#262626;line-height:1}
    .journey__ph{position:absolute;bottom:8px;right:10px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#565656}
    .journey__step-title{font-family:"Jost",sans-serif;font-weight:500;font-size:13.5px;letter-spacing:.22em;text-transform:uppercase;color:#fff;margin:0 0 12px}
    .journey__step-text{font-size:13.5px;line-height:1.75;color:#b7b2aa;margin:0}
    @media(max-width:900px){.journey__grid{grid-template-columns:1fr 1fr;gap:28px}}
    @media(max-width:560px){.journey__grid{grid-template-columns:1fr}.journey{padding:48px 22px}}
  </style>
  <script>
    (function(){
      var form=document.querySelector('form[action="/request"]');
      if(!form)return;
      var modes=form.querySelectorAll('input[data-size-mode]');
      var labels=form.querySelectorAll('[data-size-modelabel]');
      var countEl=form.querySelector('[data-size-count]');
      function panel(n){return form.querySelector('[data-size-panel="'+n+'"]');}
      function count(){var d=0;form.querySelectorAll('[data-size-in="custom"]').forEach(function(s){if(s.value)d++;});if(countEl)countEl.textContent=d;}
      function apply(which){
        ['ready','custom'].forEach(function(n){var p=panel(n);if(p)p.hidden=(n!==which);});
        form.querySelectorAll('[data-size-in]').forEach(function(el){el.disabled=el.getAttribute('data-size-in')!==which;});
        labels.forEach(function(l){var r=l.querySelector('input');l.classList.toggle('is-active',!!(r&&r.checked));});
        if(which==='custom')count();
      }
      modes.forEach(function(r){r.addEventListener('change',function(){apply(r.getAttribute('data-size-mode'));});});
      form.querySelectorAll('[data-size-in="custom"]').forEach(function(s){s.addEventListener('change',count);});
    })();
  </script>`);
}

// ---- whatsapp deep-link (no credentials, opens a prefilled chat) ---------
const WA_DIGITS = WHATSAPP.replace(/[^0-9]/g, "");
function waLink(r) {
  if (!WA_DIGITS || !r) return "";
  const bits = [
    `Hello ${BRAND}, this is ${r.name || "a client"}.`,
    "I have just submitted a design request" +
      (r.garment ? ` for a ${r.garment}` : "") +
      (r.occasion ? ` (${r.occasion})` : "") + ".",
    r.color ? `Colour: ${r.color}.` : "",
    `Reference ${String(r.id).slice(0, 8)}.`,
  ].filter(Boolean);
  return `https://wa.me/${WA_DIGITS}?text=${encodeURIComponent(bits.join(" "))}`;
}
// designer-side: message the customer directly (their number)
function waTo(number, text) {
  const d = String(number || "").replace(/[^0-9]/g, "");
  if (!d) return "";
  return `https://wa.me/${d}?text=${encodeURIComponent(text || "")}`;
}
function thanksPage(r) {
  const wa = waLink(r);
  const waBtn = wa
    ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener" style="margin-right:12px">Send your brief on WhatsApp</a>`
    : "";
  const waLine = wa
    ? `<p class="lede" style="margin-top:-16px">You can send your brief straight to our studio on WhatsApp, or simply wait for our designer to reach you.</p>`
    : "";
  const ref = r ? `<p class="hint" style="margin-top:0">Your reference: <b>${esc(String(r.id).slice(0, 8).toUpperCase())}</b></p>` : "";
  return layout("Thank you", `<div class="wrap">
    <img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}">
    <div style="height:40px"></div>
    <p class="eyebrow">Received</p>
    <h1>Thank you.</h1>
    <p class="lede">Your design request is with our studio. A designer will contact you shortly to refine the design and arrange your fitting.</p>
    ${ref}
    ${waLine}
    <div style="margin-top:8px">${waBtn}<a class="btn btn-ghost" href="/">Start another design</a></div>
  </div>`);
}

// ---- optional new-request webhook alert (URL only, no credentials) --------
function notify(r) {
  if (!NOTIFY_WEBHOOK) return;
  try {
    const u = new URL(NOTIFY_WEBHOOK);
    const summary = `New Zaria design request: ${r.name || "client"} (${r.phone || "no phone"}) · ${r.garment || "garment"}${r.occasion ? " / " + r.occasion : ""}${r.fabric ? " · " + r.fabric : ""}. Ref ${String(r.id).slice(0, 8)}.`;
    const payload = JSON.stringify({ text: summary, request: { id: r.id, name: r.name, phone: r.phone, garment: r.garment, occasion: r.occasion, fabric: r.fabric } });
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    });
    req.on("error", () => {});
    req.write(payload); req.end();
  } catch (_) { /* never block the customer */ }
}

// ---- made-to-measure cutting pattern (1:1 / original-size PDF) -----------
const PT = 72 / 2.54; // points per cm, so 1 cm on paper = 1 cm real when printed at 100%
function mnum(v, d) { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.]/g, "")); return isFinite(n) && n > 0 ? n : d; }

function draftPattern(m, garment) {
  const height  = mnum(m.height, 0);
  const bust    = mnum(m.bust, 96);
  const hips    = mnum(m.hips, bust + 4);
  const shoulder= mnum(m.shoulder, 40);
  const sleeveL = mnum(m.sleeve, 56);
  const bicep   = mnum(m.arm, 32);
  const length  = mnum(m.length, height ? Math.round(height * 0.82) : 140);
  const bodyEase = 22;                                     // loose robe ease around the body (cm)
  const half     = (Math.max(bust, hips) + bodyEase) / 4;  // fold -> side seam at chest
  const hemHalf  = half + 16;                              // A-line flare added at hem
  const neckW = 9, neckDrop = 9, shHalf = shoulder / 2, shSlope = 5;
  const armDepth = Math.max(22, bust / 4 + 2);
  const capW = bicep + 10, wristW = Math.max(20, bicep * 0.72 + 4), capH = 12;
  const provided = {};
  ["bust","underbust","waist","hips","shoulder","sleeve","arm","length","height"].forEach(k => provided[k] = mnum(m[k], 0) > 0);
  return { garment, length, half, hemHalf, neckW, neckDrop, shHalf, shSlope, armDepth,
           bicep, sleeveL, capW, wristW, capH, provided,
           vals: { bust, hips, shoulder, sleeveL, bicep, length, waist: mnum(m.waist, 0), height } };
}

function renderPatternPDF(r, m, stream) {
  const p = draftPattern(m, r.garment || "Garment");
  const MARGIN = 3, HEADER = 22, GAP = 8;                  // all cm
  const bodyW = p.hemHalf, bodyH = p.length, sleeveW = p.capW, sleeveH = p.sleeveL + p.capH;
  const contentW = bodyW + GAP + sleeveW;
  const pageWcm = MARGIN * 2 + Math.max(contentW, 46);
  const pageHcm = MARGIN * 2 + HEADER + Math.max(bodyH, sleeveH);
  const doc = new PDFDocument({ size: [pageWcm * PT, pageHcm * PT], margin: 0 });
  doc.pipe(stream);
  const cm = (v) => v * PT;

  // header
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#111").text("ZARIA  ·  CUTTING PATTERN", cm(MARGIN), cm(MARGIN));
  const ref = String(r.id).slice(0, 8).toUpperCase();
  doc.font("Helvetica").fontSize(11).fillColor("#333")
     .text(`${r.name || "Customer"}   ·   Ref ${ref}   ·   ${p.garment}${r.occasion ? " (" + r.occasion + ")" : ""}   ·   ${new Date().toLocaleDateString()}`, cm(MARGIN), cm(MARGIN + 1.15));
  const mm = [["Bust", p.vals.bust, p.provided.bust], ["Waist", p.vals.waist, p.provided.waist], ["Hips", p.vals.hips, p.provided.hips],
              ["Shoulder", p.vals.shoulder, p.provided.shoulder], ["Sleeve", p.vals.sleeveL, p.provided.sleeve], ["Bicep", p.vals.bicep, p.provided.arm],
              ["Length", p.vals.length, p.provided.length], ["Height", p.vals.height, p.provided.height]]
    .filter(x => x[1] > 0).map(x => `${x[0]} ${x[1]}${x[2] ? "" : "*"}`).join("     ");
  doc.fontSize(10).fillColor("#444").text("Measurements (cm):  " + mm, cm(MARGIN), cm(MARGIN + 2.1), { width: cm(pageWcm - 2 * MARGIN) });
  doc.fontSize(8.5).fillColor("#888").text("* value assumed (not provided).  Lines are the finished shape — add 1.5 cm seam allowance on every edge except the fold.  Confirm the 10 cm square measures exactly 10 cm (print at 100%, no fit-to-page) before cutting.",
     cm(MARGIN), cm(MARGIN + 3.2), { width: cm(pageWcm - 2 * MARGIN - 14) });
  // 10 cm calibration square
  const csx = pageWcm - MARGIN - 12, csy = MARGIN + 0.4;
  doc.lineWidth(1).strokeColor("#111").rect(cm(csx), cm(csy), cm(10), cm(10)).stroke();
  doc.fontSize(9).fillColor("#111").text("10 cm calibration", cm(csx), cm(csy + 10.3));

  // body (fold at left)
  const bx = MARGIN, by = MARGIN + HEADER, BX = (v) => cm(bx + v), BY = (v) => cm(by + v);
  doc.lineWidth(1.4).strokeColor("#111")
     .moveTo(BX(0), BY(p.neckDrop))
     .quadraticCurveTo(BX(p.neckW * 0.55), BY(p.neckDrop * 0.35), BX(p.neckW), BY(1))
     .lineTo(BX(p.shHalf), BY(p.shSlope))
     .quadraticCurveTo(BX(p.half + 2), BY(p.armDepth - 5), BX(p.half), BY(p.armDepth))
     .lineTo(BX(p.hemHalf), BY(p.length))
     .lineTo(BX(0), BY(p.length))
     .lineTo(BX(0), BY(p.neckDrop))
     .stroke();
  doc.save().dash(5, { space: 3 }).lineWidth(0.9).strokeColor("#7a1f34").moveTo(BX(0), BY(0)).lineTo(BX(0), BY(p.length)).stroke().restore();
  doc.font("Helvetica").fontSize(11).fillColor("#7a1f34").text("PLACE ON FOLD", BX(0.4), BY(p.length / 2), { rotate: 0 });
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text("BODY  ·  cut 2 on fold", BX(4), BY(p.armDepth + 7));
  doc.font("Helvetica").fontSize(9).fillColor("#555")
     .text(`chest ½ ${p.half.toFixed(0)} cm`, BX(p.half * 0.35), BY(p.armDepth + 1))
     .text(`hem ½ ${p.hemHalf.toFixed(0)} cm`, BX(p.hemHalf * 0.45), BY(p.length - 2))
     .text(`length ${p.length.toFixed(0)} cm`, BX(0.5), BY(p.length * 0.7));

  // sleeve
  const sx = MARGIN + bodyW + GAP, sy = MARGIN + HEADER, cxs = sx + sleeveW / 2, SY = (v) => cm(sy + v);
  doc.lineWidth(1.4).strokeColor("#111")
     .moveTo(cm(sx), SY(p.capH))
     .quadraticCurveTo(cm(cxs), SY(-p.capH * 0.45), cm(sx + sleeveW), SY(p.capH))
     .lineTo(cm(cxs + p.wristW / 2), SY(p.capH + p.sleeveL))
     .lineTo(cm(cxs - p.wristW / 2), SY(p.capH + p.sleeveL))
     .lineTo(cm(sx), SY(p.capH))
     .stroke();
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text("SLEEVE  ·  cut 2", cm(sx + 2), SY(p.capH + p.sleeveL * 0.42));
  doc.font("Helvetica").fontSize(9).fillColor("#555")
     .text(`bicep ${p.capW.toFixed(0)} cm`, cm(sx + 1.5), SY(p.capH + 0.8))
     .text(`sleeve ${p.sleeveL.toFixed(0)} cm`, cm(sx + 2), SY(p.capH + p.sleeveL * 0.72));

  doc.end();
}

// ---- app -----------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ---- preview password gate ---------------------------------------------
const PREVIEW_PW = (process.env.PREVIEW_PASSWORD || "").trim();
const PREVIEW_TOKEN = PREVIEW_PW
  ? crypto.createHash("sha256").update(PREVIEW_PW + "|zaria-preview-v1").digest("hex").slice(0, 40)
  : "";

function previewPasswordPage(showError) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${BRAND} Design Studio</title>
  <style>
    *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#f6f2ec;font-family:'Jost',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#241a1e;padding:24px}
    .card{width:100%;max-width:360px;text-align:center}
    .card img{height:60px;width:auto;margin:0 0 22px}
    h1{font-weight:400;font-size:19px;letter-spacing:.02em;margin:0 0 8px}
    p{color:#7a6f70;font-size:13px;line-height:1.7;margin:0 0 22px}
    form{display:flex;flex-direction:column;gap:12px}
    input{width:100%;padding:14px 15px;border:1px solid #ddd3c9;border-radius:2px;background:#fff;font:inherit;font-size:15px;text-align:center;letter-spacing:.2em}
    input:focus{outline:none;border-color:#7a1f34;box-shadow:0 0 0 3px rgba(122,31,52,.08)}
    button{padding:14px;border:none;border-radius:2px;background:#241a1e;color:#fff;font:inherit;font-size:12px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer}
    button:hover{background:#7a1f34}
    .err{color:#b0223b;font-size:12.5px;margin:0 0 14px}
  </style></head><body>
    <div class="card">
      <img src="/brand.png" alt="${BRAND}">
      <h1>Private preview</h1>
      <p>This studio is not open to the public yet. Enter the access password to continue.</p>
      ${showError ? '<p class="err">Incorrect password. Please try again.</p>' : ""}
      <form method="post" action="/__unlock">
        <input type="password" name="pw" placeholder="Password" autocomplete="off" autofocus required>
        <button type="submit">Enter</button>
      </form>
    </div>
  </body></html>`;
}

function previewGate(req, res, next) {
  if (!PREVIEW_PW) return next();
  const p = req.path;
  if (p === "/health" || p === "/brand.png" || p === "/__unlock" || p.indexOf("/studio") === 0) return next();
  const cookies = req.headers.cookie || "";
  const m = cookies.match(/(?:^|;\s*)zpv=([a-f0-9]+)/);
  if (m && m[1] === PREVIEW_TOKEN) return next();
  return res.status(401).send(previewPasswordPage(false));
}
app.use(previewGate);

app.post("/__unlock", (req, res) => {
  if (!PREVIEW_PW) return res.redirect("/");
  const pw = ((req.body && req.body.pw) || "").toString();
  if (pw === PREVIEW_PW) {
    res.setHeader("Set-Cookie", `zpv=${PREVIEW_TOKEN}; Path=/; Max-Age=1209600; HttpOnly; SameSite=Lax`);
    return res.redirect("/");
  }
  return res.status(401).send(previewPasswordPage(true));
});

app.get("/health", (_req, res) => res.type("text").send("ok"));

app.get("/brand.png", (_req, res) => {
  res.type("png").set("Cache-Control", "public, max-age=86400").sendFile(path.join(__dirname, "brand.png"));
});

app.get("/", (req, res) => res.send(formPage(req.query || {})));

app.post("/request", (req, res) => {
  const b = req.body || {};
  const measurements = {};
  for (const [k] of MEASURES) {
    const v = (b["m_" + k] || "").toString().trim();
    if (v) measurements[k] = v;
  }
  for (const k of ["size_type", "size", "sheila"]) {
    const v = (b[k] || "").toString().trim();
    if (v) measurements[k] = v;
  }
  const id = crypto.randomUUID();
  const rec = {
    id,
    created_at: new Date().toISOString(),
    name: (b.name || "").trim(),
    email: (b.email || "").trim(),
    phone: (b.phone || "").trim(),
    garment: b.garment || "",
    occasion: b.occasion || "",
    fabric: b.fabric || "",
    color: (b.color || "").trim(),
    budget: (b.budget || "").trim(),
    event_date: b.event_date || "",
    notes: (b.notes || "").trim(),
    measurements: JSON.stringify(measurements),
    reference_url: (b.reference_url || "").trim(),
    preferred_date: b.preferred_date || "",
    boutique: b.boutique || "",
    product_ref: (b.product_ref || "").toString().trim(),
  };
  db.prepare(
    `INSERT INTO requests (id,created_at,status,name,email,phone,garment,occasion,fabric,color,budget,event_date,notes,measurements,reference_url,preferred_date,boutique,product_ref)
     VALUES (@id,@created_at,'new',@name,@email,@phone,@garment,@occasion,@fabric,@color,@budget,@event_date,@notes,@measurements,@reference_url,@preferred_date,@boutique,@product_ref)`
  ).run(rec);
  notify(rec);
  res.redirect("/thanks/" + id);
});

app.get("/thanks", (_req, res) => res.send(thanksPage(null)));
app.get("/thanks/:id", (req, res) => {
  const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  res.send(thanksPage(r || null));
});

// ---- designer dashboard (basic auth) ------------------------------------
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const [, b64] = h.split(" ");
  const [u, p] = Buffer.from(b64 || "", "base64").toString().split(":");
  if (u === STUDIO_USER && p === STUDIO_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Zaria Studio"').status(401).send("Authentication required.");
}
const pill = (s) => `<span class="pill ${STATUS_META[s] ? STATUS_META[s].cls : esc(s)}">${esc(STATUS_META[s] ? STATUS_META[s].label : s)}</span>`;
const csvCell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;

app.get("/studio", auth, (req, res) => {
  const all = db.prepare("SELECT * FROM requests ORDER BY created_at DESC").all();
  const showArchived = req.query.archived === "1";
  const status = STATUSES.includes(req.query.status) ? req.query.status : "";
  const q = (req.query.q || "").toString().trim().toLowerCase();

  const counts = { total: 0 };
  STATUSES.forEach((s) => (counts[s] = 0));
  let archivedCount = 0;
  all.forEach((r) => {
    if (r.archived) { archivedCount++; return; }
    counts.total++; counts[r.status] = (counts[r.status] || 0) + 1;
  });

  let rows = all.filter((r) => (showArchived ? r.archived : !r.archived));
  if (status) rows = rows.filter((r) => r.status === status);
  if (q) rows = rows.filter((r) =>
    [r.name, r.phone, r.email, r.fabric, r.garment, r.occasion, r.notes, r.designer_notes]
      .map((x) => (x || "").toLowerCase()).join(" ").includes(q));

  const qs = (extra) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (q) p.set("q", q);
    if (showArchived) p.set("archived", "1");
    Object.entries(extra || {}).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    const s = p.toString();
    return s ? "/studio?" + s : "/studio";
  };

  const statCard = (key, label, val) =>
    `<a class="stat ${status === key || (key === "" && !status && !showArchived) ? "is-active" : ""}" href="/studio${key ? "?status=" + encodeURIComponent(key) : ""}"><b>${val}</b><span>${esc(label)}</span></a>`;
  const stats = `<div class="stats">
    ${statCard("", "All active", counts.total)}
    ${STATUSES.map((s) => statCard(s, STATUS_META[s].label, counts[s])).join("")}
  </div>`;

  const list = rows.length
    ? rows.map((r) => `<tr class="${r.status === "new" && !r.archived ? "is-new" : ""}">
        <td class="muted" style="white-space:nowrap">${esc(new Date(r.created_at).toLocaleDateString())}</td>
        <td><b>${esc(r.name || "Unnamed")}</b><br><span class="muted">${esc(r.phone || "")}</span></td>
        <td>${esc(r.garment || "")}<br><span class="muted">${esc(r.occasion || "")}</span></td>
        <td>${esc(r.fabric || "")}</td>
        <td>${pill(r.status)}${r.designer_notes ? ' <span class="muted" title="Has designer notes">✎</span>' : ""}</td>
        <td><a href="/studio/${esc(r.id)}">Open →</a></td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted" style="padding:26px">No ${showArchived ? "archived " : ""}requests${status ? " with status “" + esc(status) + "”" : ""}${q ? " matching “" + esc(q) + "”" : ""}.</td></tr>`;

  res.send(layout("Studio", `<div class="wrap">
    <div class="topbar">
      <div><img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}"><span class="muted" style="font-size:12px;letter-spacing:.2em;text-transform:uppercase">Design Studio</span></div>
      <div class="muted" style="font-size:13px">${esc(String(counts.total))} active · ${esc(String(archivedCount))} archived</div>
    </div>
    ${stats}
    <div class="toolbar">
      <form method="get" action="/studio">
        ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ""}
        ${showArchived ? '<input type="hidden" name="archived" value="1">' : ""}
        <input type="search" name="q" value="${esc(q)}" placeholder="Search name, phone, fabric, notes…">
        <button class="btn btn-sm" type="submit">Search</button>
      </form>
      <a class="tab ${showArchived ? "is-active" : ""}" href="${showArchived ? qs({ archived: "" }) : qs({ archived: "1" })}">${showArchived ? "← Active" : "Archived (" + archivedCount + ")"}</a>
      <a class="tab" href="/studio/export.csv" title="Download all requests as CSV">Export CSV</a>
    </div>
    <div class="card" style="padding:6px 8px">
      <table><thead><tr><th>Date</th><th>Customer</th><th>Piece</th><th>Fabric</th><th>Status</th><th></th></tr></thead>
      <tbody>${list}</tbody></table>
    </div>
  </div>`, { wide: true }));
});

app.get("/studio/export.csv", auth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM requests ORDER BY created_at DESC").all();
  const cols = ["created_at", "status", "name", "phone", "email", "garment", "occasion", "fabric", "color", "budget", "event_date", "preferred_date", "boutique", "notes", "designer_notes", "reference_url", "product_ref", "archived"];
  const header = cols.join(",");
  const body = rows.map((r) => cols.map((c) => {
    if (c === "measurements") return csvCell("");
    return csvCell(r[c]);
  }).join(",")).join("\n");
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="zaria-design-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(header + "\n" + body);
});

app.get("/studio/:id", auth, (req, res) => {
  const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).send("Not found");
  let m = {};
  try { m = JSON.parse(r.measurements || "{}"); } catch {}
  const mChips = MEASURES.filter(([k]) => m[k]).map(([k, label]) => `<div class="mchip"><b>${esc(label)}</b>${esc(m[k])} cm</div>`).join("");
  const sizeLine = [m.size_type ? `<b>${esc(m.size_type)}</b>` : "", m.size ? `Size ${esc(m.size)}` : "", m.sheila ? esc(m.sheila) : ""].filter(Boolean).join(" &middot; ");
  const row = (label, val) => val ? `<dt>${esc(label)}</dt><dd>${esc(val)}</dd>` : "";
  const statusForm = `<form method="post" action="/studio/${esc(r.id)}/status" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <select name="status" style="width:auto">${STATUSES.map((s) => `<option ${s === r.status ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
    <button class="btn btn-sm">Update status</button></form>`;
  const notesForm = `<form method="post" action="/studio/${esc(r.id)}/notes">
    <textarea name="designer_notes" placeholder="Private notes: call summary, fitting date, production updates…">${esc(r.designer_notes || "")}</textarea>
    <div style="margin-top:10px"><button class="btn btn-sm">Save notes</button></div></form>`;
  const waCustomer = waTo(r.phone, `Hello ${r.name || ""}, this is ${BRAND} Design Studio regarding your design request (ref ${String(r.id).slice(0, 8).toUpperCase()}).`);

  res.send(layout(r.name || "Request", `<div class="wrap">
    <div class="topbar">
      <img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}">
      <a class="muted" href="/studio">← All requests</a>
    </div>
    <p class="eyebrow">Design request · ${pill(r.status)}${r.archived ? ' · <span class="muted">archived</span>' : ""}</p>
    <h1 style="margin-bottom:6px">${esc(r.name || "Design request")}</h1>
    <p class="muted" style="margin:0 0 16px">${esc(r.phone || "")}${r.email ? " · " + esc(r.email) : ""} · received ${esc(new Date(r.created_at).toLocaleString())}</p>
    <div style="margin:0 0 24px;display:flex;gap:10px;flex-wrap:wrap">
      ${waCustomer ? `<a class="btn btn-sm" href="${esc(waCustomer)}" target="_blank" rel="noopener">WhatsApp customer</a>` : ""}
      <form method="post" action="/studio/${esc(r.id)}/archive" style="display:inline"><button class="btn btn-sm btn-ghost">${r.archived ? "Unarchive" : "Archive"}</button></form>
      <form method="post" action="/studio/${esc(r.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this request permanently? This cannot be undone.')"><button class="btn btn-sm btn-danger">Delete</button></form>
    </div>

    <div class="card">
      <dl class="dl">
        ${row("Garment", r.garment)}${row("Occasion", r.occasion)}
        ${r.fabric ? `<dt>Fabric</dt><dd>${esc(r.fabric)}${r.product_ref ? ` &nbsp;<a href="${esc(STORE_URL + "/products/" + encodeURIComponent(r.product_ref))}" target="_blank" rel="noopener" style="color:var(--wine);font-size:12px;letter-spacing:.02em">↗ view in store</a>` : ""}</dd>` : ""}${row("Colour", r.color)}
        ${row("Event date", r.event_date)}${row("Budget", r.budget)}
        ${row("Consultation", [r.preferred_date, r.boutique].filter(Boolean).join(" · "))}
        ${r.reference_url ? `<dt>References</dt><dd><a href="${esc(r.reference_url)}" target="_blank" rel="noopener">${esc(r.reference_url)}</a></dd>` : ""}
      </dl>
      ${r.notes ? `<p class="section-h">Design brief</p><p style="white-space:pre-wrap;margin:0">${esc(r.notes)}</p>` : ""}
      <p class="section-h">Size &amp; measurements</p>
      ${sizeLine ? `<p style="margin:0 0 ${mChips ? "12px" : "0"}">${sizeLine}</p>` : ""}
      ${mChips ? `<div class="mgrid">${mChips}</div>` : (sizeLine ? "" : `<p class="muted" style="margin:0">To be taken at the fitting.</p>`)}
      <div style="margin-top:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <a class="btn btn-sm" href="/studio/${esc(r.id)}/pattern.pdf" target="_blank" rel="noopener">Cutting pattern &middot; 1:1 PDF</a>
        <span class="muted" style="font-size:12.5px">Original-size body + sleeve block, drafted from these measurements. ${mChips ? "" : "<b>No measurements yet</b> — standard-size defaults will be used."}</span>
      </div>
      <p class="section-h">Designer notes</p>
      ${notesForm}
      <p class="section-h">Status</p>
      ${statusForm}
    </div>
  </div>`));
});

app.post("/studio/:id/status", auth, (req, res) => {
  const s = (req.body.status || "").toString();
  if (STATUSES.includes(s)) db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(s, req.params.id);
  res.redirect("/studio/" + req.params.id);
});
app.post("/studio/:id/notes", auth, (req, res) => {
  db.prepare("UPDATE requests SET designer_notes = ? WHERE id = ?").run((req.body.designer_notes || "").toString().trim(), req.params.id);
  res.redirect("/studio/" + req.params.id);
});
app.post("/studio/:id/archive", auth, (req, res) => {
  const r = db.prepare("SELECT archived FROM requests WHERE id = ?").get(req.params.id);
  const next = r && r.archived ? 0 : 1;
  db.prepare("UPDATE requests SET archived = ? WHERE id = ?").run(next, req.params.id);
  res.redirect(next ? "/studio" : "/studio/" + req.params.id);
});
app.post("/studio/:id/delete", auth, (req, res) => {
  db.prepare("DELETE FROM requests WHERE id = ?").run(req.params.id);
  res.redirect("/studio");
});

// Original-size (1:1) cutting pattern PDF, drafted from the request's measurements
app.get("/studio/:id/pattern.pdf", auth, (req, res) => {
  const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).send("Not found");
  let m = {}; try { m = JSON.parse(r.measurements || "{}"); } catch {}
  const safe = (r.name || "customer").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "customer";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="zaria-cutting-${safe}-${String(r.id).slice(0, 8)}.pdf"`);
  try { renderPatternPDF(r, m, res); }
  catch (e) { if (!res.headersSent) res.status(500).send("Could not build pattern: " + e.message); }
});

app.listen(PORT, () => console.log(`${BRAND} Design Studio listening on :${PORT}`));
