// OBS-125 / OBS-169 — first-party default-on analytics SDK (D4 first-touch UTMs, C9: served
// from the SITE'S OWN ORIGIN — same-domain /api/collect; nothing loads from any third party).
// Drop into the site: <script src="/obs-analytics.js" defer></script>
// Per board direction (OBS-169): collection is default-on — no consent gate, no banner, no
// notice page. Only aggregate product metrics are sent: a random anonymous_id/session_id,
// page paths, campaign tags, and event counters. No personal information is collected;
// IPs are truncated (R3) and bots filtered (R6) at the collector, retention ≤90d (R4).
'use strict';
(function () {
  var UTM_KEY = 'obs_analytics_first_touch';
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function ids() {
    var A = 'obs_aid', S = 'obs_sid';
    var aid, sid;
    try {
      aid = sessionStorage.getItem(A) || localStorage.getItem(A) || uuid();
      sid = sessionStorage.getItem(S) || uuid();
      localStorage.setItem(A, aid); sessionStorage.setItem(A, aid); sessionStorage.setItem(S, sid);
    } catch (e) { aid = uuid(); sid = uuid(); }
    return { aid: aid, sid: sid };
  }
  // D4 — first-touch attribution: capture UTMs once on the earliest pageview, persist locally.
  function firstTouch() {
    var utm = {};
    try {
      var saved = localStorage.getItem(UTM_KEY);
      if (saved) return JSON.parse(saved);
      var q = new URLSearchParams(location.search);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'].forEach(function (k) {
        var v = q.get(k); if (v && /^[a-z0-9-]{1,60}$/i.test(v)) utm[k] = v.toLowerCase();
      });
      if (!utm.utm_source) utm.utm_source = 'direct';
      localStorage.setItem(UTM_KEY, JSON.stringify(utm));
    } catch (e) { utm = { utm_source: 'direct' }; }
    return utm;
  }
  var COLLECT_URL = window.OBS_COLLECT_PATH || '/api/collect';
  function send(batch) {
    var ids0 = ids();
    var body = JSON.stringify({
      events: batch.map(function (ev) {
        return Object.assign({
          product: window.OBS_ANALYTICS_PRODUCT,
          anonymous_id: ids0.aid, session_id: ids0.sid,
          wallet_connected: false, build_version: window.OBS_BUILD_VERSION || '',
          timestamp: new Date().toISOString(),
          referrer: document.referrer || '',
        }, firstTouch(), ev);
      }),
    });
    navigator.sendBeacon && navigator.sendBeacon(COLLECT_URL, new Blob([body], { type: 'application/json' }));
    return true;
  }
  window.OBS = {
    // OBS-169: analytics are default-on. Kept as compatibility stubs for older integrations.
    consent: { status: function () { return true; }, grant: function () {}, revoke: function () {} },
    // Read-only: returns the stored anonymous_id (or null) for support/deletion requests.
    anonymousId: function () {
      try { return localStorage.getItem('obs_aid') || sessionStorage.getItem('obs_aid') || null; } catch (e) { return null; }
    },
    page: function (path) { send([{ event_name: 'page_view', page_path: path || location.pathname }]); },
    sessionStart: function (isReturning, daysSince) { send([{ event_name: 'session_start', is_returning: !!isReturning, days_since_last_session: Number(daysSince) || 0 }]); },
    event: function (name, attrs) { var e2 = Object.assign({ event_name: name }, attrs || {}); send([e2]); },
    send: send,
  };
  window.addEventListener('pageshow', function () { window.OBS.page(); });
})();