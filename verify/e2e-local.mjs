// OBS-203 — local end-to-end acceptance suite (v2, post GC/CISO revisions).
// Runs the real Netlify function handlers against the JSON-file store shim.
// Includes the CISO-required auth-boundary tests (404 unauthenticated + cross-product),
// single-use token tests, and constant-response (enumeration) checks.
import assert from 'node:assert';
import fs from 'node:fs';

process.env.WAITLIST_HASH_SALT = 'test-salt';
process.env.WAITLIST_SITE_URL = 'http://localhost:9999';
process.env.WAITLIST_STAGING = '1';
// Scoped tokens (C1): full-scope + per-product scopes for boundary tests.
process.env.WAITLIST_ADMIN_TOKEN = 'test-admin-token';
process.env.WAITLIST_EXPORT_TOKEN = 'test-export-token';
process.env.WAITLIST_ADMIN_TOKEN_UNBOUND_SCIENCE = 'test-admin-ubs-only';
process.env.WAITLIST_EXPORT_TOKEN_DRAFTCRYPTO = 'test-export-dfc-only';
delete process.env.WAITLIST_EMAIL_WEBHOOK_URL;

const STORE = '.tmp/e2e-store.json';
process.env.OBS_LOCAL_STORE_PATH = STORE;
fs.mkdirSync('.tmp', { recursive: true });
fs.rmSync('.tmp/e2e-store.json', { force: true });

const submit = (await import('../netlify/functions/waitlist-submit.mjs')).default;
const confirm = (await import('../netlify/functions/waitlist-confirm.mjs')).default;
const unsubscribe = (await import('../netlify/functions/waitlist-unsubscribe.mjs')).default;
const stats = (await import('../netlify/functions/waitlist-stats.mjs')).default;
const exportFn = (await import('../netlify/functions/waitlist-export.mjs')).default;
const purge = (await import('../netlify/functions/waitlist-purge.mjs')).default;
const outbox = (await import('../netlify/functions/waitlist-outbox.mjs')).default;
const eventFn = (await import('../netlify/functions/waitlist-event.mjs')).default;

const ctx = {};
let ipSeq = 0;
const req = (method, url, { body, headers = {}, token } = {}) => ({
  method, url, headers: {
    ...headers,
    'user-agent': headers['user-agent'] || 'TestAgent/1.0 (chrome)',
    'x-forwarded-for': headers['x-forwarded-for'] || `10.0.0.${++ipSeq}`,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, json: async () => body ?? {},
});
const j = (r) => JSON.parse(r.body);
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); } };
const sleep = () => new Promise((r) => setTimeout(r, 5));
const UTM = { utm_source: 'x-test', utm_medium: 'social', utm_campaign: 'w1', utm_content: 'a', utm_term: 'b', utm_id: 'd3join' };

let aliceConfirmLink, bobUnsubLink, refCodeAlice;

await test('valid signup → pending + verbatim confirmation queued (double opt-in)', async () => {
  const r = await submit(req('POST', 'http://x/api/waitlist', { body: {
    product: 'unbound-science', email: 'Alice@Example.com ', consent: true, ...UTM, landing_path: '/waitlist/unbound-science/',
  } }), ctx);
  assert.equal(r.status, 200);
  assert.equal(j(r).status, 'pending');
  const ob = j(await outbox(req('GET', 'http://x/api/waitlist/outbox', { token: 'test-admin-token' }), ctx));
  const m = ob.outbox.at(-1);
  assert.equal(m.subject, 'Confirm your Unbound Science waitlist request');
  assert.ok(m.text.includes('If you did not request this, ignore this email. We will delete the address in 7 days.'));
  assert.ok(m.text.includes('This is not an offer to sell a security, token, or investment.'));
  aliceConfirmLink = m.confirmUrl;
});

await test('C2: confirmation token is single-use; second use gets the SAME constant failure', async () => {
  const r1 = await confirm(req('GET', aliceConfirmLink), ctx);
  assert.equal(r1.status, 302);
  assert.ok(r1.headers.location.includes('verified=1&ref='));
  const bad = await confirm(req('GET', aliceConfirmLink), ctx); // reuse
  const missing = await confirm(req('GET', 'http://x/api/waitlist/confirm?token='), ctx);
  const garbage = await confirm(req('GET', 'http://x/api/waitlist/confirm?token=AAAA.aaaa'), ctx);
  const failLoc = '/waitlist/?verified=0';
  assert.equal(bad.headers.location, failLoc);
  assert.equal(missing.headers.location, failLoc);
  assert.equal(garbage.headers.location, failLoc);
});

