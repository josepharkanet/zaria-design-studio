# Zaria Design Studio

Self-contained service for Zaria's custom-tailoring workflow.

## Status (handoff — 2026-08-03)
**Done & committed:** Design Your Look form (garment / occasion / fabric / colour /
budget / event date / full measurements / reference link / preferred slot / boutique)
→ SQLite → designer dashboard at `/studio` (basic-auth) with per-request brief,
measurement chips, and status tracking (new → contacted → measured → in production →
delivered). Styling: **black & white, western-classical**, brand font **Jost**
(same as the Elixir theme). Smoke-tested locally (form, submit, dashboard, auth).

**Next steps (not done):**
1. Push this folder to a GitHub repo (no remote yet) — `gh` CLI not installed here,
   create the repo in the browser or install `gh`.
2. Deploy on Coolify: new app from the repo, Dockerfile is ready, add a **persistent
   volume at `/app/data`**, set env `STUDIO_USER` / `STUDIO_PASS` / `BRAND_NAME=Zaria`
   / optional `WHATSAPP`, assign a subdomain.
3. Wire a **"Design Your Look"** button into the Zaria storefront (theme repo
   `~/Desktop/Zaria - Shopify`) pointing at the deployed URL.
4. Optional: customer + team confirmation on submit (WhatsApp deep-link is zero-cred;
   email needs SMTP creds).


- **Customer**: a "Design Your Look" form (garment, occasion, fabric, colour,
  full measurements, reference links, preferred consultation slot). Each
  submission is stored as a design request.
- **Designer**: a password-protected dashboard (`/studio`) that lists requests,
  shows the full brief + measurements per customer, and tracks status
  (new → contacted → measured → in production → delivered).

Storefront links a "Design Your Look" button to `/` (or embeds it later).
Stores data in SQLite (`data/studio.db`), deployable on Coolify (Dockerfile,
port 3000, volume at `/app/data`).

## Run
```
npm install
STUDIO_USER=designer STUDIO_PASS=change-me npm start
```
Open `http://localhost:3000` (customer form) and `http://localhost:3000/studio`
(dashboard).

## Env
- `PORT` (default 3000)
- `DATA_DIR` (default `./data`) — mount a volume here in production
- `STUDIO_USER` / `STUDIO_PASS` — dashboard login
- `BRAND_NAME` (default "Zaria")
- `WHATSAPP` — optional WhatsApp number shown to customers

## Roadmap
Booking slots + email/WhatsApp confirmations · reference photo upload ·
link to Shopify customer/order · bilingual AR/EN + RTL.
