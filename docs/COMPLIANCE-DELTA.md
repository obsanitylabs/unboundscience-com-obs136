# OBS-125 — R1–R7 compliance mapping vs. CISO/GC-approved config (delta for re-confirmation)

The privacy review (OBS-124, rev `e60572d0`) and GC verdict (OBS-150) signed off on
R1–R7 with **self-hosted PostHog** on a small host. Board direction of 2026-10-30
(existing infrastructure only, no new monthly spend, GitHub repo + Netlify) removes the
host, so the **storage backend changes: PostHog → Netlify Blobs**. Enforcement logic is
the same code (11/11 unit tests) deployed as Netlify Functions. This delta needs a short
CISO/GC re-confirmation before tracking fires.

| Req | Approved design | Netlify-native design | Delta |
|---|---|---|---|
| R1 | Allowlist proxy before PostHog; query-strip; host-only referrer | Same `validateBatch` in `collect.mjs` before Blobs write | none |
| R2 | Consent gate SDK + proxy `x-obs-consent` check | Same SDK (same-origin) + function 451 fail-closed | none |
| R3 | IP truncation at proxy, log redaction | `truncateIp` in `collect.mjs` before any use; `redactLogs` on function logs | none |
| R4 | ≤90d retention + backup rotation + restore cutoff | Scheduled purge deletes >90d day-partitions | **No raw-event backups** (Blobs is Netlify-managed; no secondary PII copy). Aggregates exportable from `/api/insights`. |
| R5 | No outbound telemetry / no third-party CDNs | Netlify static+functions only; no third-party scripts | none |
| R6 | Truncated-IP-rate + UA bot filter, counted not stored | Same heuristics; `botFiltered` counted in quality Blobs only | none |
| R7 | TLS-only, auth-gated dashboards, pinned versions | Netlify TLS; `/api/insights` bearer-token (404 on bad token); function runtime pinned by Netlify | Function PaaS instead of pinned docker images |
| C9 | First-party SDK | SDK served from each site's own origin; collector same-origin | **Stronger** (no shared analytics subdomain at all). Per GC OBS-156: Netlify, Inc. is the sole **processor** (hosting + Blobs storage under its DPA) — do not claim "no processor" or "no transfers"; US processing is a restricted transfer for EU/UK visitors safeguarded by Netlify DPA SCCs (Module 2) + EU-US DPF/UK extension where certified. |

Verdicts (2026-10-30): CISO re-confirmed R4/R7 (OBS-155) — APPROVE; GC re-confirmed the storage/processor delta and approved the notice text (OBS-156) — conditions: notice live with controller fields filled, Netlify account DPA confirmed in writing, consent revoke clears local ids (implemented in `obs-analytics.js`), no "no processor"/"no transfers" claims, `INSIGHTS_TOKEN` ≥32 bytes from the company secret store rotated every 90d.

Open items before tracking fires on production:
1. ~~CISO/GC re-confirm the R4/R7 storage delta~~ — DONE (OBS-155, OBS-156).
2. ~~GC approval of the per-site privacy-notice text~~ — DONE (OBS-156 §2); published at `public/analytics-notice.html`; controller fields pending board confirmation.
3. `INSIGHTS_TOKEN` set in each site's Netlify env from the company secret store; `INSIGHTS_ALLOWED_ORIGIN` unset except the site hosting the cross-origin investor board.
4. `experiment_type` closed list finalized from ubs app code.