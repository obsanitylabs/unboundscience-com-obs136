// OBS-226 — admin dashboard backend for unboundscience.com. Router for /api/admin/*.
//   GET  /api/admin/summary      — shared /api/insights metrics + admin-only extras
//   GET  /api/admin/moderation   — current ban document (no address, hashes only)
//   POST /api/admin/moderation   — ban/unban user, wallet, IPv4/IPv6 prefix; append-audited
//   GET  /api/admin/audit        — hash-only audit rows for the last N days
// Auth: reuse INSIGHTS_TOKEN, constant-time compare, 404 (not 401) on bad/missing token.
// No new secret, no client-side gate. Same-origin only; the admin page is served from this site.
'use strict';
import { getStore } from '@netlify/blobs';
import { tokenOk, bearer } from '../shared/admin-auth.mjs';
import { readWindow, aggregateInsights, frequency, topUsers } from '../shared/aggregate.mjs';
import {
  loadBans, saveBans, invalidateBanCache, sha256hex, actorFp, normalizeWallet,
  canonicalizePrefix, noteOk, appendAudit, readAudit, CAPS,
} from '../shared/moderation.mjs';

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
// Collector already requires 8-4-4-4-12 hex; admin bans pin UUID **v4** so a shape the collector
// would have dropped cannot be stored as a fake user (OBS-226 §4.1).
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPS = new Set(['ban-user', 'unban-user', 'ban-wallet', 'unban-wallet', 'reject-ip-range', 'allow-ip-range']);

// In-process POST limiter: 30/minute per warm instance, after the token check (OBS-226 §8).
const MAX_ADMIN_POSTS_PER_MIN = 30;
const postTimes = [];
function rateLimited(now) {
  while (postTimes.length && now - postTimes[0] >= 60_000) postTimes.shift();
  if (postTimes.length >= MAX_ADMIN_POSTS_PER_MIN) return true;
  postTimes.push(now);
  return false;
}

function json(body, status) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

function clampDays(raw, fallback, lo, hi) {
  const n = parseInt(raw == null ? '' : String(raw), 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, lo), hi);
}

async function summary(store, url) {
  const days = clampDays(url.searchParams.get('days'), 30, 1, 90);
  const { eventDays, events, quality } = await readWindow(store, days);
  const insights = aggregateInsights({ events, quality, eventDays, days });
  const bans = await loadBans(store);
  return json({
    generatedAt: new Date().toISOString(),
    windowDays: days,
    insights,
    frequency: frequency(events, eventDays),
    topUsers: topUsers(events, 20),
    // No trade tape, price oracle, or asset contract on this site — never invent a price feed.
    assets: { value: null, tradedVolume: null, reason: 'no-asset-ledger' },
    moderation: { users: bans.users.length, wallets: bans.wallets.length, ipRanges: bans.ipRanges.length },
  }, 200);
}

async function moderationGet(store) {
  const bans = await loadBans(store);
  return json({
    ok: true,
    bans: {
      version: 1,
      users: bans.users.map((u) => ({ anonymousId: u.anonymousId, createdAt: u.createdAt, ...(u.note ? { note: u.note } : {}) })),
      // Never the address: the stored SHA-256, truncated to 12 hex for display.
      wallets: bans.wallets.map((w) => ({ walletHash: String(w.walletHash).slice(0, 12), createdAt: w.createdAt, ...(w.note ? { note: w.note } : {}) })),
      ipRanges: bans.ipRanges.map((p) => ({ prefix: p.prefix, family: p.family, createdAt: p.createdAt, ...(p.note ? { note: p.note } : {}) })),
    },
  }, 200);
}

async function auditGet(store, url) {
  const days = clampDays(url.searchParams.get('days'), 7, 1, 30);
  return json({ ok: true, days, entries: await readAudit(store, days) }, 200);
}

async function audit(store, { at, op, kind, targetHash, actor }) {
  await appendAudit(store, { at, op, kind, targetHash, actorFp: actor });
}

