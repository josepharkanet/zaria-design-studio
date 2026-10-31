// Gate the whole app behind a Shopify admin sign-in (OAuth authorization-code flow).
//
// Anyone with staff/admin access to THIS store can sign in; nobody else gets in.
// Visiting any protected page with no session bounces to Shopify's own login, then
// back here. A signed, httpOnly session cookie then rides along on every same-origin
// request — page loads, the new-tab invoice/label/pickup prints (window.open), and the
// Quiqup fetch() calls — so the existing UI keeps working unchanged. (A bearer token would
// break the new-tab prints, which is why this uses a cookie.)
//
// Public (never gated): the Google Merchant feed, the storefront /flag intake, and the
import crypto from 'node:crypto';

const STORE = process.env.SHOPIFY_STORE;                 // zaria-collections-2.myshopify.com
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;         // custom-app API key
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET; // custom-app secret (shpss_...)

// Scope asked for at sign-in — must be a subset of the app's configured scopes.
// read_products is always present; kept minimal because the flow only proves the
// person can access the store, it isn't used to call the API with their token.
const AUTH_SCOPE = process.env.AUTH_SCOPE || 'read_products';

// Public base URL of this deployment, for the OAuth redirect_uri. This exact value
// + '/auth/callback' must be whitelisted in the app config (Allowed redirection URLs).
const APP_URL = (process.env.APP_URL || 'https://ops.zaria.ae').replace(/\/+$/, '');

// Secret for signing session cookies. Defaults to a value derived from the app secret
// so the gate works with no new env var and stays stable across redeploys; set
// SESSION_SECRET to rotate (which signs everyone out).
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update('zaria-sess|' + (CLIENT_SECRET || 'x')).digest('hex');
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

const SESS_COOKIE = 'zaria_sess';
const STATE_COOKIE = 'zaria_oauth';

// ---- cookie helpers (no dependency) ----
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  // SameSite=None, not Lax: the Shopify admin renders this app in a cross-site iframe, and a
  // Lax cookie is never sent on those requests — the session would look missing on every
  // embedded load. CSRF protection comes from the Origin check in requireShopifyAuth instead.
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'Secure', 'SameSite=None'];
  if (httpOnly) bits.push('HttpOnly');
  if (maxAge != null) bits.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  arr.push(bits.join('; '));
  res.setHeader('Set-Cookie', arr);
}
const clearCookie = (res, name) => setCookie(res, name, '', { maxAge: 0 });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// session token = base64url(json).hmac
function makeSession() {
  const payload = b64u(JSON.stringify({ shop: STORE, iat: Date.now() }));
  return payload + '.' + sign(payload);
}
function validSession(token) {
  if (!token || !token.includes('.')) return false;
  const i = token.lastIndexOf('.');
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEq(sig, sign(payload))) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (obj.shop !== STORE) return false;
    if (Date.now() - Number(obj.iat) > SESSION_DAYS * 864e5) return false;
    return true;
  } catch { return false; }
}

// Verify Shopify's OAuth callback HMAC (per Shopify docs: drop hmac/signature, sort the
// remaining params, join key=value with &, HMAC-SHA256 with the app secret).
function verifyShopifyHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || typeof hmac !== 'string') return false;
  const msg = Object.keys(rest).sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', CLIENT_SECRET || '').update(msg).digest('hex');
  return safeEq(digest, hmac);
}

// ---- proving the request came from the Shopify admin ----
//
// When the admin loads this app in its iframe it signs the URL, so an embedded load can
// prove itself with no redirect at all. That matters because the OAuth screen sends
// `X-Frame-Options: DENY` — bouncing to it from inside the iframe just renders a broken
// page, which is exactly what the embedded app was doing.
//
// Two signed forms arrive, newest first:
//   id_token  a JWT signed HS256 with the app secret (current embedded apps)
//   hmac      the classic signed query string
const MAX_SKEW_MS = 5 * 60 * 1000;

function verifyIdToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [head, body, sig] = parts;
  const expect = crypto.createHmac('sha256', CLIENT_SECRET || '').update(head + '.' + body).digest('base64url');
  if (!safeEq(sig, expect)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const now = Date.now() / 1000;
    if (p.aud !== CLIENT_ID) return false;
    if (p.exp && now > Number(p.exp) + 5) return false;
    if (p.nbf && now < Number(p.nbf) - 5) return false;
    // dest/iss name the shop this token was minted for
    const host = String(p.dest || p.iss || '').replace(/^https?:\/\//, '').split('/')[0];
    return host === STORE;
  } catch { return false; }
}

function verifySignedQuery(q) {
  if (!q || !q.hmac) return false;
  if (q.shop !== STORE) return false;
  const ts = Number(q.timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return false;
  return verifyShopifyHmac(q);
}

// True when Shopify itself vouched for this request.
function shopifyVouched(req) {
  return verifyIdToken(req.query && req.query.id_token) || verifySignedQuery(req.query || {});
}

// The admin navigates its iframe to this app, so a browser that is framing us says so.
function isFramed(req) {
  const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  return dest === 'iframe' || req.query?.embedded === '1' || !!req.query?.host;
}

// Cross-site cookies are sent on any request now, so mutating calls must prove they came
// from our own page rather than someone else's. Browsers always send Origin on POST.
// "Our own page" means the host this request actually arrived on, not just APP_URL — the app
// answers on its custom domain, its sslip.io address and localhost in development, and all
// three are legitimately the same origin as the page that called them.
function selfOrigins(req) {
  const out = new Set([APP_URL]);
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    const proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
    out.add(`${proto}://${host}`);
  }
  return out;
}
function sameOrigin(req) {
  const allowed = selfOrigins(req);
  const origin = req.headers.origin;
  if (origin) return allowed.has(origin.replace(/\/+$/, ''));
  const ref = req.headers.referer;
  if (ref) { try { return allowed.has(new URL(ref).origin); } catch { return false; } }
  return false;
}

