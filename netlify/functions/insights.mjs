// OBS-125 — auth-gated per-site dashboard data. GET /api/insights?days=30[&product=ubs]
// Token auth: Authorization: Bearer $INSIGHTS_TOKEN (set via Netlify env from the company secret store).
// TLS is terminated by Netlify (R7). 404 (not 401) for bad tokens — do not reveal the endpoint.
'use strict';
import { getStore } from '@netlify/blobs';

const ALLOWED_ORIGIN = (process.env.INSIGHTS_ALLOWED_ORIGIN || '').trim(); // sibling site for the investor board
const CORS = ALLOWED_ORIGIN ? { 'access-control-allow-origin': ALLOWED_ORIGIN, 'vary': 'origin' } : {};

export default async (req) => {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!process.env.INSIGHTS_TOKEN || token !== process.env.INSIGHTS_TOKEN) {
    return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
  }
  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 90);

  const store = getStore('site-analytics');
  const keys = await store.list();
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  const eventDays = keys.map((k) => k.key.replace(/^events\//, '')).filter((d) => dayRe.test(d)).sort().slice(-days);

  const events = [];
  const quality = {};
  for (const d of eventDays) {
    const batch = JSON.parse((await store.get(`events/${d}`)) || '[]');
    events.push(...batch);
    quality[d] = JSON.parse((await store.get(`quality/${d}`)) || '{}');
  }

  const day = (iso) => iso.slice(0, 10);
  const seenUsers = new Set(); const firstSeen = {}; const weeks = {};
  const cohorts = {}; // cohortDay -> { users, d1: Set, d7: Set, d30: Set }
  const funnels = { ubs: {}, pff: {} }; // step -> Set users
  const channels = {}; const shareSessions = new Set(); const allSessions = new Set();
  const eventCounts = {}; const pageviews = {}; const activated = new Set();
  const FUNNEL_STEPS = {
    ubs: ['page_view', 'session_start', 'experiment_started', 'activation_complete'],
    pff: ['page_view', 'session_start', 'wallet_connected', 'activation_complete'],
  };

  for (const ev of events) {
    const p = ev.product; const u = ev.anonymous_id; const s = ev.session_id;
    if (!u) continue;
    const d = day(ev.timestamp || '1970-01-01T00:00:00Z');
    if (!firstSeen[u]) firstSeen[u] = d;
    seenUsers.add(u);
    const jan1 = new Date(Number(d.slice(0, 4)), 0, 1);
    const wk = d.slice(0, 4) + '-W' + String(Math.ceil(((new Date(d).getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7)).padStart(2, '0');
    (weeks[wk] ||= new Set()).add(u);
    eventCounts[`${p}:${ev.event_name}`] = (eventCounts[`${p}:${ev.event_name}`] || 0) + 1;
    pageviews[p] = (pageviews[p] || 0) + (ev.event_name === 'page_view' ? 1 : 0);
    if (s) allSessions.add(s);
    if (ev.event_name === 'page_view') (cohorts[firstSeen[u]] ||= { users: new Set([u]), d: {} }).users.add(u);
    if (ev.event_name === 'session_start') {
      const c = (cohorts[firstSeen[u]] ||= { users: new Set([u]), d: {} });
      const diff = Math.floor((new Date(d) - new Date(firstSeen[u])) / 86400000);
      if (diff >= 0) {
        c.d[1] ||= new Set(); c.d[7] ||= new Set(); c.d[30] ||= new Set();
        if (diff >= 1) c.d[1].add(u);
        if (diff >= 7) c.d[7].add(u);
        if (diff >= 30) c.d[30].add(u);
      }
    }
    if (ev.event_name === 'activation_complete') activated.add(u);
    if (ev.event_name === 'share_click' && s) shareSessions.add(s);
    if (FUNNEL_STEPS[p] && FUNNEL_STEPS[p].includes(ev.event_name)) {
      const steps = FUNNEL_STEPS[p];
      const idx = steps.indexOf(ev.event_name);
      (funnels[p][steps[idx]] ||= new Set()).add(u);
      for (let i = 0; i < idx; i++) (funnels[p][`${steps[i]}→${ev.event_name}`] ||= new Set()).add(u); // coarse step pairs
    }
    const src = ev.utm_source || 'direct'; const med = ev.utm_medium || '-';
    const key = `${src}/${med}`;
    (channels[key] ||= new Set()).add(u);
  }

  const users = [...seenUsers];
  const newUsers = users.filter((u) => eventDays.includes(firstSeen[u].slice(0, 10)) || firstSeen[u] >= eventDays[0]).length;
  const out = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    wau: Object.fromEntries(Object.entries(weeks).map(([w, s]) => [w, s.size])),
    newUsers,
    activationRate: newUsers ? +(activated.size / newUsers).toFixed(3) : activated.size ? 1 : 0,
    activatedUsers: activated.size,
    retentionCohorts: Object.fromEntries(Object.entries(cohorts).map(([d, c]) => [d, {
      users: c.users.size,
      d1: (c.d[1] || new Set()).size, d7: (c.d[7] || new Set()).size, d30: (c.d[30] || new Set()).size,
    }])),
    funnels: Object.fromEntries(Object.entries(funnels).map(([p, steps]) => [p, Object.fromEntries(Object.entries(steps).map(([k, s]) => [k, s.size]))])),
    channelMix: Object.fromEntries(Object.entries(channels).map(([k, s]) => [k, s.size])),
    shareRate: allSessions.size ? +(shareSessions.size / allSessions.size).toFixed(3) : 0,
    eventCounts,
    pageviews,
    dataQuality: quality,
  };
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
};

export const config = { path: '/api/insights' };