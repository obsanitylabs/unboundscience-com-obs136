// OBS-203 shared waitlist — utilities. No raw IP storage; salted truncated hashes only.
import crypto from 'node:crypto';

export const PRODUCTS = ['unbound-science', 'phreaking-fun', 'mydaywas', 'draftcrypto'];
export const CONSENT_TEXT_VERSION = 'waitlist-consent-v1';
export const PENDING_TTL_DAYS = 7;

const SALT = process.env.WAITLIST_HASH_SALT || 'obs203-waitlist-salt';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// GC/OBS-205: network-address truncation (IPv4 /24, IPv6 first 3 hextets = /48)
// BEFORE hashing; short-lived (72h) rate-limit key only. Never persisted on records.
export function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (s.includes(':')) {
    const h = s.split(':');
    return h.slice(0, 3).join(':'); // /48
  }
  const o = s.split('.');
  if (o.length === 4) return `${o[0]}.${o[1]}.${o[2]}.0`; // /24
  return 'unknown';
}

// Short-lived salted hash of the MASKED address — rate limiting only.
export function ipHash(masked) {
  return sha256(SALT + '|ipmask|' + String(masked || 'unknown')).slice(0, 24);
}

// One-way hash of the normalized email for the suppression list (no plaintext).
export function suppressionHash(normalized) {
  return sha256(SALT + '|supp|' + normalized).slice(0, 32);
}

export function emailHash(normalized) {
  return sha256(SALT + '|em|' + normalized).slice(0, 32);
}

export function uaFamily(ua) {
  const s = String(ua || '');
  if (/bot|crawler|spider|headless/i.test(s)) return 'bot';
  if (/firefox/i.test(s)) return 'firefox';
  if (/edg\//i.test(s)) return 'edge';
  if (/chrome/i.test(s)) return 'chrome';
  if (/safari/i.test(s)) return 'safari';
  if (/curl|python|node|go-http/i.test(s)) return 'http-client';
  return 'other';
}

// Case-insensitive header read that works with both web-standard Headers
// (production: property access is undefined, must use .get) and plain objects
// (local harness).
export function header(req, name) {
  const h = req?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) || '';
  const n = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === n) return h[k] ?? '';
  }
  return '';
}

export function bearerToken(req) {
  const h = header(req, 'authorization');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (header(req, 'x-waitlist-token') || null);
}

// Constant-time string compare (auth token matching). Length mismatch = false.
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function referralCode(recordId) {
  return sha256(SALT + '|ref|' + recordId).slice(0, 10);
}

export function json(res, status, body) {
  return { status: status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: typeof body === 'string' ? body : JSON.stringify(body) };
}


// Netlify Functions v2 runtime requires a web-standard Response. Local harness
// (globalThis.__OBS_LOCAL_STORE__) keeps the plain-object shape. Converts
// {status, headers, body} handler results once, at the boundary.
export function toResponse(handler) {
  return async (req, context) => {
    const r = await handler(req, context);
    if (!r || process.env.OBS_LOCAL_STORE_PATH || globalThis.__OBS_LOCAL_STORE__) return r;
    if (typeof Response !== 'undefined' && !(r instanceof Response) && typeof r?.status === 'number') {
      return new Response(r.body ?? '', { status: r.status || 200, headers: r.headers || {} });
    }
    return r;
  };
}

export const nowIso = () => new Date().toISOString();
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

// Clamp/whitelist UTM values: max 120 chars, strip control chars.
export function cleanUtm(v) {
  return String(v || '').replace(/[^\w\-.: %]/g, '').slice(0, 120) || null;
}

export function daysBetween(fromIso, toMs = Date.now()) {
  return (toMs - Date.parse(fromIso)) / 86400000;
}