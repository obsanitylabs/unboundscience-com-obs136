// R1/R3/R6 collector-side enforcement — Netlify-native port of the OBS-125 collector proxy
// (same logic, 11/11 unit tests passing upstream). Metric dictionary OBS-123 rev 4ce6a4e7.
// Non-allowlisted event names/attributes are silently DROPPED (counted, never persisted).
'use strict';

const COMMON = ['product', 'event_name', 'anonymous_id', 'session_id', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'referrer', 'wallet_connected', 'build_version', 'timestamp'];

const COMMON_OPTIONAL = ['chain_id'];

const UBS_EVENTS = {
  page_view: ['page_path'],
  session_start: ['is_returning', 'days_since_last_session'],
  role_selected: ['role'],
  experiment_started: ['experiment_type'],
  activation_complete: ['first_session', 'time_to_activation_s', 'experiment_type', 'activation_path'],
  core_action: ['action_type'],
  share_click: ['share_target', 'surface'],
  error: ['error_code', 'error_surface', 'message_key', 'api_status'],
};

const PFF_EVENTS = {
  page_view: ['page_path'],
  session_start: ['is_returning', 'days_since_last_session'],
  wallet_connected: ['wallet_type', 'chain_id'],
  core_action: ['action_type', 'box_type'],
  activation_complete: ['first_session', 'time_to_activation_s', 'box_type', 'activation_path'],
  funnel_step: ['funnel_name', 'step_index', 'step_name', 'chain_id'],
  share_click: ['share_target', 'surface'],
  error: ['error_code', 'error_surface', 'message_key'],
};

const ENUMS = {
  product: ['ubs', 'pff'],
  role: ['donor', 'scientist', 'community', 'other'],
  action_type_ubs: ['experiment_run', 'result_save', 'result_share'],
  action_type_pff: ['box_opened', 'collection_viewed'],
  box_type: ['mystery', 'white', 'silver', 'blue'],
  share_target: ['copy_link', 'x', 'farcaster', 'other'],
  surface: ['result_link', 'result_card'],
  error_surface: ['client', 'api', 'wallet', 'tx'],
  wallet_type: ['metamask', 'walletconnect', 'web3auth', 'keplr', 'other'],
  funnel_name: ['pff_purchase'],
  experiment_type: ['unclassified'],
  utm_source: ['direct', 'x', 'farcaster', 'telegram', 'discord', 'reddit', 'hackathon', 'dev_community'],
  utm_medium: ['organic_social', 'community', 'event', 'content', 'referral'],
};

const UTM_RE = /^[a-z0-9-]{1,60}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Strip query strings before persistence (R1) — page_path: path only.
export function stripQuery(p) {
  if (typeof p !== 'string') return undefined;
  const i = p.indexOf('?');
  return (i === -1 ? p : p.slice(0, i)).slice(0, 512);
}

// Referrer: host only — no path, no query (R1).
export function hostOnly(u) {
  if (typeof u !== 'string' || !u.length) return undefined;
  try { return new URL(u).host.slice(0, 255); } catch { return undefined; }
}

function typeOk(v, t) {
  switch (t) {
    case 'uuid': return UUID_RE.test(String(v));
    case 'bool': return typeof v === 'boolean';
    case 'int': return Number.isInteger(v);
    case 'num': return typeof v === 'number' && Number.isFinite(v);
    case 'iso': return ISO_RE.test(String(v));
    case 'str': return typeof v === 'string' && v.length > 0 && v.length <= 255;
    default: return false;
  }
}

const COMMON_TYPES = {
  product: 'enum', event_name: 'enum', anonymous_id: 'uuid', session_id: 'uuid',
  utm_campaign: 'utm', utm_content: 'utm', utm_term: 'utm', utm_id: 'utm', utm_medium: 'enum-medium', utm_source: 'enum-source',
  referrer: 'str', wallet_connected: 'bool', chain_id: 'int', build_version: 'str', timestamp: 'iso',
};

