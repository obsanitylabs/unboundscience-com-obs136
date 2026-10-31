// OBS-125 — auth-gated per-site dashboard data. GET /api/insights?days=30[&product=ubs]
// Token auth: Authorization: Bearer $INSIGHTS_TOKEN (set via Netlify env from the company secret store).
// TLS is terminated by Netlify (R7). 404 (not 401) for bad tokens — do not reveal the endpoint.

const ALLOWED_ORIGIN = (process.env.INSIGHTS_ALLOWED_ORIGIN || '').trim(); // sibling site for the investor board
const CORS = ALLOWED_ORIGIN ? { 'access-control-allow-origin': ALLOWED_ORIGIN, 'vary': 'origin' } : {};

export default async (req) => {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tokenOk(token, process.env.INSIGHTS_TOKEN)) {
    return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
  }
  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 90);

  const store = getStore('site-analytics');