// Break out of the iframe to run OAuth at the top level, where framing rules do not apply.
function breakOutToAuth(res, target) {
  const url = APP_URL + target;
  res.status(200).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Signing in…</title>` +
    `<body style="font:14px -apple-system,sans-serif;padding:24px;color:#444">Opening Shopify sign-in…` +
    `<script>var u=${JSON.stringify(url)};` +
    `if(window.top===window.self){location.href=u}else{window.top.location.href=u}</script>` +
    `<noscript><a href="${url}" target="_top">Continue to sign in</a></noscript></body>`
  );
}

// Paths the host app declares public on top of ours, passed to mountAuth. The Design
// Studio needs POST /api/request open, because the storefront's Design Your Look form
// posts to it from zaria.ae; gating that silently breaks the live form.
let extraPublic = [];

// Paths that never require sign-in.
function isPublic(pathname) {
  if (extraPublic.includes(pathname)) return true;
  return (
    // Quiqup posts delivery transitions here from its own servers: no Shopify session and
    // no signed admin URL, so the gate would 401 every webhook and the order status would
    // silently never move. The route proves itself instead with the HMAC over
    // "{timestamp}.{raw body}" — see verifyWebhook in dispatch.js.
    pathname === '/dispatch/courier/webhook' ||
    pathname === '/auth' ||
    pathname === '/auth/callback' ||
    pathname === '/logout' ||
    pathname === '/favicon.ico' ||
    pathname === '/healthz'
  );
}

// Middleware: allow public paths and valid sessions; otherwise start the Shopify sign-in.
export function requireShopifyAuth(req, res, next) {
  if (isPublic(req.path)) return next();

  // Loaded inside the Shopify admin: the signed URL already proves the person has admin
  // access to this store, so mint the session there and then. No redirect, which is what
  // the embedded app needs — the OAuth screen refuses to be framed.
  if (shopifyVouched(req)) {
    setCookie(res, SESS_COOKIE, makeSession(), { maxAge: SESSION_DAYS * 86400 });
    return next();
  }

  const cookies = parseCookies(req);
  if (validSession(cookies[SESS_COOKIE])) {
    // The session cookie now travels cross-site, so anything that changes data has to come
    // from our own page. Reads stay open so prints and downloads keep working.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return res.status(403).json({ error: 'Request blocked: it did not come from the app.' });
    }
    return next();
  }

  const wantsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
  if (wantsHtml) {
    const ret = req.originalUrl && req.originalUrl !== '/' ? req.originalUrl : '';
    const target = '/auth' + (ret ? '?return=' + encodeURIComponent(ret) : '');
    // Inside a frame a 302 to Shopify dies on X-Frame-Options, so escape to the top window.
    if (isFramed(req)) return breakOutToAuth(res, target);
    return res.redirect(target);
  }
  return res.status(401).json({ error: 'Not signed in — open the app and sign in with your Shopify account.' });
}

export function mountAuth(app, opts = {}) {
  extraPublic = Array.isArray(opts.publicPaths) ? opts.publicPaths : [];
  if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
    console.warn('[auth] SHOPIFY_STORE / CLIENT_ID / CLIENT_SECRET missing — the sign-in gate cannot work.');
  }

  // Start sign-in: bounce to Shopify's OAuth authorize, which forces a Shopify login.
  app.get('/auth', (req, res) => {
    const nonce = b64u(crypto.randomBytes(16));
    const ret = typeof req.query.return === 'string' && req.query.return.startsWith('/') ? req.query.return : '';
    const stateVal = nonce + '|' + ret;
    setCookie(res, STATE_COOKIE, stateVal + '.' + sign(stateVal), { maxAge: 600 }); // 10 min
    const u = new URL(`https://${STORE}/admin/oauth/authorize`);
    u.searchParams.set('client_id', CLIENT_ID);
    u.searchParams.set('scope', AUTH_SCOPE);
    u.searchParams.set('redirect_uri', APP_URL + '/auth/callback');
    u.searchParams.set('state', nonce);
    res.redirect(u.toString());
  });

  // Return from Shopify: verify everything, then set the session cookie.
  app.get('/auth/callback', async (req, res) => {
    const fail = (m) => res.status(403).send(`Sign-in failed: ${m}. <a href="/auth">Try again</a>`);
    try {
      const q = req.query;
      // 1) state must match our signed cookie (CSRF protection)
      const raw = parseCookies(req)[STATE_COOKIE] || '';
      const dot = raw.lastIndexOf('.');
      if (dot < 1) return fail('missing state');
      const stateVal = raw.slice(0, dot);
      if (!safeEq(raw.slice(dot + 1), sign(stateVal))) return fail('bad state');
      const [expectNonce, ret] = stateVal.split('|');
      if (!q.state || !safeEq(String(q.state), expectNonce)) return fail('state mismatch');
      // 2) shop must be our store
      if (q.shop !== STORE) return fail('wrong store');
      // 3) HMAC must verify with the app secret
      if (!verifyShopifyHmac(q)) return fail('bad signature');
      // 4) exchange the code — only a genuine Shopify authorization can be exchanged
      if (!q.code) return fail('no code');
      const r = await fetch(`https://${STORE}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: q.code }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.access_token) return fail('token exchange rejected');

      clearCookie(res, STATE_COOKIE);
      setCookie(res, SESS_COOKIE, makeSession(), { maxAge: SESSION_DAYS * 86400 });
      res.redirect(ret && ret.startsWith('/') ? ret : '/dispatch');
    } catch (e) {
      res.status(500).send('Sign-in error: ' + String(e.message || e));
    }
  });

  app.get('/logout', (_req, res) => { clearCookie(res, SESS_COOKIE); res.redirect('/auth'); });
}