export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') return { ok: false, reason: 'not-an-object' };
  const product = ev.product;
  if (product !== 'ubs' && product !== 'pff') return { ok: false, reason: 'bad-product' };
  const table = product === 'ubs' ? UBS_EVENTS : PFF_EVENTS;
  const name = ev.event_name;
  if (!Object.prototype.hasOwnProperty.call(table, name)) return { ok: false, reason: 'unknown-event-name' };

  const out = { product, event_name: name };
  const dropped = [];

  for (const k of COMMON) {
    let v = ev[k];
    if (k === 'utm_source' && (v === undefined || v === null || v === '')) v = 'direct';
    if (k === 'referrer' && typeof v === 'string' && v.length) v = hostOnly(v);
    if (v === undefined) { dropped.push(k); continue; }
    const t = COMMON_TYPES[k];
    if (t === 'enum') {
      const list = k === 'utm_source' ? ENUMS.utm_source : ENUMS.product;
      if (k === 'event_name' || !list.includes(v)) { if (k === 'event_name') continue; dropped.push(k); continue; }
      out[k] = v;
    } else if (t === 'enum-medium') {
      if (ENUMS.utm_medium.includes(v)) out.utm_medium = v; else dropped.push(k);
    } else if (t === 'enum-source') {
      if (ENUMS.utm_source.includes(v)) out.utm_source = v; else dropped.push(k);
    } else if (t === 'utm') {
      if (!UTM_RE.test(String(v))) { dropped.push(k); continue; }
      out[k] = String(v);
    } else if (!typeOk(v, t)) { dropped.push(k); continue; } else { out[k] = v; }
  }
  if (!out.anonymous_id || !out.session_id) return { ok: false, reason: 'missing-anonymous_id-or-session_id' };
  if (out.utm_source && !ENUMS.utm_source.includes(out.utm_source)) dropped.push('utm_source');

  for (const k of table[name]) {
    let v = ev[k];
    if (v === undefined) { dropped.push(k); continue; }
    switch (k) {
      case 'page_path': out.page_path = stripQuery(v); break;
      case 'referrer': out.referrer = hostOnly(v); break;
      case 'is_returning': case 'first_session':
        if (typeOk(v, 'bool')) out[k] = v; else dropped.push(k); break;
      case 'days_since_last_session': case 'time_to_activation_s': case 'step_index': case 'api_status':
        if (typeOk(v, k === 'api_status' ? 'int' : 'num')) out[k] = v; else dropped.push(k); break;
      case 'chain_id':
        if (product === 'pff' && name === 'wallet_connected' && v !== 11155111) { dropped.push(k); break; }
        if (typeOk(v, 'int')) out.chain_id = v; else dropped.push(k); break;
      case 'role': case 'share_target': case 'surface': case 'wallet_type': case 'box_type':
      case 'error_surface': case 'funnel_name': case 'experiment_type': case 'action_type': {
        const list2 = k === 'action_type' ? (product === 'ubs' ? ENUMS.action_type_ubs : ENUMS.action_type_pff)
          : k === 'surface' && name === 'share_click' ? ENUMS.surface
          : k === 'funnel_name' ? ENUMS.funnel_name
          : ENUMS[k] || [];
        if (list2.includes(v)) out[k] = v; else dropped.push(k); break;
      }
      case 'error_code': case 'message_key': case 'step_name': case 'activation_path': case 'utm_id':
        if (typeOk(v, 'str')) out[k] = String(v).slice(0, 255); else dropped.push(k); break;
      default: dropped.push(k);
    }
  }
  const allowed = new Set([...COMMON, ...COMMON_OPTIONAL, ...table[name]]);
  for (const k of Object.keys(ev)) if (!allowed.has(k)) dropped.push(`extra:${k}`);

  const missingRequired = table[name].filter((k) => (name === 'error' && k === 'api_status') ? false : out[k] === undefined);
  if (missingRequired.length) return { ok: false, reason: `missing-required:${missingRequired.join(',')}` };

  return { ok: true, event: out, dropped };
}

export function validateBatch(events) {
  const stats = { accepted: 0, rejected: 0, droppedAttributes: 0 };
  const accepted = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const r = validateEvent(ev);
    if (r.ok) { accepted.push(r.event); stats.accepted++; stats.droppedAttributes += r.dropped.length; }
    else stats.rejected++;
  }
  return { accepted, stats };
}

// R3 — truncate IP at the earliest hop; never persist a full IP in the store or logs.
export function truncateIp(ip) {
  if (typeof ip !== 'string' || !ip.length) return null;
  if (ip.includes('.')) {
    const o = ip.split('.');
    if (o.length !== 4 || o.some((x) => !/^\d{1,3}$/.test(x))) return null;
    return `${o[0]}.${o[1]}.${o[2]}.0`;
  }
  if (ip.includes(':')) {
    const full = ip.split('::')[0];
    const g = full.split(':');
    while (g.length < 3) g.push('0');
    return g.slice(0, 3).map((x) => x || '0').join(':') + ':0000:0000:0000:0000:0000';
  }
  return null;
}

const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const IPV6_RE = /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g;

export function redactLogs(s) {
  return String(s).replace(IPV4_RE, '[ip-redacted]').replace(IPV6_RE, '[ip-redacted]');
}

// R6 — bot filtering: truncated-IP-rate + UA heuristic. Filtered = counted, never stored.
export const BOT_UA = /(bot|crawler|spider|headlesschrome|phantomjs|curl\/|wget|python-requests|scrapy|lighthouse|node-fetch|go-http-client)/i;
export const MAX_EVENTS_PER_MIN_PER_TRUNCATED_IP = 30;

export function makeBotFilter({ store, maxPerMin = MAX_EVENTS_PER_MIN_PER_TRUNCATED_IP } = {}) {
  const buckets = store || new Map();
  return function isBot({ truncatedIp, userAgent, now = Date.now() } = {}) {
    const uaBot = typeof userAgent === 'string' && BOT_UA.test(userAgent);
    if (uaBot) return { bot: true, reason: 'ua-heuristic' };
    if (!truncatedIp) return { bot: false, reason: null };
    const arr = (buckets.get(truncatedIp) || []).filter((t) => now - t < 60_000);
    arr.push(now);
    buckets.set(truncatedIp, arr);
    if (arr.length > maxPerMin) return { bot: true, reason: 'rate-heuristic' };
    return { bot: false, reason: null };
  };
}

export const ENUMS_OUT = ENUMS;