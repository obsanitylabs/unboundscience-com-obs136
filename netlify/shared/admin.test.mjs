// OBS-226 — admin function tests (run: node --test netlify/shared/). No network.
// Uses an in-memory Blobs stub (get / setJSON / set / delete / list) so the handler logic,
// the ban document, the audit trail, and collector enforcement are exercised without Netlify dev.
// Never prints a token, a wallet address, or a raw IP.
'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin } from '../functions/admin.mjs';
import { handleCollect } from '../functions/collect.mjs';
import { purge } from '../functions/retention-purge.mjs';

const TOKEN = 'unit-test-admin-token';
const VALID = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d'; // UUID v4
const SID = 'b2c3d4e5-f6a7-4b5c-9d0e-1f2a3b4c5d6e'; // UUID v4
const today = new Date().toISOString().slice(0, 10);
const ISO = new Date().toISOString();
const ADDR = '0x' + 'deadbeef'.repeat(5); // 0x + 40 hex
const ADDR_HEX = 'deadbeef'.repeat(5); // lowercase, no 0x

function memStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async set(key, value) { data.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list() { return { blobs: [...data.keys()].sort().map((key) => ({ key })) }; },
    _dump() { return Object.fromEntries(data); },
  };
}

async function parse(res) { return { status: res.status, body: await res.json() }; }

function call(method, path, { token = TOKEN, expectedToken = TOKEN, body, store, now } = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const req = new Request(`https://ubs.test${path}`, init);
  return handleAdmin(req, { store, expectedToken, now });
}

function event(aid) {
  return {
    product: 'ubs', event_name: 'page_view', anonymous_id: aid, session_id: SID,
    utm_source: 'direct', utm_medium: 'community', wallet_connected: false,
    build_version: 'test', timestamp: ISO, page_path: '/x',
  };
}

function collect(store, { ip, events, ua = 'Mozilla/5.0 (normal)', isBot = () => ({ bot: false }) } = {}) {
  const headers = { 'content-type': 'application/json', 'user-agent': ua };
  if (ip) headers['x-nf-client-connection-ip'] = ip;
  const req = new Request('https://ubs.test/api/collect', { method: 'POST', headers, body: JSON.stringify({ events }) });
  return handleCollect(req, { store, isBot });
}

const qualityOf = (store) => JSON.parse(store._dump()[`quality/${today}`] || '{}');

test('OBS-226 auth: missing, wrong, and empty expected token → 404 not-found on every admin route', async () => {
  const store = memStore();
  const routes = [['GET', '/api/admin/summary'], ['GET', '/api/admin/moderation'], ['POST', '/api/admin/moderation'], ['GET', '/api/admin/audit']];
  for (const [m, p] of routes) {
    let r = await parse(await call(m, p, { store, token: null }));
    assert.equal(r.status, 404); assert.deepEqual(r.body, { error: 'not-found' });
    r = await parse(await call(m, p, { store, token: 'wrong' }));
    assert.equal(r.status, 404); assert.deepEqual(r.body, { error: 'not-found' });
    r = await parse(await call(m, p, { store, expectedToken: '' }));
    assert.equal(r.status, 404); assert.deepEqual(r.body, { error: 'not-found' });
  }
});

test('OBS-226 summary: assets unavailable, no-asset-ledger, both values null', async () => {
  const store = memStore();
  const { status, body } = await parse(await call('GET', '/api/admin/summary', { store }));
  assert.equal(status, 200);
  assert.deepEqual(body.assets, { value: null, tradedVolume: null, reason: 'no-asset-ledger' });
  assert.equal(body.windowDays, 30);
  assert.deepEqual(body.moderation, { users: 0, wallets: 0, ipRanges: 0 });
  assert.ok(Array.isArray(body.topUsers) && body.topUsers.length === 0);
  assert.deepEqual(body.frequency, { eventsPerDay: [], uniquesPerDay: [], sessionsPerDay: [] });
  assert.ok(body.insights && body.insights.dataQuality);
});

