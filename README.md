# Zaria Design Studio

Self-contained service for Zaria's custom-tailoring workflow.

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
