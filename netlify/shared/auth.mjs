// OBS-203 — CISO C1: scoped admin/export auth. Server-side bearer tokens resolved
// from platform env (never in the repo). Convention:
//   WAITLIST_ADMIN_TOKEN            → full scope (all products)
//   WAITLIST_ADMIN_TOKEN_<PRODUCT>  → single-product scope (product key uppercased,
//                                      '-' → '_', e.g. WAITLIST_ADMIN_TOKEN_UNBOUND_SCIENCE)
//   WAITLIST_EXPORT_TOKEN / WAITLIST_EXPORT_TOKEN_<PRODUCT> — same convention for export.
// Rotation ≤90d (OBS-155 precedent). All auth failures return a constant 404 —
// no distinction between missing/invalid/cross-scope (enumeration-safe, R7 style).
import { timingSafeEqualStr, bearerToken } from './util.mjs';

function envPrefixToProduct(name, prefix) {
  const rest = name.slice(prefix.length).replace(/^_/, '');
  if (!rest) return '*';
  return rest.toLowerCase().replace(/_/g, '-');
}

// Resolve every scoped token from env for a prefix (e.g. WAITLIST_ADMIN_TOKEN).
// Returns [{ token, scope }] where scope is '*' or a product key.
export function resolveScopedTokens(prefix) {
  const out = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix)) continue;
    if (!value) continue;
    if (name !== prefix && !/^_[A-Z0-9_]+$/.test(name.slice(prefix.length))) continue;
    out.push({ token: value, scope: envPrefixToProduct(name, prefix) });
  }
  return out;
}

// Match bearer token to a scope. Returns scope ('*' or product key) or null.
export function authScope(req, prefix) {
  const token = bearerToken(req) || '';
  if (!token) return null;
  for (const { token: candidate, scope } of resolveScopedTokens(prefix)) {
    if (timingSafeEqualStr(token, candidate)) return scope;
  }
  return null;
}

// Constant 404 auth-failure response (R7 style; never 401-vs-404 distinguishable).
export const authFailure = () => ({
  status: 404,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify({ error: 'not_found' }),
});

// Scope check: scoped token may only access its own product.
export function scopeAllows(scope, product) {
  return scope === '*' || scope === product;
}