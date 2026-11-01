// OBS-203 — CISO C2: confirmation/unsubscribe tokens.
// ≥128-bit random (32 bytes), single-use, expiring, stored server-side keyed by
// SHA-256 of the token. Constant failure responses (enumeration-safe): every
// failure path returns the same result, with no timing-visible branch on existence.
import crypto from 'node:crypto';
import { storeGet, storePut, storeDelete } from './store.mjs';

export function newTokenValue() {
  return crypto.randomBytes(32).toString('base64url'); // 256-bit random
}

function tokenKey(token) {
  return 'token:' + crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Create a single-use token. kind: 'confirm' | 'unsubscribe'.
export async function createToken(context, { kind, product, eHash, ttlSeconds }) {
  const token = newTokenValue();
  await storePut(context, tokenKey(token), {
    kind, product, e_hash: eHash,
    exp: Date.now() + ttlSeconds * 1000,
    created_at: Date.now(),
  });
  return token;
}

// Consume a token exactly once. Returns { kind, product, e_hash } or null.
// Constant: any of missing/expired/used/wrong-kind returns null identically.
export async function consumeToken(context, token, kind) {
  if (!token || typeof token !== 'string' || token.length > 512) return null;
  const key = tokenKey(token);
  const rec = await storeGet(context, key);
  if (!rec) return null;
  await storeDelete(context, key); // single-use: consumed whether or not valid
  if (rec.kind !== kind) return null;
  if (typeof rec.exp !== 'number' || rec.exp < Date.now()) return null;
  return { kind: rec.kind, product: rec.product, e_hash: rec.e_hash };
}