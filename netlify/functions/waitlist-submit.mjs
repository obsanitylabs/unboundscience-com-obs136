// OBS-203 — POST /api/waitlist : create pending signup (double opt-in).
// GC/OBS-205 + CISO/OBS-206 C2/C3/C6:
//  - email is the ONLY personal data; UTM/referral/landing are operational fields
//  - honeypot + rate limits keyed by 72h-lived hash of the MASKED IP (never persisted
//    on the record; never exported); no full IP or full email in any persisted log
//  - single-use ≥128-bit random tokens; CONSTANT response regardless of whether the
//    address already exists (no list-membership oracle)
//  - referral code random + unguessable; no reward semantics anywhere
import { storeGet, storePut, rateHit, signupKey } from '../shared/store.mjs';
import { recordEvent } from '../shared/analytics.mjs';
import { sendConfirmation } from '../shared/email.mjs';
import { createToken } from '../shared/tokens.mjs';
import {
  PRODUCTS, CONSENT_TEXT_VERSION, normalizeEmail, isValidEmail, maskIp, ipHash,
  emailHash, suppressionHash, uaFamily, referralCode, json, nowIso, cleanUtm, toResponse, header } from '../shared/util.mjs';

// Site base for email links: derived per-request from the function's own URL so links
// always match the page's own domain (shared env vars on one Netlify team cannot be
// per-site). WAITLIST_SITE_URL remains a fallback for the local staging harness.
const SITE = process.env.WAITLIST_SITE_URL || 'https://waitlist-staging.obsanity.net';

function siteBase(req) {
  try {
    const o = new URL(req.url).origin;
    if (o && o.startsWith('http')) return o;
  } catch { /* fall through */ }
  return SITE;
}
const CONFIRM_TTL = 7 * 86400;     // unverified expiry window
const UNSUB_TTL = 90 * 86400;

// Constant success body for every accepted submit (new, duplicate, suppressed alike).
const OK_BODY = {
  ok: true,
  status: 'pending',
  message: 'Check your inbox — we sent a confirmation link. Unconfirmed requests expire after 7 days.',
};

const handler = async (req, context) => {
  if (req.method !== 'POST') return json(null, 405, { error: 'method_not_allowed' });

  let b = {};
  try { b = await req.json(); } catch { return json(null, 400, { error: 'bad_json' }); }

  const product = String(b.product || '');
  if (!PRODUCTS.includes(product)) return json(null, 400, { error: 'unknown_product' });

  // Honeypot: bots get the same constant 200 and no record is written.
  if (String(b.website_extra || '').trim() !== '') return json(null, 200, OK_BODY);

  const email = normalizeEmail(b.email);
  if (!isValidEmail(email)) return json(null, 400, { error: 'invalid_email' });
  if (!b.consent) return json(null, 400, { error: 'consent_required' });

  // C3: hash of MASKED IP, rate-limit keys only, purged after 72h by the scheduler.
  const clientIp = header(req, 'x-nf-client-connection-ip') || (header(req, 'x-forwarded-for') || '').split(',')[0] || 'unknown';
  const iHash = ipHash(maskIp(clientIp));
  const eHash = emailHash(email);

  const ipHit = await rateHit(context, `ip:${iHash}`, 10, 3600);
  if (!ipHit.ok) return json(null, 429, { error: 'rate_limited' });
  const emHit = await rateHit(context, `em:${product}:${eHash}`, 3, 86400);
  if (!emHit.ok) return json(null, 429, { error: 'rate_limited' });

  const utm = {
    utm_source: cleanUtm(b.utm_source), utm_medium: cleanUtm(b.utm_medium),
    utm_campaign: cleanUtm(b.utm_campaign), utm_content: cleanUtm(b.utm_content),
    utm_term: cleanUtm(b.utm_term), utm_id: cleanUtm(b.utm_id),
  };

  const suppressed = await storeGet(context, `suppressed:${suppressionHash(email)}`);
  const key = await signupKey(context, product, eHash);
  const existing = await storeGet(context, key);

  // Constant path: suppressed / unsubscribed / verified / pending all behave identically
  // outward. Only a genuinely new or still-pending record triggers (re)sending the
  // confirmation email with a fresh single-use token; duplicates do not re-mail.
  const isNew = !existing;
  const isPending = existing?.status === 'pending';

  if (isNew) {
    const id = `w_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
    const record = {
      id,
      product_key: product,
      email, // email only; UTM/referral are operational fields on this record
      email_hash: eHash,
      status: 'pending',
      consent_text_version: CONSENT_TEXT_VERSION,
      consented_at: nowIso(),
      verified_at: null,
      unsubscribed_at: null,
      ...utm,
      referral_code: referralCode(id), // random + unguessable (C6)
      referred_by_code: String(b.referral_code || '').trim().slice(0, 10) || null,
      landing_path: String(b.landing_path || '/').slice(0, 120),
      created_at: nowIso(),
      last_emailed_at: null,
      // NOTE: no ip_hash field — rate limiting uses 72h transient keys only (C3/GC)
      user_agent_family: uaFamily(header(req, 'user-agent')),
    };
    await storePut(context, key, record);
  }

  if (isNew || isPending) {
    const site = siteBase(req);
    const confirmToken = await createToken(context, { kind: 'confirm', product, eHash, ttlSeconds: CONFIRM_TTL });
    const unsubToken = await createToken(context, { kind: 'unsubscribe', product, eHash, ttlSeconds: UNSUB_TTL });
    await sendConfirmation(context, {
      to: email,
      product,
      confirmUrl: `${site}/api/waitlist/confirm?token=${confirmToken}`,
      unsubscribeUrl: `${site}/api/waitlist/unsubscribe?token=${unsubToken}`,
    });
    const rec = await storeGet(context, key);
    if (rec) { rec.last_emailed_at = nowIso(); await storePut(context, key, rec); }
    await recordEvent(context, { type: 'waitlist_submit', product, utm, extra: { status: 'pending' } });
  }

  return json(null, 200, OK_BODY);
};

export const config = { path: '/api/waitlist' };

export default toResponse(handler);
