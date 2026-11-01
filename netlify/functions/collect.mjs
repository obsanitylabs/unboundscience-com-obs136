// OBS-125 — Netlify-native collector (same-origin, per-site). Replaces the VPS collector proxy.
// Enforces R1 (allowlist, query-strip, host-only referrer), R3 (IP truncation before
// persistence, log redaction), R6 (bot filter — counted, never stored).
// OBS-169: default-on aggregate collection — no consent gate (R2 consent check removed).
// OBS-226: moderation enforcement — banned anonymous_ids and rejected IP ranges are dropped
// before persistence (bannedRejected / ipRangeRejected counters), bans read via a 30s cache.
// Storage: Netlify Blobs (same provider as the site — Netlify, Inc. is the sole processor; see
// docs/COMPLIANCE-DELTA.md and public/analytics-notice.html).
// Deployed at POST /api/collect on each site's own domain.
'use strict';
import { getStore } from '@netlify/blobs';
import { validateBatch, truncateIp, redactLogs, makeBotFilter } from '../shared/enforce.mjs';
import { loadBansCached } from '../shared/moderation.mjs';

const isBot = makeBotFilter(); // in-process sliding window (per warm instance; demo volume)
const JSON_HEADERS = { 'content-type': 'application/json' };
const NO_STORE = { 'cache-control': 'no-store' };
const MAX_BATCH_EVENTS = 50; // cheap-DoS cap: events past the cap are rejected+counted, never persisted

// Truncated IPs are /24 (IPv4) or first-3-hextet (IPv6) forms; a ban prefix can only ever be
// exactly the enforceable truncation (see moderation.canonicalizePrefix), so a prefix match
// can never force full-IP storage.
function ipMatchesPrefix(ip, prefix) {
  if (!ip || typeof prefix !== 'string') return false;
  const net = prefix.split('/')[0];
  if (net.includes('.')) return net === ip; // both zero-host /24 forms
  const ipHextets = ip.split(':').filter(Boolean);
  const netHextets = net.split('::')[0].split(':').filter(Boolean);
  return netHextets.length === 3
    && ipHextets.slice(0, 3).join(':').toLowerCase() === netHextets.join(':').toLowerCase();
}

export async function handleCollect(req, { store, isBot: botFn } = {}) {
  const s = store || getStore('site-analytics');
  const botFilter = botFn || isBot;

  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: JSON_HEADERS });

  let parsed;
  try { parsed = JSON.parse(await req.text()); } catch { return new Response(JSON.stringify({ error: 'bad-json' }), { status: 400, headers: JSON_HEADERS }); }
  const events = parsed.events;

  // R3 — truncate at the earliest hop; never log or persist the full IP.
  const rawIp = req.headers.get('x-nf-client-connection-ip') || '';
  const ip = truncateIp(rawIp) || null;
  const ua = req.headers.get('user-agent') || '';
  const today = new Date().toISOString().slice(0, 10);

  const bumpQuality = async (delta) => {
    const qk = `quality/${today}`;
    const cur = JSON.parse((await s.get(qk)) || '{}');
    for (const k of Object.keys(delta)) cur[k] = (cur[k] || 0) + delta[k];
    await s.setJSON(qk, cur);
  };

  const bot = botFilter({ truncatedIp: ip, userAgent: ua }); // UA used transiently, never persisted
  if (bot.bot) { await bumpQuality({ botFiltered: 1 }); return new Response(JSON.stringify({ ok: true, filtered: true }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } }); }

  // OBS-226 — moderation enforcement before validation/persistence.
  const bans = await loadBansCached(s);
  const input = Array.isArray(events) ? events : [];
  if (ip && Array.isArray(bans.ipRanges) && bans.ipRanges.some((r) => ipMatchesPrefix(ip, r.prefix))) {
    await bumpQuality({ ipRangeRejected: input.length });
    return new Response(JSON.stringify({ ok: true, filtered: true }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });
  }
  const bannedUsers = new Set(Array.isArray(bans.users) ? bans.users.map((u) => u.anonymousId) : []);
  const bannedRejected = input.filter((e) => e && typeof e === 'object' && bannedUsers.has(e.anonymous_id)).length;
  if (bannedRejected > 0) await bumpQuality({ bannedRejected });

  const overflow = Math.max(0, input.length - MAX_BATCH_EVENTS);
  const { accepted, stats } = validateBatch(input.slice(0, MAX_BATCH_EVENTS));
  if (bannedRejected > 0) {
    // banned events are dropped even if otherwise valid; never persisted
    const kept = accepted.filter((e) => !bannedUsers.has(e.anonymous_id));
    stats.accepted = kept.length;
    stats.rejected += accepted.length - kept.length;
    accepted.length = 0;
    accepted.push(...kept);
  }
  if (overflow) stats.rejected += overflow;
  await bumpQuality({ accepted: stats.accepted, rejected: stats.rejected, droppedAttributes: stats.droppedAttributes });
  if (accepted.length === 0) return new Response(JSON.stringify({ ok: true, accepted: 0 }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });

  // R1-clean events only are persisted — daily partition, append.
  const ek = `events/${today}`;
  const cur = JSON.parse((await s.get(ek)) || '[]');
  cur.push(...accepted);
  await s.setJSON(ek, cur);
  console.log(redactLogs(`collect: accepted=${stats.accepted} rejected=${stats.rejected} ip=${ip}`));
  return new Response(JSON.stringify({ ok: true, accepted: stats.accepted }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });
}

export default async (req) => handleCollect(req);
export const config = { path: '/api/collect' };