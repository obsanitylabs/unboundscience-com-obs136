// OBS-203 — POST /api/waitlist/event : first-party analytics events from the pages.
// Types: waitlist_view, referral_share (submit/verified are recorded server-side).
// Same-origin only; UTM preserved into the event for attribution joins.
import { recordEvent, EVENT_TYPES } from '../shared/analytics.mjs';
import { PRODUCTS, cleanUtm, json, toResponse, header } from '../shared/util.mjs';

const handler = async (req, context) => {
  if (req.method !== 'POST') return json(null, 405, { error: 'method_not_allowed' });
  const origin = header(req, 'origin') || undefined;
  const allowedEnv = process.env.WAITLIST_ALLOWED_ORIGIN;
  // Same-origin events are always accepted (env allowlist stays as an extra grant;
  // shared team-wide env values cannot be per-site).
  let ownOrigin = null;
  try { ownOrigin = new URL(req.url).origin; } catch { ownOrigin = null; }
  if (origin && allowedEnv && origin !== allowedEnv && origin !== ownOrigin) {
    return json(null, 403, { error: 'origin_not_allowed' });
  }
  let b = {};
  try { b = await req.json(); } catch { return json(null, 400, { error: 'bad_json' }); }
  if (!EVENT_TYPES.includes(b.type)) return json(null, 400, { error: 'unknown_event' });
  if (!PRODUCTS.includes(b.product)) return json(null, 400, { error: 'unknown_product' });

  await recordEvent(context, {
    type: b.type, product: b.product,
    utm: {
      utm_source: cleanUtm(b.utm_source), utm_medium: cleanUtm(b.utm_medium),
      utm_campaign: cleanUtm(b.utm_campaign), utm_content: cleanUtm(b.utm_content), utm_term: cleanUtm(b.utm_term),
      utm_id: cleanUtm(b.utm_id),
    },
    extra: { landing_path: String(b.landing_path || '/').slice(0, 120) },
  });
  return json(null, 200, { ok: true });
};

export const config = { path: '/api/waitlist/event' };

export default toResponse(handler);
