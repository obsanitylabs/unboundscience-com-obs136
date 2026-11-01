// OBS-203 — GET /api/waitlist/confirm?token=… : double opt-in verification.
// CISO C2: ≥128-bit random single-use expiring token; CONSTANT response for every
// failure (missing/expired/used/wrong-kind) — no enumeration oracle.
import { storeGet, storePut, signupKey } from '../shared/store.mjs';
import { recordEvent } from '../shared/analytics.mjs';
import { consumeToken } from '../shared/tokens.mjs';
import { PRODUCTS, toResponse } from '../shared/util.mjs';

const handler = async (req, context) => {
  const token = new URL(req.url).searchParams.get('token') || '';
  const data = await consumeToken(context, token, 'confirm');
  const product = data?.product;
  // Constant failure: every bad path redirects to the same generic page state.
  if (!data || !PRODUCTS.includes(product || '')) {
    return {
      status: 302,
      headers: { location: `/waitlist/?verified=0`, 'cache-control': 'no-store' },
      body: 'Redirecting…',
    };
  }

  const key = await signupKey(context, product, data.e_hash);
  const rec = await storeGet(context, key);
  if (!rec) {
    return {
      status: 302,
      headers: { location: `/waitlist/?verified=0`, 'cache-control': 'no-store' },
      body: 'Redirecting…',
    };
  }

  if (rec.status !== 'verified' && rec.status !== 'suppressed') {
    rec.status = 'verified';
    rec.verified_at = new Date().toISOString();
    await storePut(context, key, rec);
    await recordEvent(context, { type: 'waitlist_verified', product, utm: {
      utm_source: rec.utm_source, utm_medium: rec.utm_medium, utm_campaign: rec.utm_campaign,
    }, extra: { referred_by: rec.referred_by_code } });
  }

  // Referral code travels in the redirect so the share UI never needs a second lookup.
  return {
    status: 302,
    headers: { location: `/waitlist/${product}/?verified=1&ref=${rec.referral_code}`, 'cache-control': 'no-store' },
    body: 'Verified. Redirecting…',
  };
};

export const config = { path: '/api/waitlist/confirm' };

export default toResponse(handler);