test('OBS-226 ban-user: collector drops the id, counts bannedRejected, persists nothing', async () => {
  const store = memStore();
  const b = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-user', anonymousId: VALID } }));
  assert.equal(b.status, 200); assert.equal(b.body.enforced, true); assert.equal(b.body.op, 'ban-user');
  const c = await parse(await collect(store, { events: [event(VALID)] }));
  assert.equal(c.status, 200); assert.deepEqual(c.body, { ok: true, accepted: 0 });
  assert.equal(qualityOf(store).bannedRejected, 1);
  assert.equal(store._dump()[`events/${today}`], undefined);
});

test('OBS-226 reject-ip-range: matching truncated IP filtered, ipRangeRejected counted, nothing persisted', async () => {
  const store = memStore();
  const b = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'reject-ip-range', prefix: '203.0.113.0/24' } }));
  assert.equal(b.status, 200); assert.equal(b.body.enforced, true); assert.equal(b.body.prefix, '203.0.113.0/24');
  const c = await parse(await collect(store, { ip: '203.0.113.57', events: [event(VALID)] }));
  assert.equal(c.status, 200); assert.deepEqual(c.body, { ok: true, filtered: true });
  assert.equal(qualityOf(store).ipRangeRejected, 1);
  assert.equal(store._dump()[`events/${today}`], undefined);
});

test('OBS-226 ban-wallet: stores a hash only; the raw address is never persisted or echoed', async () => {
  const store = memStore();
  const b = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-wallet', address: ADDR } }));
  assert.equal(b.status, 200); assert.equal(b.body.enforced, false); assert.equal(b.body.reason, 'no-wallet-source');
  const dump = JSON.stringify(store._dump()).toLowerCase();
  assert.ok(!dump.includes(ADDR_HEX), 'stored ban document must not contain the address');
  assert.ok(!dump.includes(ADDR.toLowerCase()), 'stored ban document must not contain the 0x address');
  const g = await parse(await call('GET', '/api/admin/moderation', { store }));
  assert.equal(g.body.bans.wallets.length, 1);
  assert.ok(!JSON.stringify(g.body).toLowerCase().includes(ADDR_HEX));
  assert.match(g.body.bans.wallets[0].walletHash, /^[0-9a-f]{12}$/);
  // invalid address: closed error code, input not echoed
  const bad = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-wallet', address: ADDR + 'ff' } }));
  assert.equal(bad.status, 400); assert.deepEqual(bad.body, { error: 'bad-address' });
});

test('OBS-226 audit: rows carry targetHash + actorFp; never the UUID or the address', async () => {
  const store = memStore();
  await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-user', anonymousId: VALID } });
  await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-wallet', address: ADDR } });
  const a = await parse(await call('GET', '/api/admin/audit', { store }));
  assert.equal(a.status, 200);
  assert.equal(a.body.entries.length, 2);
  for (const e of a.body.entries) {
    assert.match(e.targetHash, /^[0-9a-f]{64}$/);
    assert.match(e.actorFp, /^[0-9a-f]{8}$/);
    assert.ok(e.at && e.op && e.kind);
  }
  const s = JSON.stringify(a.body);
  assert.ok(!s.includes(VALID), 'audit must not contain the UUID');
  assert.ok(!s.toLowerCase().includes(ADDR_HEX), 'audit must not contain the address');
});

