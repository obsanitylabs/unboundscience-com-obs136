// OBS-203 — GET /api/waitlist/stats : server-side bearer auth (CISO C1).
// Scoped tokens: WAITLIST_ADMIN_TOKEN (all products) or WAITLIST_ADMIN_TOKEN_<PRODUCT>.
// ?product= required for scoped tokens (cross-product → constant 404). Aggregates only:
// never individual emails, email hashes, or referral codes joined to an email (W/GC).
import { storeList } from '../shared/store.mjs';
import { authScope, authFailure, scopeAllows } from '../shared/auth.mjs';
import { PRODUCTS, dayKey, daysBetween, PENDING_TTL_DAYS, toResponse } from '../shared/util.mjs';

const handler = async (req, context) => {
  const scope = authScope(req, 'WAITLIST_ADMIN_TOKEN');
  if (!scope) return authFailure();
  if (req.method !== 'GET') return authFailure();

  const want = new URL(req.url).searchParams.get('product') || null;
  if (scope !== '*') {
    if (want !== scope) return authFailure(); // cross-product attempt = constant 404
  }
  const visible = scope === '*' ? (want ? [want] : PRODUCTS) : [scope];

  const signups = await storeList(context, 'signup:');
  const events = await storeList(context, 'event:');

  const perProduct = {};
  const leaderboard = {};
  for (const p of visible) perProduct[p] = emptyProduct();

  for (const rec of Object.values(signups)) {
    if (!perProduct[rec.product_key]) continue;
    const s = perProduct[rec.product_key];
    const effective = rec.status === 'pending' && daysBetween(rec.created_at) > PENDING_TTL_DAYS ? 'expired' : rec.status;
    s.counts[effective] = (s.counts[effective] || 0) + 1;
    if (effective === 'verified') {
      const day = dayKey(Date.parse(rec.verified_at || rec.created_at));
      s.daily[day] = (s.daily[day] || 0) + 1;
      const src = rec.utm_source || '(direct)';
      s.sources[src] = (s.sources[src] || 0) + 1;
      const camp = `${rec.utm_source || 'direct'}/${rec.utm_medium || '-'}/${rec.utm_campaign || '-'}`;
      s.campaigns[camp] = (s.campaigns[camp] || 0) + 1;
      // OBS-219 §7.2 / OBS-139 D3: registry join key = utm_campaign + utm_id.
      const idk = `${rec.utm_campaign || '-'}/${rec.utm_id || '-'}`;
      s.campaign_ids[idk] = (s.campaign_ids[idk] || 0) + 1;
      if (rec.referred_by_code) {
        leaderboard[rec.product_key] ??= {};
        leaderboard[rec.product_key][rec.referred_by_code] = (leaderboard[rec.product_key][rec.referred_by_code] || 0) + 1;
      }
    }
  }

  const eventCounts = {};
  for (const e of Object.values(events)) {
    if (!perProduct[e.product]) continue;
    eventCounts[e.product] ??= {};
    eventCounts[e.product][e.type] = (eventCounts[e.product][e.type] || 0) + 1;
  }

  for (const p of visible) {
    const s = perProduct[p];
    const submitted = Object.entries(s.counts).reduce((a, [, n]) => a + n, 0);
    s.verification_rate = submitted > 0 ? +((s.counts.verified || 0) / submitted).toFixed(3) : 0;
    // C6: leaderboard = counts only, never emails.
    s.referral_leaderboard = Object.entries(leaderboard[p] || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([code, n]) => ({ referral_code: code, verified_referred: n }));
    s.event_counts = eventCounts[p] || {};
  }

  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify({
      generated_at: new Date().toISOString(),
      scope: scope === '*' ? 'all-products' : scope,
      products: perProduct,
      suppressed_total: Object.keys(await storeList(context, 'suppressed:')).length,
    }),
  };
};

function emptyProduct() {
  return { counts: {}, daily: {}, sources: {}, campaigns: {}, campaign_ids: {}, referral_leaderboard: [], event_counts: {} };
}

export const config = { path: '/api/waitlist/stats' };

export default toResponse(handler);
