# OBS-125 — First-party analytics (Netlify-native)

Board direction 2026-10-30: existing infra only; each site gets its own dashboard baked in on its own domain, running in the GitHub repo + Netlify instance. Storage is **Netlify Blobs** — Netlify, Inc. is the sole processor (site hosting + storage under its DPA); there is no analytics vendor and no other processor (C9 amended per GC OBS-156). Full compliance delta vs the earlier PostHog-on-VPS design: `docs/COMPLIANCE-DELTA.md`. Privacy notice: `public/analytics-notice.html` (GC-approved text).

## What landed here

| Piece | Path | Purpose |
|---|---|---|
| Collector | `netlify/functions/collect.mjs` → `POST /api/collect` | R1 metric-dictionary allowlist (query-strip, host-only referrer, extras dropped+counted), R2 consent fail-closed (451), R3 IP truncation, R6 bot filter (counted, never stored) |
| Dashboard data | `netlify/functions/insights.mjs` → `GET /api/insights` | Bearer-token aggregates: WAU, new users, activation, D1/D7/D30 cohorts, funnels, channel mix, share rate, data-quality counters. 404 on bad token. |
| Retention | `netlify/functions/retention-purge.mjs` | Scheduled daily 03:17 UTC, deletes >90d day-partitions (R4) |
| Dashboard | `public/insights/index.html` → `/insights/` | Token-auth page on this site's own domain; `?peer=https://<sibling>` joins both products for the investor board; Print→PDF weekly export |
| SDK | `public/obs-analytics.js` → `/obs-analytics.js` | First-party consent gate: opt-in, revocable, D4 first-touch UTMs, **sends nothing pre-consent** |
| Acceptance | `verify/verify-e2e.sh` | Wire test against the deployed site |

## Integration state in this repo

- `/obs-analytics.js` loads via `index.html` before the app module. Per OBS-169 the SDK is **default-on** — page views and events are sent without any consent gate.
- **Not yet wired (deliberately):** `experiment_type` emits stay on the `unclassified` closed list until the demo app is inventoried. (OBS-169 removed the consent UI/notice entirely.)
- The legacy `deploy.sh` (VPS `/mockup-unbound`) still builds the static site but has **no** analytics functions — functions + Blobs only run on the Netlify instance.
- Required Netlify env (from the company secret store, never committed): `INSIGHTS_TOKEN` (bearer for `/api/insights`); `INSIGHTS_ALLOWED_ORIGIN` only on the site hosting the cross-origin investor board.

## Go-live gates (do not enable tracking before all are true)

1. `INSIGHTS_TOKEN` set in Netlify site env.
2. Acceptance: `SITE=<domain> PRODUCT=ubs TOKEN=<token> bash verify/verify-e2e.sh` + dashboard screenshots filed on OBS-125.

Superseded by OBS-169: the consent gate, consent UI, and privacy-notice page were removed per board direction; the CISO/GC notice gates above no longer apply.
