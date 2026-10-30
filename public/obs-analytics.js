// OBS-125 — first-party consent-gate analytics SDK (R2, D4 first-touch UTMs, C9: served from
// the SITE'S OWN ORIGIN — same-domain /api/collect; nothing loads from any third party).
// Drop into the site: <script src="/obs-analytics.js" defer></script>
// Opt-in for EU/UK visitors, revocable, nothing sent pre-consent, and no wallet SDK loads
// before consent. Include on every page BEFORE any wallet-provider script tags.
'use strict';
(function () {
  var LS_KEY = 'obs_analytics_consent';
  var UTM_KEY = 'obs_analytics_first_touch';
  function consented() {
    try { return localStorage.getItem(LS_KEY) === 'granted'; } catch (e) { return false; }
  }
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
    if (!consented()) return false; // fail closed — nothing leaves the browser pre-consent
    var ids0 = ids();
    var body = JSON.stringify({
      // sendBeacon cannot set request headers, so consent is signaled in the body;
      // the collector accepts either the x-obs-consent header or this body flag (R2).
      consent: 'granted',
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
    consent: {
      grant: function () { try { localStorage.setItem(LS_KEY, 'granted'); } catch (e) {} window.OBS.page(); },
      revoke: function () { try { localStorage.setItem(LS_KEY, 'revoked'); } catch (e) {} },
      status: consented,
    },
    page: function (path) { send([{ event_name: 'page_view', page_path: path || location.pathname }]); },
    sessionStart: function (isReturning, daysSince) { send([{ event_name: 'session_start', is_returning: !!isReturning, days_since_last_session: Number(daysSince) || 0 }]); },
    event: function (name, attrs) { var e2 = Object.assign({ event_name: name }, attrs || {}); send([e2]); },
    send: send,
  };
  // Wallet-provider SDKs must be loaded by the app only after OBS.consent.status() === true.
  window.addEventListener('pageshow', function () { if (consented()) window.OBS.page(); });
})();