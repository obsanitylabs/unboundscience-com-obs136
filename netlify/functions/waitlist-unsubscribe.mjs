// OBS-203 — GET/POST /api/waitlist/unsubscribe : one-click, per-product (GC verbatim flow).
// CISO C2: single-use token; CONSTANT response for every outcome — no enumeration.
import { storeGet, storePut, signupKey } from '../shared/store.mjs';
import { consumeToken } from '../shared/tokens.mjs';
import { toResponse } from '../shared/util.mjs';

const OK = { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify({ ok: true }) };

const handler = async (req, context) => {
  let data = null;
  if (req.method === 'GET') {
    data = await consumeToken(context, new URL(req.url).searchParams.get('token') || '', 'unsubscribe');
  } else if (req.method === 'POST') {
    let b = {};
    try { b = await req.json(); } catch { return { ...OK }; } // constant response
    if (b.token) data = await consumeToken(context, String(b.token), 'unsubscribe');
  } else {
    return { status: 405, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  // Constant: missing record / already gone / success are indistinguishable.
  if (data) {
    const key = await signupKey(context, data.product, data.e_hash);
    const rec = await storeGet(context, key);
    if (rec) {
      rec.status = 'unsubscribed';
      rec.unsubscribed_at = new Date().toISOString();
      await storePut(context, key, rec);
    }
  }
  return OK;
};

export const config = { path: '/api/waitlist/unsubscribe' };

export default toResponse(handler);