await test('C2: enumeration-safe — duplicate signup returns the IDENTICAL constant body', async () => {
  const first = j(await submit(req('POST', 'http://x/api/waitlist', { body: {
    product: 'unbound-science', email: 'alice@example.com', consent: true,
  } }), ctx));
  const dup = j(await submit(req('POST', 'http://x/api/waitlist', { body: {
    product: 'unbound-science', email: 'alice@example.com', consent: true,
  } }), ctx));
  assert.deepEqual(dup, first);
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const recs = Object.values(store).filter((r) => r && r.product_key === 'unbound-science');
  assert.equal(recs.length, 1, 'still exactly one record (no dedupe leak via response)');
});

await test('C1: stats auth boundary — 404 unauth/wrong token; scoped token; cross-product 404', async () => {
  const no = await stats(req('GET', 'http://x/api/waitlist/stats'), ctx);
  const wrong = await stats(req('GET', 'http://x/api/waitlist/stats', { token: 'nope' }), ctx);
  assert.equal(no.status, 404); assert.equal(wrong.status, 404);
  assert.deepEqual(j(no), j(wrong), 'constant auth-failure body');
  // scoped token: own product OK
  const own = j(await stats(req('GET', 'http://x/api/waitlist/stats?product=unbound-science', { token: 'test-admin-ubs-only' }), ctx));
  assert.equal(own.products['unbound-science'].counts.verified, 1);
  // cross-product attempt → constant 404, other product's data absent
  const cross = await stats(req('GET', 'http://x/api/waitlist/stats?product=draftcrypto', { token: 'test-admin-ubs-only' }), ctx);
  assert.equal(cross.status, 404);
  const all = j(await stats(req('GET', 'http://x/api/waitlist/stats', { token: 'test-admin-token' }), ctx));
  assert.ok(all.products['unbound-science'].event_counts.waitlist_verified >= 1);
  assert.equal(all.products['unbound-science'].sources['x-test'], 1);
});

await test('C1: export boundary — export token separate from admin; scoped export; cross-product 404; access log', async () => {
  assert.equal((await exportFn(req('GET', 'http://x/api/waitlist/export'), ctx)).status, 404);
  assert.equal((await exportFn(req('GET', 'http://x/api/waitlist/export', { token: 'test-admin-token' }), ctx)).status, 404); // admin ≠ export
  const csv = await exportFn(req('GET', 'http://x/api/waitlist/export', { token: 'test-export-token' }), ctx);
  assert.equal(csv.status, 200);
  assert.equal(csv.body.toLowerCase().split('alice@example.com').length - 1, 1, 'appears exactly once');
  const scoped = await exportFn(req('GET', 'http://x/api/waitlist/export?product=draftcrypto', { token: 'test-export-dfc-only' }), ctx);
  assert.equal(scoped.status, 200);
  assert.ok(!scoped.body.includes('alice@example.com'), 'scoped export excludes other products');
  const cross = await exportFn(req('GET', 'http://x/api/waitlist/export?product=unbound-science', { token: 'test-export-dfc-only' }), ctx);
  assert.equal(cross.status, 404);
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const log = Object.values(store).find((r) => r && r.action === 'waitlist_export');
  assert.ok(log && log.scope && log.row_count >= 0 && log.ip_hash && log.ts, 'export access-logged with scope');
});

await test('OBS-631 v7: export product column carries the product code (regression guard)', async () => {
  const csv = await exportFn(req('GET', 'http://x/api/waitlist/export', { token: 'test-export-token' }), ctx);
  assert.equal(csv.status, 200);
  const [header, ...lines] = csv.body.split('\n');
  const cols = header.split(',');
  const pIdx = cols.indexOf('product');
  assert.ok(pIdx >= 0, 'product column present in CSV header');
  const aliceRow = lines.find((l) => l.toLowerCase().includes('alice@example.com'));
  assert.ok(aliceRow, 'submitted row present in export');
  assert.equal(aliceRow.split(',')[pIdx], 'unbound-science', 'product column must read the record product_key');
});

