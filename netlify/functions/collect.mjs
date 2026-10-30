// OBS-125 — Netlify-native collector (same-origin, per-site). Replaces the VPS collector proxy.
// Enforces R1 (allowlist, query-strip, host-only referrer), R2 (consent fail-closed → 451),
// R3 (IP truncation before persistence, log redaction), R6 (bot filter — counted, never stored).
// Storage: Netlify Blobs (first-party, same provider as the site — C9: no third-party processor).
// Deployed at POST /api/collect on each site's own domain.
'use strict';
import { getStore } from '@netlify/blobs';
import { validateBatch, truncateIp, redactLogs } from '../shared/enforce.mjs';
import { makeBotFilter } from '../shared/enforce.mjs';

const isBot = makeBotFilter(); // in-process sliding window (per warm instance; demo volume)
const JSON_HEADERS = { 'content-type': 'application/json' };
const NO_STORE = { 'cache-control': 'no-store' };

function dayKey(d = new Date()) { return `events/${d.toISOString().slice(0, 10)}`; }
function qualityKey(d = new Date()) { return `quality/${d.toISOString().slice(0, 10)}`; }

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: JSON_HEADERS });

  let parsed;
  try { parsed = JSON.parse(await req.text()); } catch { return new Response(JSON.stringify({ error: 'bad-json' }), { status: 400, headers: JSON_HEADERS }); }
  const events = parsed.events;

  // R2 — consent fail-closed (defense-in-depth; the first-party SDK gates before any send).
  // sendBeacon cannot set headers, so the consent grant may arrive as a body flag or a header.
  if (req.headers.get('x-obs-consent') !== 'granted' && parsed.consent !== 'granted') {
    return new Response(JSON.stringify({ error: 'consent-required' }), { status: 451, headers: JSON_HEADERS });
  }

  // R3 — truncate at the earliest hop; never log or persist the full IP.
  const rawIp = req.headers.get('x-nf-client-connection-ip') || '';
  const ip = truncateIp(rawIp) || null;
  const ua = req.headers.get('user-agent') || '';
  const bot = isBot({ truncatedIp: ip, userAgent: ua }); // UA used transiently, never persisted
  const store = getStore('site-analytics');
  const today = new Date().toISOString().slice(0, 10);

  const bumpQuality = async (delta) => {
    const qk = `quality/${today}`;
    const cur = JSON.parse((await store.get(qk)) || '{}');
    for (const k of Object.keys(delta)) cur[k] = (cur[k] || 0) + delta[k];
    await store.setJSON(qk, cur);
  };

  if (bot.bot) { await bumpQuality({ botFiltered: 1 }); return new Response(JSON.stringify({ ok: true, filtered: true }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } }); }

  const { accepted, stats } = validateBatch(events);
  await bumpQuality({ accepted: stats.accepted, rejected: stats.rejected, droppedAttributes: stats.droppedAttributes });
  if (accepted.length === 0) return new Response(JSON.stringify({ ok: true, accepted: 0 }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });

  // R1-clean events only are persisted — daily partition, append.
  const ek = `events/${today}`;
  const cur = JSON.parse((await store.get(ek)) || '[]');
  cur.push(...accepted);
  await store.setJSON(ek, cur);
  console.log(redactLogs(`collect: accepted=${stats.accepted} rejected=${stats.rejected} ip=${ip}`));
  return new Response(JSON.stringify({ ok: true, accepted: stats.accepted }), { status: 200, headers: { ...JSON_HEADERS, ...NO_STORE } });
};

export const config = { path: '/api/collect' };