/*
 * Zaria Design Studio — Phase 1.
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

const GARMENTS = ["Gown", "Abaya", "Jalabiya", "Kaftan", "Two-piece", "Other"];
const OCCASIONS = ["Wedding", "Engagement", "Eid", "Party / Evening", "Everyday", "Other"];
const FABRICS = ["Luxe Silk", "Fine Cotton", "Chiffon & Organza", "Velvet", "Tulle & 3D Work", "Sequins & Embroidery", "Hand-Painted", "Not sure — advise me"];
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--ink:#111111;--ivory:#ffffff;--paper:#ffffff;--gold:#111111;--muted:#6a6a6a;--line:#e2e2e2;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ivory);color:var(--ink);
    font-family:"Jost",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
  .serif{font-family:"Jost",-apple-system,sans-serif}
  .wrap{max-width:${wide ? "1080px" : "640px"};margin:0 auto;padding:44px 22px 72px}
  .brand{font-family:"Jost",sans-serif;font-weight:500;font-size:20px;letter-spacing:.34em;text-transform:uppercase;color:var(--ink)}
  .eyebrow{font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
  h1{font-family:"Jost",sans-serif;font-weight:400;font-size:clamp(26px,4.4vw,40px);line-height:1.14;letter-spacing:.05em;text-transform:uppercase;margin:0 0 14px}
  p.lede{color:var(--muted);font-size:16px;margin:0 0 26px;max-width:56ch}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:28px}
  label{display:block;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 7px}
  .field{margin-bottom:18px}
  input,select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:2px;background:#fff;
    font:inherit;color:var(--ink)}
  input:focus,select:focus,textarea:focus{outline:none;border-color:#111;box-shadow:0 0 0 3px rgba(17,17,17,.10)}
  textarea{min-height:96px;resize:vertical}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .section-h{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink);margin:30px 0 6px;padding-top:22px;border-top:1px solid var(--line)}
  .hint{font-size:12.5px;color:var(--muted);margin:-8px 0 16px}
  .btn{display:inline-block;background:var(--ink);color:#fff;border:none;border-radius:2px;padding:14px 30px;
    font-size:13px;letter-spacing:.16em;text-transform:uppercase;cursor:pointer}
  .btn:hover{background:#000}
  .btn-ghost{background:#fff;color:var(--ink);border:1px solid var(--ink)}
  a{color:var(--ink)}
  .muted{color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .pill{display:inline-block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:2px;border:1px solid var(--line);background:#f4f4f4;color:#333;white-space:nowrap}
  .pill.new{background:#111;color:#fff;border-color:#111}
  .pill.contacted{background:#fff;color:#111;border-color:#111}
  .pill.measured{background:#efefef;color:#111}
  .pill.production{background:#e6e6e6;color:#111}
  .pill.delivered{background:#f7f7f7;color:#777}
  .dl{display:grid;grid-template-columns:170px 1fr;gap:8px 18px;font-size:14px}
  .dl dt{color:var(--muted);font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px}
  .dl dd{margin:0}
  .mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:8px}
  .mchip{border:1px solid var(--line);border-radius:2px;padding:8px 10px;background:#fff}
  .mchip b{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px;flex-wrap:wrap;gap:10px}
  footer{margin-top:40px;font-size:12px;color:var(--muted);text-align:center}
  @media(max-width:560px){.row,.grid3{grid-template-columns:1fr}.dl{grid-template-columns:1fr}}
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

function formPage() {
  const measures = MEASURES.map(
    ([k, label]) => `<div class="field" style="margin-bottom:0">
      <label>${esc(label)} (cm)</label>
      <input type="text" name="m_${k}" inputmode="decimal" autocomplete="off">
    </div>`
  ).join("");

  return layout("Design Your Look", `<div class="wrap">
    <div class="brand">${esc(BRAND)}</div>
    <div style="height:34px"></div>
    <p class="eyebrow">The Design Studio</p>
    <h1>Design your look</h1>
    <p class="lede">Tell us about the piece you have in mind. One of our designers will reach out to refine the design, confirm your measurements and guide you to a finished garment made only for you.</p>

    <form class="card" method="post" action="/request">
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
      <div class="row">
        <div class="field"><label>Fabric preference</label>${optionList(FABRICS, "fabric", false)}</div>
        <div class="field"><label>Colour</label><input name="color" placeholder="e.g. ivory, emerald, black"></div>
      </div>
      <div class="row">
        <div class="field"><label>Event date (if any)</label><input type="date" name="event_date"></div>
        <div class="field"><label>Budget range (optional)</label><input name="budget" placeholder="AED"></div>
      </div>
      <div class="field"><label>Describe the design</label>
        <textarea name="notes" placeholder="Silhouette, sleeves, neckline, embroidery, inspiration… paste reference image links here too."></textarea>
      </div>
      <div class="field"><label>Reference links (optional)</label>
        <input name="reference_url" placeholder="Pinterest / Instagram / image URLs"></div>

      <p class="section-h">Measurements <span class="muted" style="text-transform:none;letter-spacing:0">— optional, or take them at the consultation</span></p>
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

// ---- app -----------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/health", (_req, res) => res.type("text").send("ok"));

app.get("/", (_req, res) => res.send(formPage()));

app.post("/request", (req, res) => {
  const b = req.body || {};
  const measurements = {};
  for (const [k] of MEASURES) {
    const v = (b["m_" + k] || "").toString().trim();
    if (v) measurements[k] = v;
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO requests (id,created_at,status,name,email,phone,garment,occasion,fabric,color,budget,event_date,notes,measurements,reference_url,preferred_date,boutique)
     VALUES (@id,@created_at,'new',@name,@email,@phone,@garment,@occasion,@fabric,@color,@budget,@event_date,@notes,@measurements,@reference_url,@preferred_date,@boutique)`
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
  });
  res.redirect("/thanks");
});

app.get("/thanks", (_req, res) => {
  res.send(layout("Thank you", `<div class="wrap">
    <div class="brand">${esc(BRAND)}</div>
    <div style="height:40px"></div>
    <p class="eyebrow">Received</p>
    <h1>Thank you.</h1>
    <p class="lede">Your design request is with our studio. A designer will contact you shortly to refine the design and arrange your fitting.</p>
    <a class="btn btn-ghost" href="/">Start another design</a>
  </div>`));
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
        <td><b>${esc(r.name || "—")}</b><br><span class="muted">${esc(r.phone || "")}</span></td>
        <td>${esc(r.garment || "—")}<br><span class="muted">${esc(r.occasion || "")}</span></td>
        <td>${esc(r.fabric || "—")}</td>
        <td>${pill(r.status)}</td>
        <td><a href="/studio/${esc(r.id)}">Open →</a></td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted" style="padding:26px">No design requests yet.</td></tr>`;

  res.send(layout("Studio", `<div class="wrap">
    <div class="topbar">
      <div><div class="brand">${esc(BRAND)}</div><span class="muted" style="font-size:12px;letter-spacing:.2em;text-transform:uppercase">Design Studio</span></div>
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
      <div class="brand">${esc(BRAND)}</div>
      <a class="muted" href="/studio">← All requests</a>
    </div>
    <p class="eyebrow">Design request · ${pill(r.status)}</p>
    <h1 style="margin-bottom:6px">${esc(r.name || "—")}</h1>
    <p class="muted" style="margin:0 0 24px">${esc(r.phone || "")}${r.email ? " · " + esc(r.email) : ""} · received ${esc(new Date(r.created_at).toLocaleString())}</p>

    <div class="card">
      <dl class="dl">
        ${row("Garment", r.garment)}${row("Occasion", r.occasion)}
        ${row("Fabric", r.fabric)}${row("Colour", r.color)}
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