test('OBS-226 ban-user idempotent; closed error codes returned', async () => {
  const store = memStore();
  await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-user', anonymousId: VALID } });
  const again = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-user', anonymousId: VALID } }));
  assert.equal(again.body.ok, true);
  assert.equal(JSON.parse(store._dump()['moderation/bans']).users.length, 1);
  assert.equal(JSON.parse(store._dump()[`moderation/audit/${today}`]).length, 1); // no duplicate audit line

  const cases = [
    [{ op: 'no-such-op' }, 'bad-op'],
    [{ op: 'ban-user', anonymousId: 'not-a-uuid' }, 'bad-uuid'],
    [{ op: 'ban-wallet', address: '0xzz' }, 'bad-address'],
    [{ op: 'reject-ip-range', prefix: '203.0.113.1/24' }, 'bad-prefix'],
    [{ op: 'ban-user', anonymousId: VALID, note: 'bad@note!' }, 'bad-note'],
    [{ op: 'unban-user', anonymousId: '11111111-1111-4111-8111-111111111111' }, 'not-found'],
  ];
  for (const [body, code] of cases) {
    const r = await parse(await call('POST', '/api/admin/moderation', { store, body }));
    assert.equal(r.status, 400); assert.deepEqual(r.body, { error: code });
  }
});

test('OBS-226 unban and allow-ip-range remove entries', async () => {
  const store = memStore();
  await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-user', anonymousId: VALID } });
  await call('POST', '/api/admin/moderation', { store, body: { op: 'reject-ip-range', prefix: '2001:0db8:85a3::/48' } });
  const u = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'unban-user', anonymousId: VALID } }));
  assert.equal(u.status, 200); assert.equal(u.body.enforced, true);
  const a = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'allow-ip-range', prefix: '2001:0db8:85a3::/48' } }));
  assert.equal(a.status, 200); assert.equal(a.body.enforced, true);
  const bans = JSON.parse(store._dump()['moderation/bans']);
  assert.equal(bans.users.length, 0); assert.equal(bans.ipRanges.length, 0);
});

test('OBS-226 over-cap ban returns 400 limit without writing a row or an audit line', async () => {
  const users = Array.from({ length: 500 }, (_, i) => ({ anonymousId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, createdAt: ISO }));
  const store = memStore({ 'moderation/bans': JSON.stringify({ version: 1, users, wallets: [], ipRanges: [] }) });
  const r = await parse(await call('POST', '/api/admin/moderation', { store, body: { op: 'ban-user', anonymousId: VALID } }));
  assert.equal(r.status, 400); assert.deepEqual(r.body, { error: 'limit' });
  assert.equal(JSON.parse(store._dump()['moderation/bans']).users.length, 500);
  assert.equal(store._dump()[`moderation/audit/${today}`], undefined);
});

test('OBS-226 retention purge deletes aged moderation/audit and keeps moderation/bans', async () => {
  const store = memStore({
    'events/2000-01-01': '[]',
    'quality/2000-01-01': '{}',
    'moderation/audit/2000-01-01': '[]',
    'moderation/bans': JSON.stringify({ version: 1, users: [], wallets: [], ipRanges: [] }),
    [`events/${today}`]: '[]',
  });
  const { deleted } = await purge(store);
  const dump = store._dump();
  assert.ok(!('moderation/audit/2000-01-01' in dump), 'aged audit row purged');
  assert.ok('moderation/bans' in dump, 'ban document kept');
  assert.ok(!('events/2000-01-01' in dump));
  assert.ok(`events/${today}` in dump);
  assert.equal(deleted, 3);
});

test('OBS-226 admin POSTs are rate-limited after auth; unauthenticated callers still get 404', async () => {
  const store = memStore();
  const future = Date.now() + 3_600_000; // prunes any earlier bucket entries
  let last;
  for (let i = 0; i < 30; i++) last = await parse(await call('POST', '/api/admin/moderation', { store, now: future, body: { op: 'ban-user', anonymousId: VALID } }));
  assert.equal(last.status, 200);
  const over = await parse(await call('POST', '/api/admin/moderation', { store, now: future, body: { op: 'ban-user', anonymousId: VALID } }));
  assert.equal(over.status, 429); assert.deepEqual(over.body, { error: 'rate' });
  const unauth = await parse(await call('POST', '/api/admin/moderation', { store, token: null, now: future }));
  assert.equal(unauth.status, 404);
});
