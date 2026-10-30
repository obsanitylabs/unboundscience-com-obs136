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
      // GC OBS-156 condition 4 — withdrawal deletes the local identifiers and first-touch
      // attribution keys, not just the flag; new collection stops immediately.
      revoke: function () {
        try {
          localStorage.setItem(LS_KEY, 'revoked');
          localStorage.removeItem('obs_aid'); sessionStorage.removeItem('obs_aid');
          sessionStorage.removeItem('obs_sid'); localStorage.removeItem(UTM_KEY);
        } catch (e) {}
      },
      status: consented,
    },
    // Read-only: returns the stored anonymous_id (or null). Never persists anything, so
    // nothing is stored on the device pre-consent. Users copy this id for deletion requests.
    anonymousId: function () {
      try { return localStorage.getItem('obs_aid') || sessionStorage.getItem('obs_aid') || null; } catch (e) { return null; }
    },
    page: function (path) { send([{ event_name: 'page_view', page_path: path || location.pathname }]); },
    sessionStart: function (isReturning, daysSince) { send([{ event_name: 'session_start', is_returning: !!isReturning, days_since_last_session: Number(daysSince) || 0 }]); },
    event: function (name, attrs) { var e2 = Object.assign({ event_name: name }, attrs || {}); send([e2]); },
    send: send,
  };
  // Wallet-provider SDKs must be loaded by the app only after OBS.consent.status() === true.
  window.addEventListener('pageshow', function () { if (consented()) window.OBS.page(); });

  // GC-approved consent banner (OBS-156 §2): off until you opt in; no pre-ticked box;
  // never blocks the product; link to the notice page, not a substitute for it.
  var NOTICE_URL = window.OBS_NOTICE_PATH || '/analytics-notice.html';
  function bannerHidden() {
    try { return localStorage.getItem(LS_KEY) !== null; } catch (e) { return true; }
  }
  function removeBanner() { var b = document.getElementById('obs-consent-banner'); if (b) b.remove(); }
  function showBanner() {
    if (bannerHidden() || document.getElementById('obs-consent-banner')) return;
    var p = location.pathname;
    if (p.indexOf('/insights') === 0 || p.indexOf('/analytics-notice') === 0) return;
    var d = document.createElement('div');
    d.id = 'obs-consent-banner';
    d.setAttribute('role', 'region');
    d.setAttribute('aria-label', 'Analytics consent');
    d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483000;background:#111;color:#eee;font:13px/1.5 system-ui,sans-serif;padding:12px 16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:center';
    var span = document.createElement('span');
    span.textContent = 'Product analytics are off until you opt in. We store a random id on this device and send page paths and campaign tags to measure the product. No ads. Withdraw any time. ';
    var a = document.createElement('a');
    a.href = NOTICE_URL; a.textContent = 'Analytics notice';
    a.style.cssText = 'color:#7cc;color:inherit;text-decoration:underline';
    var ok = document.createElement('button');
    ok.textContent = 'Allow analytics';
    ok.style.cssText = 'background:#2e7d32;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit';
    ok.onclick = function () { window.OBS.consent.grant(); removeBanner(); };
    var no = document.createElement('button');
    no.textContent = 'No thanks';
    no.style.cssText = 'background:#333;color:#ccc;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit';
    no.onclick = function () { window.OBS.consent.revoke(); removeBanner(); };
    d.appendChild(span); d.appendChild(a); d.appendChild(ok); d.appendChild(no);
    document.body.appendChild(d);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner);
  else showBanner();
  // Withdraw from the notice page: same revoke path (clears ids + stops sends).
  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'obs-withdraw-consent') {
      window.OBS.consent.revoke(); removeBanner();
      var s = document.getElementById('obs-consent-state');
      if (s) s.textContent = 'Analytics are OFF on this device. Local identifiers were deleted.';
    }
  });
})();