await test('C3/GC: no raw IP or full IP persisted; rate keys use masked hash only', async () => {
  const raw = fs.readFileSync(STORE, 'utf8');
  assert.ok(!raw.includes('10.0.0.'), 'raw IPs must not appear in store');
  const store = JSON.parse(raw);
  const rec = Object.values(store).find((r) => r && r.product_key === 'unbound-science');
  assert.ok(!('ip_hash' in rec), 'record carries no ip_hash field');
  assert.ok(rec.user_agent_family === 'chrome');
});

await test('C6: referral attribution + counts-only leaderboard (no emails)', async () => {
  refCodeAlice = (JSON.parse(fs.readFileSync(STORE, 'utf8')) &&
    Object.values(JSON.parse(fs.readFileSync(STORE, 'utf8'))).find((r) => r && r.product_key === 'unbound-science')).referral_code;
  const r = await submit(req('POST', 'http://x/api/waitlist', { body: {
    product: 'phreaking-fun', email: 'bob@example.com', consent: true, referral_code: refCodeAlice,
  } }), ctx);
  assert.equal(j(r).ok, true);
  const ob = j(await outbox(req('GET', 'http://x/api/waitlist/outbox', { token: 'test-admin-token' }), ctx));
  const m = ob.outbox.at(-1);
  assert.equal(m.subject, 'Confirm your Phreaking Fun waitlist request');
  bobUnsubLink = m.unsubscribeUrl;
  await confirm(req('GET', m.confirmUrl), ctx);
  const s = j(await stats(req('GET', 'http://x/api/waitlist/stats', { token: 'test-admin-token' }), ctx));
  const lb = s.products['phreaking-fun'].referral_leaderboard;
  assert.ok(lb.length >= 1 && lb[0].referral_code === refCodeAlice && lb[0].verified_referred >= 1);
  assert.ok(!JSON.stringify(lb).includes('bob@'), 'leaderboard has no emails');
});

await test('GC: one-click unsubscribe (per product); unsubscribed never re-enters or re-mails', async () => {
  const r = await unsubscribe(req('GET', bobUnsubLink), ctx);
  assert.equal(j(r).ok, true);
  const again = await unsubscribe(req('GET', bobUnsubLink), ctx); // token already used
  assert.equal(j(again).ok, true); // constant
  const outboxBefore = j(await outbox(req('GET', 'http://x/api/waitlist/outbox', { token: 'test-admin-token' }), ctx)).outbox.length;
  const re = j(await submit(req('POST', 'http://x/api/waitlist', { body: {
    product: 'phreaking-fun', email: 'bob@example.com', consent: true,
  } }), ctx));
  assert.equal(re.status, 'pending'); // constant body — no unsub-status oracle
  const outboxAfter = j(await outbox(req('GET', 'http://x/api/waitlist/outbox', { token: 'test-admin-token' }), ctx)).outbox.length;
  assert.equal(outboxAfter, outboxBefore, 'unsubscribed address is NOT re-mailed');
  const s = j(await stats(req('GET', 'http://x/api/waitlist/stats', { token: 'test-admin-token' }), ctx));
  assert.equal(s.products['phreaking-fun'].counts.unsubscribed, 1);
  assert.equal(s.products['phreaking-fun'].counts.verified || 0, 0);
  assert.equal(s.products['phreaking-fun'].counts.pending || 0, 0, 'no new record created for unsubscribed address');
});

await test('GC: pending >7d is DELETED by purge (with consent archive + expired counter)', async () => {
  const r = await submit(req('POST', 'http://x/api/waitlist', { body: {
    product: 'mydaywas', email: 'carol@example.com', consent: true,
  } }), ctx);
  assert.equal(j(r).ok, true);
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const key = Object.keys(store).find((k) => store[k]?.product_key === 'mydaywas' && store[k]?.status === 'pending');
  store[key].created_at = new Date(Date.now() - 8 * 86400000).toISOString();
  fs.writeFileSync(STORE, JSON.stringify(store));
  const rep = j(await purge(req('GET', 'http://x/api/waitlist/purge'), ctx));
  assert.equal(rep.pending_deleted, 1);
  const after = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  assert.ok(!Object.values(after).some((x) => x && x.product_key === 'mydaywas' && x.status === 'pending'), 'pending record deleted');
  assert.ok(Object.values(after).some((x) => x && x.consent_text_version && x.email_hash && !x.email), 'consent archive shell exists (no email)');
});

