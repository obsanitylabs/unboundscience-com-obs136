// OBS-125 — Netlify-native collector (same-origin, per-site). Replaces the VPS collector proxy.
// Enforces R1 (allowlist, query-strip, host-only referrer), R3 (IP truncation before
// persistence, log redaction), R6 (bot filter — counted, never stored).
// OBS-169: default-on aggregate collection — no consent gate (R2 consent check removed).
// OBS-226: moderation enforcement — banned anonymous_id dropped, denied truncated-IP prefix filtered.
// Storage: Netlify Blobs (same provider as the site — Netlify, Inc. is the sole processor; see
// docs/COMPLIANCE-DELTA.md and public/analytics-notice.html).
// Deployed at POST /api/collect on each site's own domain.
'use strict';
import { getStore } from '@netlify/blobs';
import { validateBatch, truncateIp, redactLogs } from '../shared/enforce.mjs';
import { makeBotFilter, ipMatchesDenied } from '../shared/enforce.mjs';
import { loadBansCached } from '../shared/moderation.mjs';

const isBot = makeBotFilter(); // in-process sliding window (per warm instance; demo volume)
const JSON_HEADERS = { 'content-type': 'application/json' };
const NO_STORE = { 'cache-control': 'no-store' };
const MAX_BATCH_EVENTS = 50; // cheap-DoS cap: events past the cap are rejected+counted, never persisted

function dayKey(d = new Date()) { return `events/${d.toISOString().slice(0, 10)}`; }
function qualityKey(d = new Date()) { return `quality/${d.toISOString().slice(0, 10)}`; }

// Testable core — caller supplies the store and bot filter; no @netlify/blobs or module state.
export async function handleCollect(req, { store, isBot: isBotFn }) {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: JSON_HEADERS });

  let parsed;
  try { parsed = JSON.parse(await req.text()); } catch { return new Response(JSON.stringify({ error: 'bad-json' }), { status: 400, headers: JSON_HEADERS }); }
  const events = parsed.events;

  // R3 — truncate at the earliest hop; never log or persist the full IP.
  const rawIp = req.headers.get('x-nf-client-connection-ip') || '';
  const ip = truncateIp(rawIp) || null;
  const ua = req.headers.get('user-agent') || '';
  const bot = isBotFn({ truncatedIp: ip, userAgent: ua }); // UA used transiently, never persisted
  const today = new Date().toISOString().slice(0, 10);

  const bumpQuality = async (delta) => {
    const qk = `quality/${today}`;
    const cur = JSON.parse((await store.get(qk)) || '{}');
    for (const k of Object.keys(delta)) cur[k] = (cur[k] || 0) + delta[k];
    await store.setJSON(qk, cur);
  };

  if (bot.bot) { await bumpQuality({ botFiltered: 1 }); return new Response(JSON.stringify({ ok: true, filtered: true }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } }); }

  // OBS-226 — moderation deny check, after the cheap bot drop and before the allowlist.
  // Missing ban document = allow-all. Loaded once per request (module cache: up to 30s stale).
  const bans = await loadBansCached(store);
  // Denied IP prefix → filtered exactly like the bot filter, so the ban list cannot be probed
  // from the status code. Counted in quality, never stored.
  if (ipMatchesDenied(ip, bans.ipRanges)) {
    await bumpQuality({ ipRangeRejected: 1 });
    return new Response(JSON.stringify({ ok: true, filtered: true }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });
  }
  // Banned anonymous_id → drop those events before everyone else. Counted, never persisted.
  const bannedUsers = new Set((bans.users || []).map((u) => u.anonymousId));
  let bannedRejected = 0;
  const remaining = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev && bannedUsers.has(ev.anonymous_id)) { bannedRejected++; continue; }
    remaining.push(ev);
  }
  if (bannedRejected) await bumpQuality({ bannedRejected });
  if (remaining.length === 0) return new Response(JSON.stringify({ ok: true, accepted: 0 }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });

  const overflow = Math.max(0, remaining.length - MAX_BATCH_EVENTS);
  const { accepted, stats } = validateBatch(overflow ? remaining.slice(0, MAX_BATCH_EVENTS) : remaining);
  if (overflow) stats.rejected += overflow;
  await bumpQuality({ accepted: stats.accepted, rejected: stats.rejected, droppedAttributes: stats.droppedAttributes });
  if (accepted.length === 0) return new Response(JSON.stringify({ ok: true, accepted: 0 }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });

  // R1-clean events only are persisted — daily partition, append.
  const ek = `events/${today}`;
  const cur = JSON.parse((await store.get(ek)) || '[]');
  cur.push(...accepted);
  await store.setJSON(ek, cur);
  console.log(redactLogs(`collect: accepted=${stats.accepted} rejected=${stats.rejected} ip=${ip}`));
  return new Response(JSON.stringify({ ok: true, accepted: stats.accepted }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });
}

export default async (req) => handleCollect(req, { store: getStore('site-analytics'), isBot });

export const config = { path: '/api/collect' };
