// OBS-226 — shared aggregation. The metric set below is the OBS-207/OBS-123 dictionary
// (same object GET /api/insights returns). Extracted so insights.mjs and admin.mjs read one
// implementation and the numbers cannot drift. No network, no HTTP loopback.
'use strict';

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// `store.list()` returns `{ blobs: [{ key }] }` (@netlify/blobs); accept a bare array too so
// tests and local stubs can use either shape.
export function listKeys(res) {
  const arr = Array.isArray(res) ? res : (res && Array.isArray(res.blobs) ? res.blobs : []);
  return arr.map((k) => (typeof k === 'string' ? k : k && k.key)).filter(Boolean);
}

// Sorted list of the latest `days` event day-partitions present in the store.
export async function listEventDays(store, days) {
  const keys = listKeys(await store.list());
  return keys.map((k) => k.replace(/^events\//, '')).filter((d) => DAY_RE.test(d)).sort().slice(-days);
}

// Read the raw window (events + per-day quality counters) for the last `days` partitions.
export async function readWindow(store, days) {
  const eventDays = await listEventDays(store, days);
  const events = [];
  const quality = {};
  for (const d of eventDays) {
    const batch = JSON.parse((await store.get(`events/${d}`)) || '[]');
    events.push(...batch);
    quality[d] = JSON.parse((await store.get(`quality/${d}`)) || '{}');
  }
  return { eventDays, events, quality };
}

// Pure aggregation — identical to the OBS-125 insights build. Callers pass already-read blobs.
export function aggregateInsights({ events, quality, eventDays, days }) {
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
  return {
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
}

// Admin-only extra: per-day activity counts for the window.
export function frequency(events, eventDays) {
  const byDay = new Map();
  for (const d of eventDays) byDay.set(d, { events: 0, users: new Set(), sessions: new Set() });
  for (const ev of events) {
    const d = String(ev.timestamp || '').slice(0, 10);
    const b = byDay.get(d);
    if (!b) continue;
    b.events++;
    if (ev.anonymous_id) b.users.add(ev.anonymous_id);
    if (ev.session_id) b.sessions.add(ev.session_id);
  }
  return {
    eventsPerDay: eventDays.map((d) => ({ day: d, events: byDay.get(d).events })),
    uniquesPerDay: eventDays.map((d) => ({ day: d, uniques: byDay.get(d).users.size })),
    sessionsPerDay: eventDays.map((d) => ({ day: d, sessions: byDay.get(d).sessions.size })),
  };
}

// Admin-only extra: top anonymous_id values by event count. Never a wallet, email, or IP.
export function topUsers(events, limit = 20) {
  const map = new Map();
  for (const ev of events) {
    const u = ev.anonymous_id;
    if (!u) continue;
    const d = String(ev.timestamp || '').slice(0, 10);
    let rec = map.get(u);
    if (!rec) { rec = { anonymousId: u, events: 0, sessions: new Set(), firstSeen: null, lastSeen: null, eventNames: {} }; map.set(u, rec); }
    rec.events++;
    if (ev.session_id) rec.sessions.add(ev.session_id);
    if (d) {
      if (!rec.firstSeen || d < rec.firstSeen) rec.firstSeen = d;
      if (!rec.lastSeen || d > rec.lastSeen) rec.lastSeen = d;
    }
    const n = ev.event_name || 'unknown';
    rec.eventNames[n] = (rec.eventNames[n] || 0) + 1;
  }
  return [...map.values()]
    .sort((a, b) => b.events - a.events)
    .slice(0, limit)
    .map((r) => ({
      anonymousId: r.anonymousId,
      events: r.events,
      sessions: r.sessions.size,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      eventNames: r.eventNames,
    }));
}
