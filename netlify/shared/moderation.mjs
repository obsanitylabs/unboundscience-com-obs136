// OBS-226 — moderation store helpers (Netlify Blobs store `site-analytics`). No HTTP here.
// Bans are operator state, not events: they never live under `events/*` and they outlive the
// events they suppress. Wallet addresses are hashed before any write; the raw address is never
// persisted (OBS-226 §8, dictionary D5).
'use strict';
import { createHash } from 'node:crypto';
import { listKeys } from './aggregate.mjs';

export const BANS_KEY = 'moderation/bans';
export const AUDIT_PREFIX = 'moderation/audit/';
export const CAPS = { users: 500, wallets: 500, ipRanges: 100 };
const BAN_CACHE_MS = 30_000;

const NOTE_RE = /^[A-Za-z0-9 .,_:-]*$/;
const IPV4_PREFIX_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/;
const IPV6_PREFIX_RE = /^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})::\/48$/;

export function sha256hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

// First 8 hex of SHA-256 of the presented bearer — tells two tokens apart, cannot rebuild one.
export function actorFp(token) {
  return token ? sha256hex(token).slice(0, 8) : '00000000';
}

// Strip one optional 0x/0X, require 40 hex. No EIP-55 checksum (not an enforcement key), no ENS,
// no bech32 (that address space is the demo app, outside this repo).
export function normalizeWallet(address) {
  if (typeof address !== 'string') return null;
  const s = address.replace(/^0[xX]/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(s)) return null;
  return s.toLowerCase();
}

export function walletHash(address) {
  const hex = normalizeWallet(address);
  return hex ? sha256hex(hex) : null;
}

// Accept only the prefix the collector can enforce against its truncated IP.
// IPv4: A.B.C.0/24 (host octet already zeroed). IPv6: hhhh:hhhh:hhhh::/48. Rejects /32, /16,
// hostnames, bare IPs, and IPv4-mapped IPv6.
export function canonicalizePrefix(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const v4 = IPV4_PREFIX_RE.exec(s);
  if (v4) {
    const octets = [v4[1], v4[2], v4[3]].map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : -1));
    if (octets.some((n) => n < 0 || n > 255)) return null;
    return { prefix: `${octets[0]}.${octets[1]}.${octets[2]}.0/24`, family: 'ipv4' };
  }
  const v6 = IPV6_PREFIX_RE.exec(s);
  if (v6) return { prefix: `${v6[1].toLowerCase()}:${v6[2].toLowerCase()}:${v6[3].toLowerCase()}::/48`, family: 'ipv6' };
  return null;
}

export function noteOk(note) {
  if (note === undefined || note === null) return true;
  return typeof note === 'string' && note.length <= 120 && NOTE_RE.test(note);
}

export function emptyBans() {
  return { version: 1, users: [], wallets: [], ipRanges: [] };
}

export async function loadBans(store) {
  const raw = await store.get(BANS_KEY);
  if (!raw) return emptyBans();
  try {
    const doc = JSON.parse(raw);
    return {
      version: 1,
      users: Array.isArray(doc.users) ? doc.users : [],
      wallets: Array.isArray(doc.wallets) ? doc.wallets : [],
      ipRanges: Array.isArray(doc.ipRanges) ? doc.ipRanges : [],
    };
  } catch { return emptyBans(); }
}

export async function saveBans(store, doc) {
  await store.setJSON(BANS_KEY, doc);
}

// Per-store 30s read cache for the collector's hot path. A warm instance enforces a new ban up to
// 30s late; a cold start reads fresh. Writes invalidate the same-process entry (test/dev).
let banCache = new WeakMap();

export async function loadBansCached(store, ttlMs = BAN_CACHE_MS) {
  const now = Date.now();
  const hit = banCache.get(store);
  if (hit && now - hit.at < ttlMs) return hit.doc;
  const doc = await loadBans(store);
  banCache.set(store, { at: now, doc });
  return doc;
}

export function invalidateBanCache(store) {
  if (store) banCache.delete(store);
  else banCache = new WeakMap();
}

async function readDay(store, key) {
  return JSON.parse((await store.get(key)) || '[]');
}

export async function appendAudit(store, entry) {
  const key = `${AUDIT_PREFIX}${new Date().toISOString().slice(0, 10)}`;
  const cur = await readDay(store, key);
  cur.push(entry);
  await store.setJSON(key, cur);
}

// Read the audit rows for the last `days` day-partitions, oldest first.
export async function readAudit(store, days) {
  const dayRe = /^moderation\/audit\/(\d{4}-\d{2}-\d{2})$/;
  const keys = listKeys(await store.list());
  const daysList = keys
    .map((k) => dayRe.exec(k))
    .filter(Boolean)
    .map((m) => m[1])
    .sort()
    .slice(-days);
  const rows = [];
  for (const d of daysList) rows.push(...(await readDay(store, `${AUDIT_PREFIX}${d}`)));
  return rows;
}
