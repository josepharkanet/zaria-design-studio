/*
 * Zaria Design Studio, Phase 1.
 * Customer "Design Your Look" request + measurement capture, and a
 * password-protected designer dashboard. Self-contained (Express + SQLite),
 * deployable on Coolify. No Shopify app install required.
 */
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const BRAND = process.env.BRAND_NAME || "Zaria";
const STORE_URL = (process.env.STORE_URL || "https://zaria-collections-2.myshopify.com").replace(/\/+$/, "");
const STUDIO_USER = process.env.STUDIO_USER || "designer";
const STUDIO_PASS = process.env.STUDIO_PASS || "zaria";
const WHATSAPP = process.env.WHATSAPP || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

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
// Migration: remember the exact catalogue fabric/product a request was started from
try { db.exec("ALTER TABLE requests ADD COLUMN product_ref TEXT"); } catch (_) { /* column already exists */ }

const GARMENTS = ["Gown", "Abaya", "Jalabiya", "Kaftan", "Two-piece", "Other"];
const OCCASIONS = ["Wedding", "Engagement", "Eid", "Party / Evening", "Everyday", "Other"];
const FABRICS = ["Luxe Silk", "Fine Cotton", "Chiffon & Organza", "Velvet", "Tulle & 3D Work", "Sequins & Embroidery", "Hand-Painted", "Not sure, advise me"];
const BOUTIQUES = ["Dubai boutique", "Online / video consultation"];
const MEASURES = [
  ["bust", "Bust"], ["underbust", "Underbust"], ["waist", "Waist"], ["hips", "Hips"],
  ["shoulder", "Shoulder width"], ["sleeve", "Sleeve length"], ["arm", "Arm / bicep"],
  ["length", "Total length"], ["height", "Height"],
];
const STATUSES = ["new", "contacted", "measured", "in production", "delivered"];

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
  .wrap{max-width:${wide ? "1080px" : "660px"};margin:0 auto;padding:56px 24px 88px}
  .brand{font-family:"Jost",sans-serif;font-weight:500;font-size:22px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink);line-height:1}
  .brand-logo{display:block;height:42px;width:auto}
  .topbar .brand-logo{height:34px}
  .eyebrow{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
  h1{font-family:"Jost",sans-serif;font-weight:400;font-size:clamp(28px,4.4vw,42px);line-height:1.14;letter-spacing:.05em;text-transform:uppercase;margin:0 0 16px}
  p.lede{color:var(--muted);font-size:16px;line-height:1.75;margin:0 0 30px;max-width:58ch}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:32px}
  label{display:block;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
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
    font-family:"Jost",sans-serif;font-size:12px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;transition:opacity .2s ease}
  .btn:hover{opacity:.85}
  .btn-ghost{background:#fff;color:var(--ink);border:1px solid var(--ink)}
  .btn-ghost:hover{background:var(--ink);color:#fff;opacity:1}
  a{color:var(--ink)}
  .muted{color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:14.5px}
  th,td{text-align:left;padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:600}
  tbody tr:hover{background:var(--soft)}
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
  footer{margin-top:56px;padding-top:22px;border-top:1px solid var(--line);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#9a9a9a;text-align:center}
  @media(max-width:560px){.row,.grid3{grid-template-columns:1fr}.dl{grid-template-columns:1fr;gap:4px 0}.dl dt{padding-top:12px}.wrap{padding:40px 20px 64px}}
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
  const measures = MEASURES.map(
    ([k, label]) => `<div class="field" style="margin-bottom:0">
      <label>${esc(label)} (cm)</label>
      <input type="text" name="m_${k}" inputmode="decimal" autocomplete="off">
    </div>`
  ).join("");

  return layout("Design Your Look", `<div class="wrap">
    <img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}">
    <div style="height:34px"></div>
    <p class="eyebrow">The Design Studio</p>
    <h1>Design your look</h1>
    <p class="lede">Tell us about the piece you have in mind. One of our designers will reach out to refine the design, confirm your measurements and guide you to a finished garment made only for you.</p>
    ${fabricBanner}

    <form class="card" method="post" action="/request">
      ${hiddenFabric}
      <p class="section-h" style="margin-top:0;border-top:none;padding-top:0">Your details</p>
      <div class="row">
        <div class="field"><label>Full name</label><input name="name" required></div>
        <div class="field"><label>Phone / WhatsApp</label><input name="phone" required></div>
      </div>
      <div class="field"><label>Email</label><input type="email" name="email"></div>

      <p class="section-h">The piece</p>
      <div class="row">
        <div class="field"><label>Garment</label>${optionList(GARMENTS, "garment", true)}</div>
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

      <p class="section-h">Measurements <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">(optional, or take them at your fitting)</span></p>
      <p class="hint">Leave blank if you are unsure. Our designer will measure you precisely during the fitting.</p>
      <div class="grid3">${measures}</div>

      <p class="section-h">Consultation</p>
      <div class="row">
        <div class="field"><label>Preferred date</label><input type="date" name="preferred_date"></div>
        <div class="field"><label>Where</label>${optionList(BOUTIQUES, "boutique", false)}</div>
      </div>

      <div style="margin-top:24px"><button class="btn" type="submit">Send my design request</button></div>
      ${WHATSAPP ? `<p class="hint" style="margin-top:16px">Prefer to chat? WhatsApp us at ${esc(WHATSAPP)}.</p>` : ""}
    </form>
  </div>`);
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
function thanksPage(r) {
  const wa = waLink(r);
  const waBtn = wa
    ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener" style="margin-right:12px">Send your brief on WhatsApp</a>`
    : "";
  const waLine = wa
    ? `<p class="lede" style="margin-top:-16px">You can send your brief straight to our studio on WhatsApp, or simply wait for our designer to reach you.</p>`
    : "";
  return layout("Thank you", `<div class="wrap">
    <img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}">
    <div style="height:40px"></div>
    <p class="eyebrow">Received</p>
    <h1>Thank you.</h1>
    <p class="lede">Your design request is with our studio. A designer will contact you shortly to refine the design and arrange your fitting.</p>
    ${waLine}
    <div style="margin-top:8px">${waBtn}<a class="btn btn-ghost" href="/">Start another design</a></div>
  </div>`);
}

// ---- app -----------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ---- preview password gate ---------------------------------------------
// Protects the customer-facing preview. Set PREVIEW_PASSWORD in the deployment
// env to activate it; leave it unset to keep the studio open. The password value
// is never stored in code — it lives only in the env.
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
  if (!PREVIEW_PW) return next(); // gate off unless a password is configured
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

// Brand logo (burgundy Zaria wordmark), served from the app directory
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
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO requests (id,created_at,status,name,email,phone,garment,occasion,fabric,color,budget,event_date,notes,measurements,reference_url,preferred_date,boutique,product_ref)
     VALUES (@id,@created_at,'new',@name,@email,@phone,@garment,@occasion,@fabric,@color,@budget,@event_date,@notes,@measurements,@reference_url,@preferred_date,@boutique,@product_ref)`
  ).run({
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
  });
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
const pill = (s) => `<span class="pill ${s === "in production" ? "production" : esc(s)}">${esc(s)}</span>`;

app.get("/studio", auth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM requests ORDER BY created_at DESC").all();
  const counts = STATUSES.map((s) => `${rows.filter((r) => r.status === s).length} ${s}`).join(" · ");
  const list = rows.length
    ? rows.map((r) => `<tr>
        <td class="muted" style="white-space:nowrap">${esc(new Date(r.created_at).toLocaleDateString())}</td>
        <td><b>${esc(r.name || "Unnamed")}</b><br><span class="muted">${esc(r.phone || "")}</span></td>
        <td>${esc(r.garment || "")}<br><span class="muted">${esc(r.occasion || "")}</span></td>
        <td>${esc(r.fabric || "")}</td>
        <td>${pill(r.status)}</td>
        <td><a href="/studio/${esc(r.id)}">Open →</a></td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted" style="padding:26px">No design requests yet.</td></tr>`;

  res.send(layout("Studio", `<div class="wrap">
    <div class="topbar">
      <div><img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}"><span class="muted" style="font-size:12px;letter-spacing:.2em;text-transform:uppercase">Design Studio</span></div>
      <div class="muted" style="font-size:13px">${esc(String(rows.length))} requests · ${esc(counts)}</div>
    </div>
    <div class="card" style="padding:6px 8px">
      <table><thead><tr><th>Date</th><th>Customer</th><th>Piece</th><th>Fabric</th><th>Status</th><th></th></tr></thead>
      <tbody>${list}</tbody></table>
    </div>
  </div>`, { wide: true }));
});

app.get("/studio/:id", auth, (req, res) => {
  const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).send("Not found");
  let m = {};
  try { m = JSON.parse(r.measurements || "{}"); } catch {}
  const mChips = MEASURES.filter(([k]) => m[k]).map(([k, label]) => `<div class="mchip"><b>${esc(label)}</b>${esc(m[k])} cm</div>`).join("");
  const row = (label, val) => val ? `<dt>${esc(label)}</dt><dd>${esc(val)}</dd>` : "";
  const statusForm = `<form method="post" action="/studio/${esc(r.id)}/status" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <select name="status" style="width:auto">${STATUSES.map((s) => `<option ${s === r.status ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
    <button class="btn" style="padding:10px 20px">Update status</button></form>`;

  res.send(layout(r.name || "Request", `<div class="wrap">
    <div class="topbar">
      <img class="brand-logo" src="/brand.png" alt="${esc(BRAND)}">
      <a class="muted" href="/studio">← All requests</a>
    </div>
    <p class="eyebrow">Design request · ${pill(r.status)}</p>
    <h1 style="margin-bottom:6px">${esc(r.name || "Design request")}</h1>
    <p class="muted" style="margin:0 0 24px">${esc(r.phone || "")}${r.email ? " · " + esc(r.email) : ""} · received ${esc(new Date(r.created_at).toLocaleString())}</p>

    <div class="card">
      <dl class="dl">
        ${row("Garment", r.garment)}${row("Occasion", r.occasion)}
        ${r.fabric ? `<dt>Fabric</dt><dd>${esc(r.fabric)}${r.product_ref ? ` &nbsp;<a href="${esc(STORE_URL + "/products/" + encodeURIComponent(r.product_ref))}" target="_blank" rel="noopener" style="color:var(--wine);font-size:12px;letter-spacing:.02em">↗ view in store</a>` : ""}</dd>` : ""}${row("Colour", r.color)}
        ${row("Event date", r.event_date)}${row("Budget", r.budget)}
        ${row("Consultation", [r.preferred_date, r.boutique].filter(Boolean).join(" · "))}
        ${r.reference_url ? `<dt>References</dt><dd><a href="${esc(r.reference_url)}" target="_blank" rel="noopener">${esc(r.reference_url)}</a></dd>` : ""}
      </dl>
      ${r.notes ? `<p class="section-h">Design brief</p><p style="white-space:pre-wrap;margin:0">${esc(r.notes)}</p>` : ""}
      ${mChips ? `<p class="section-h">Measurements</p><div class="mgrid">${mChips}</div>` : `<p class="section-h">Measurements</p><p class="muted" style="margin:0">To be taken at the fitting.</p>`}
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

app.listen(PORT, () => console.log(`${BRAND} Design Studio listening on :${PORT}`));