async function moderationPost(req, store, token) {
  let body;
  try { body = JSON.parse(await req.text()); } catch { return json({ error: 'bad-json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad-json' }, 400);

  const op = body.op;
  if (typeof op !== 'string' || !OPS.has(op)) return json({ error: 'bad-op' }, 400);
  if (!noteOk(body.note)) return json({ error: 'bad-note' }, 400);

  const bans = await loadBans(store);
  const at = new Date().toISOString();
  const actor = actorFp(token);
  const note = body.note ? { note: body.note } : {};

  if (op === 'ban-user' || op === 'unban-user') {
    const id = body.anonymousId;
    if (typeof id !== 'string' || !UUID_V4_RE.test(id)) return json({ error: 'bad-uuid' }, 400);
    const idx = bans.users.findIndex((u) => u.anonymousId === id);
    if (op === 'ban-user') {
      if (idx === -1) {
        if (bans.users.length >= CAPS.users) return json({ error: 'limit' }, 400);
        bans.users.push({ anonymousId: id, createdAt: at, ...note });
        await saveBans(store, bans); invalidateBanCache(store);
        await audit(store, { at, op, kind: 'user', targetHash: sha256hex(id), actor });
      }
      return json({ ok: true, op, enforced: true }, 200);
    }
    if (idx === -1) return json({ error: 'not-found' }, 400);
    bans.users.splice(idx, 1);
    await saveBans(store, bans); invalidateBanCache(store);
    await audit(store, { at, op, kind: 'user', targetHash: sha256hex(id), actor });
    return json({ ok: true, op, enforced: true }, 200);
  }

  if (op === 'ban-wallet' || op === 'unban-wallet') {
    const hex = normalizeWallet(body.address);
    if (!hex) return json({ error: 'bad-address' }, 400);
    const hash = sha256hex(hex);
    const idx = bans.wallets.findIndex((w) => w.walletHash === hash);
    if (op === 'ban-wallet') {
      if (idx === -1) {
        if (bans.wallets.length >= CAPS.wallets) return json({ error: 'limit' }, 400);
        // Store the hash only. There is no wallet source on this site, so the ban cannot enforce.
        bans.wallets.push({ walletHash: hash, createdAt: at, ...note });
        await saveBans(store, bans); invalidateBanCache(store);
        await audit(store, { at, op, kind: 'wallet', targetHash: hash, actor });
      }
      return json({ ok: true, op, enforced: false, reason: 'no-wallet-source' }, 200);
    }
    if (idx === -1) return json({ error: 'not-found' }, 400);
    bans.wallets.splice(idx, 1);
    await saveBans(store, bans); invalidateBanCache(store);
    await audit(store, { at, op, kind: 'wallet', targetHash: hash, actor });
    return json({ ok: true, op, enforced: false, reason: 'no-wallet-source' }, 200);
  }

  // reject-ip-range / allow-ip-range
  const c = canonicalizePrefix(body.prefix);
  if (!c) return json({ error: 'bad-prefix' }, 400);
  const idx = bans.ipRanges.findIndex((p) => p.prefix === c.prefix);
  if (op === 'reject-ip-range') {
    if (idx === -1) {
      if (bans.ipRanges.length >= CAPS.ipRanges) return json({ error: 'limit' }, 400);
      bans.ipRanges.push({ prefix: c.prefix, family: c.family, createdAt: at, ...note });
      await saveBans(store, bans); invalidateBanCache(store);
      await audit(store, { at, op, kind: 'ipRange', targetHash: sha256hex(c.prefix), actor });
    }
    return json({ ok: true, op, enforced: true, prefix: c.prefix }, 200);
  }
  if (idx === -1) return json({ error: 'not-found' }, 400);
  bans.ipRanges.splice(idx, 1);
  await saveBans(store, bans); invalidateBanCache(store);
  await audit(store, { at, op, kind: 'ipRange', targetHash: sha256hex(c.prefix), actor });
  return json({ ok: true, op, enforced: true }, 200);
}

// Testable core: no @netlify/blobs, no process.env. The default export wires the real store.
export async function handleAdmin(req, { store, expectedToken, now = Date.now() } = {}) {
  const method = req.method;
  const url = new URL(req.url);
  const resource = url.pathname.replace(/^\/api\/admin\/?/, '').replace(/\/+$/, '').split('/')[0];

  if (!tokenOk(bearer(req), expectedToken)) return json({ error: 'not-found' }, 404);
  // Rate limit only after auth, so a 429 never confirms the route to strangers.
  if (method === 'POST' && rateLimited(now)) return json({ error: 'rate' }, 429);

  if (method === 'GET' && resource === 'summary') return summary(store, url);
  if (method === 'GET' && resource === 'moderation') return moderationGet(store);
  if (method === 'POST' && resource === 'moderation') return moderationPost(req, store, bearer(req));
  if (method === 'GET' && resource === 'audit') return auditGet(store, url);
  return json({ error: 'not-found' }, 404); // unknown resource or wrong method
}

export default async (req) =>
  handleAdmin(req, { store: getStore('site-analytics'), expectedToken: process.env.INSIGHTS_TOKEN });

export const config = { path: '/api/admin/*' };
