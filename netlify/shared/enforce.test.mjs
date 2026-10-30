// OBS-125 — enforcement unit tests (run: node --test netlify/shared/).
// Commits the enforcement guarantee to the repo so R1/R3/R6/R7 behavior is
// reproducible without trusting a run log (CISO OBS-155 condition 3).
'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBatch, validateEvent, truncateIp, redactLogs, stripQuery, hostOnly,
  makeBotFilter, ENUMS_OUT,
} from './enforce.mjs';

const ISO = new Date().toISOString();
const BASE = {
  product: 'ubs', event_name: 'page_view',
  anonymous_id: '01234567-89ab-cdef-0123-456789abcdef', session_id: '01234567-89ab-cdef-0123-456789abcdff',
  utm_source: 'x', utm_medium: 'organic_social', referrer: 'https://x.com/',
  wallet_connected: false, build_version: 'v1', timestamp: ISO, page_path: '/experiments',
};
const valid = (o) => ({ ...BASE, ...o });

test('stripQuery: path only, never the query string (R1)', () => {
  assert.equal(stripQuery('/p?utm_source=x&email=a@b.c'), '/p');
  assert.equal(stripQuery('/p'), '/p');
  assert.equal(stripQuery(123), undefined);
});

test('hostOnly: referrer reduced to host, no path/query (R1)', () => {
  assert.equal(hostOnly('https://x.com/some/path?ref=secret'), 'x.com');
  assert.equal(hostOnly(''), undefined);
  assert.equal(hostOnly('not-a-url'), undefined);
});

test('R1: valid full-common-attribute page_view accepted', () => {
  const r = validateEvent(valid({}));
  assert.ok(r.ok);
  assert.equal(r.event.page_path, '/experiments');
  assert.equal(r.event.referrer, 'x.com');
});

test('R1: query string stripped from persisted page_path', () => {
  const r = validateEvent(valid({ page_path: '/p?token=leak' }));
  assert.ok(r.ok);
  assert.equal(r.event.page_path, '/p');
});

test('R1: non-allowlisted attributes silently dropped + counted, never persisted', () => {
  const r = validateEvent(valid({ email: 'a@b.c', password: 'hunter2', wallet_address: '0xabc' }));
  assert.ok(r.ok);
  assert.ok(!('email' in r.event) && !('password' in r.event) && !('wallet_address' in r.event));
  assert.equal(r.dropped.filter((d) => d.startsWith('extra:')).length, 3);
});

test('R1: unknown event name rejected', () => {
  const r = validateEvent(valid({ event_name: 'tx_submitted', tx_hash: '0xabc' }));
  assert.ok(!r.ok);
  assert.ok(!('tx_hash' in (r.event || {})));
});

test('R1: bad product rejected', () => {
  assert.ok(!validateEvent(valid({ product: 'evil' })).ok);
});

test('pff wallet_connected requires Sepolia chain_id 11155111', () => {
  const pffWallet = (chain_id) => validateEvent({
    ...BASE, product: 'pff', event_name: 'wallet_connected',
    wallet_type: 'metamask', utm_medium: 'organic_social', chain_id,
  });
  const good = pffWallet(11155111);
  assert.ok(good.ok);
  const bad = pffWallet(1);
  assert.ok(!bad.ok); // pinned: non-Sepolia chain_id fails (CISO OBS-155 correctness note)
  const notInt = pffWallet('11155111');
  assert.ok(!notInt.ok);
});

test('closed enums enforced (role, box_type, share_target, wallet_type)', () => {
  assert.ok(validateEvent(valid({ event_name: 'role_selected', role: 'donor' })).ok);
  assert.ok(!validateEvent(valid({ event_name: 'role_selected', role: 'admin' })).ok);
  assert.ok(validateEvent({
    ...BASE, product: 'pff', event_name: 'core_action',
    action_type: 'box_opened', box_type: 'mystery',
  }).ok);
  assert.ok(!validateEvent({
    ...BASE, product: 'pff', event_name: 'core_action',
    action_type: 'box_opened', box_type: 'gold',
  }).ok);
  assert.ok(validateEvent(valid({ event_name: 'share_click', share_target: 'x', surface: 'result_card' })).ok);
  assert.ok(!validateEvent(valid({ event_name: 'share_click', share_target: 'email' })).ok);
});

test('D4: utm_source falls back to direct; malformed UTM values dropped', () => {
  const r = validateEvent(valid({ utm_source: undefined }));
  assert.ok(r.ok);
  assert.equal(r.event.utm_source, 'direct');
  const bad = validateEvent(valid({ utm_campaign: 'BIG SPAM!!' }));
  assert.ok(bad.ok);
  assert.equal(bad.event.utm_campaign, undefined);
  assert.ok(bad.dropped.includes('utm_campaign'));
});

test('missing required attribute rejects the event', () => {
  const r = validateEvent(valid({ page_path: undefined }));
  assert.ok(!r.ok);
  assert.match(r.reason, /missing-required/);
});

test('R3: IPv4 truncated to /24; IPv6 truncated to first 3 hextets; garbage null', () => {
  assert.equal(truncateIp('203.0.113.57'), '203.0.113.0');
  assert.equal(truncateIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334'), '2001:0db8:85a3:0000:0000:0000:0000:0000');
  assert.equal(truncateIp('garbage'), null);
  assert.equal(truncateIp(''), null);
});

test('R3: log redaction strips full IPs from log lines', () => {
  assert.equal(redactLogs('collect: accepted=1 ip=203.0.113.57'), 'collect: accepted=1 ip=[ip-redacted]');
  // full-form IPv6 as produced by truncateIp (the only form ever logged)
  const red6 = redactLogs('ip=' + truncateIp('2001:db8:85a3::7334'));
  assert.ok(!red6.includes('85a3') && red6.includes('[ip-redacted]'));
});

test('R6: UA bot heuristic — Googlebot filtered, never persisted', () => {
  const f = makeBotFilter({ store: new Map() });
  assert.deepEqual(f({ truncatedIp: truncateIp('198.51.100.9'), userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }), { bot: true, reason: 'ua-heuristic' });
});

test('R6: truncated-IP rate heuristic trips at >30 events/min, counted not stored', () => {
  const f = makeBotFilter({ store: new Map() });
  const ip = truncateIp('198.51.100.9');
  let last;
  for (let i = 0; i < 32; i++) last = f({ truncatedIp: ip, userAgent: 'Mozilla/5.0 (normal)' });
  assert.deepEqual(last, { bot: true, reason: 'rate-heuristic' });
});

test('validateBatch: stats feed the data-quality counters', () => {
  const { accepted, stats } = validateBatch([
    valid({}),
    valid({ event_name: 'nope' }),
    valid({ email: 'a@b.c' }),
  ]);
  assert.equal(accepted.length, 2);
  assert.equal(stats.accepted, 2);
  assert.equal(stats.rejected, 1);
  assert.ok(stats.droppedAttributes >= 3); // email extra + nope's page_path etc.
});

test('enums exposure matches the metric dictionary', () => {
  assert.deepEqual(ENUMS_OUT.product, ['ubs', 'pff']);
  assert.ok(ENUMS_OUT.utm_source.includes('direct'));
  assert.deepEqual(ENUMS_OUT.experiment_type, ['unclassified']);
});