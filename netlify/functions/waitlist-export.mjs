// OBS-203 — GET /api/waitlist/export : CSV export. CISO C1: separate scoped token
// (WAITLIST_EXPORT_TOKEN[_<PRODUCT>]), rotated ≤90d, CMO/CTO only; every export is
// access-logged with scope/product, timestamp, masked-IP hash, UA family, row count.
// GC: rate-limit IP hash (72h) never appears here; no email-hash columns exported.
import { storeList, storePut } from '../shared/store.mjs';
import { authScope, authFailure, scopeAllows } from '../shared/auth.mjs';
import { maskIp, ipHash, uaFamily, dayKey, daysBetween, PENDING_TTL_DAYS, toResponse, header } from '../shared/util.mjs';

const CSV_COLUMNS = ['product', 'email', 'status', 'consented_at', 'verified_at', 'unsubscribed_at',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'referral_code', 'referred_by_code', 'landing_path', 'created_at'];

const handler = async (req, context) => {
  const scope = authScope(req, 'WAITLIST_EXPORT_TOKEN');
  if (!scope) return authFailure();
  if (req.method !== 'GET') return authFailure();
  const want = new URL(req.url).searchParams.get('product') || null;
  if (scope !== '*' && want !== scope) return authFailure();

  const signups = await storeList(context, 'signup:');
  const rows = [];
  for (const rec of Object.values(signups)) {
    if (scope !== '*' && rec.product_key !== scope) continue;
    if (scope === '*' && want && rec.product_key !== want) continue;
    const status = rec.status === 'pending' && daysBetween(rec.created_at) > PENDING_TTL_DAYS ? 'expired' : rec.status;
    rows.push(CSV_COLUMNS.map((c) => csvCell(c === 'status' ? status : rec[c])).join(','));
  }

  const clientIp = header(req, 'x-nf-client-connection-ip') || (header(req, 'x-forwarded-for') || '').split(',')[0] || 'unknown';
  await storePut(context, `accesslog:export:${dayKey(Date.now())}:${Math.random().toString(36).slice(2, 10)}`, {
    action: 'waitlist_export',
    scope: scope === '*' ? (want || 'all-products') : scope,
    ip_hash: ipHash(maskIp(clientIp)), // short-lived masked hash, not exported
    user_agent_family: uaFamily(header(req, 'user-agent')),
    row_count: rows.length,
    ts: new Date().toISOString(),
  });

  return {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="waitlist-export.csv"', 'cache-control': 'no-store' },
    body: [CSV_COLUMNS.join(','), ...rows].join('\n'),
  };
};

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const config = { path: '/api/waitlist/export' };

export default toResponse(handler);
