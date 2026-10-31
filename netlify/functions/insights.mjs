// OBS-125 — auth-gated per-site dashboard data. GET /api/insights?days=30[&product=ubs]
// Token auth: Authorization: Bearer $INSIGHTS_TOKEN (set via Netlify env from the company secret store).
// TLS is terminated by Netlify (R7). 404 (not 401) for bad tokens — do not reveal the endpoint.
// OBS-226: token compare moved to shared/admin-auth.mjs and the aggregation loop to
// shared/aggregate.mjs so admin.mjs reads one implementation. Response shape is unchanged.
'use strict';
import { getStore } from '@netlify/blobs';
import { tokenOk } from '../shared/admin-auth.mjs';
import { readWindow, aggregateInsights } from '../shared/aggregate.mjs';

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
  const { eventDays, events, quality } = await readWindow(store, days);
  const out = aggregateInsights({ events, quality, eventDays, days });
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
};

export const config = { path: '/api/insights' };
