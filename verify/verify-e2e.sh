#!/usr/bin/env bash
# OBS-125 — full-taxonomy acceptance for a DEPLOYED Netlify site (run per site).
# Usage: SITE=https://demo.unboundscience.io PRODUCT=ubs TOKEN=<insights token> bash verify-e2e.sh
set -uo pipefail
SITE="${SITE:?set SITE=https://<site-domain>}"
PRODUCT="${PRODUCT:?set PRODUCT=ubs|pff}"
TOKEN="${TOKEN:?set TOKEN=<INSIGHTS_TOKEN from the secret store>}"

AID="a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d"
SID="b2c3d4e5-f6a7-4b5c-9d0e-1f2a3b4c5d6e"
BASE="$(printf '{"product":"%s","anonymous_id":"%s","session_id":"%s","utm_source":"direct","utm_medium":"community","wallet_connected":false,"build_version":"verify-1","timestamp":"%s"' "$PRODUCT" "$AID" "$SID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED for $SITE ($PRODUCT)" || { echo "FAILED for $SITE"; exit 1; }