await test('rate limits: 11th submit in an hour from same masked IP → 429', async () => {
  const ip = '10.9.9.9';
  let last;
  for (let i = 0; i < 11; i++) {
    last = await submit(req('POST', 'http://x/api/waitlist', {
      body: { product: 'draftcrypto', email: `u${i}@example.com`, consent: true },
      headers: { 'x-forwarded-for': ip },
    }), ctx);
  }
  assert.equal(last.status, 429);
});

await test('C3: /24 masking — IPs in one subnet share a single rate budget', async () => {
  let limited = 0;
  for (let i = 0; i < 12; i++) {
    const r = await submit(req('POST', 'http://x/api/waitlist', {
      body: { product: 'mydaywas', email: `n${i}@example.com`, consent: true },
      headers: { 'x-forwarded-for': `192.168.1.${10 + i}` },
    }), ctx);
    if (r.status === 429) limited++;
  }
  assert.equal(limited, 2, '10/hour budget shared across the /24: requests 11 and 12 limited');
});

await test('honeypot: filled hidden field → the same constant 200, nothing recorded', async () => {
  const before = Object.keys(JSON.parse(fs.readFileSync(STORE, 'utf8'))).length;
  const r = await submit(req('POST', 'http://x/api/waitlist', {
    body: { product: 'draftcrypto', email: 'bot@example.com', consent: true, website_extra: 'http://spam.example' },
  }), ctx);
  assert.equal(r.status, 200);
  assert.equal(j(r).status, 'pending'); // identical constant body
  const after = Object.keys(JSON.parse(fs.readFileSync(STORE, 'utf8'))).length;
  assert.equal(after, before, 'no new record for honeypot submit');
});

await test('first-party analytics events recorded; invalid event rejected; no PII in events', async () => {
  const r = await eventFn(req('POST', 'http://x/api/waitlist/event', { body: { type: 'waitlist_view', product: 'mydaywas', ...UTM } }), ctx);
  assert.equal(r.status, 200);
  await eventFn(req('POST', 'http://x/api/waitlist/event', { body: { type: 'referral_share', product: 'mydaywas' } }), ctx);
  assert.equal((await eventFn(req('POST', 'http://x/api/waitlist/event', { body: { type: 'pixel_load', product: 'mydaywas' } }), ctx)).status, 400);
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const evs = Object.values(store).filter((r) => r && r.type && r.ts);
  assert.ok(!JSON.stringify(evs).includes('@example.com'), 'no email in events');
  assert.ok(!JSON.stringify(evs).includes('10.0.0.'), 'no IP in events');
});

await test('GC: consent record kept verbatim on the signup (version + timestamp + product)', async () => {
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const rec = Object.values(store).find((r) => r && r.product_key === 'unbound-science');
  assert.equal(rec.consent_text_version, 'waitlist-consent-v1');
  assert.ok(rec.consented_at);
  assert.ok(rec.email && rec.product_key);
});

await test('OBS-324: stats expose utm_id-keyed campaign counts + funnel event_counts per product', async () => {
  const s = j(await stats(req('GET', 'http://x/api/waitlist/stats?product=unbound-science', { token: 'test-admin-ubs-only' }), ctx));
  const ps = s.products['unbound-science'];
  // OBS-219 §7.2 / OBS-139 D3 join key: utm_campaign + utm_id → verified count.
  assert.equal(ps.campaign_ids['w1/d3join'], 1);
  assert.equal(Object.keys(ps.campaign_ids).length, 1, 'aggregates only: one registry key per distinct campaign/utm_id');
  assert.ok(!JSON.stringify(ps).includes('@example.com'), 'no emails in stats');
  // Four-step funnel is reproducible from event_counts (rendered client-side in /admin).
  for (const step of ['waitlist_view', 'waitlist_submit', 'waitlist_verified', 'referral_share']) {
    assert.ok(Number.isInteger(ps.event_counts[step] || 0), step + ' present in event_counts');
  }
  assert.ok(ps.event_counts.waitlist_verified >= 1);
  assert.ok(ps.event_counts.waitlist_submit >= 1);
});

let fails = 0;
for (const [s, name] of results) { console.log(`${s === 'PASS' ? '✓' : '✗'} ${s} — ${name}`); if (s === 'FAIL') fails++; }
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);