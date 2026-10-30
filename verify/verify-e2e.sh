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
req() { # $1=event json-suffix $2=extra curl args...
  printf '{"events":[%s]}' "$BASE$1" > /tmp/obs-verify-event.json
  shift
  curl -sS -o /dev/null -w '%{http_code}\n' "$@" --data @/tmp/obs-verify-event.json -H 'content-type: application/json' -H 'x-obs-consent: granted' "$SITE/api/collect"
}
fail=0
check() { local got="$1" want="$2" name="$3"; if [ "$got" != "$want" ]; then echo "FAIL $name (got $got want $want)"; fail=1; else echo "ok   $name ($got)"; fi; }

check "$(req ',"event_name":"page_view","page_path":"/x?z=1"}')" 200 "valid page_view accepted"
check "$(req ',"event_name":"tx_submitted","tx_hash":"0xabc"}')" 200 "unknown event name rejected-at-collector (silent 200, not persisted)"
check "$(printf '{"events":[%s]}' "$BASE,\"event_name\":\"page_view\",\"page_path\":\"/y\"}" > /tmp/obs-verify-event.json; curl -sS -o /dev/null -w '%{http_code}\n' --data @/tmp/obs-verify-event.json -H 'content-type: application/json' "$SITE/api/collect")" 451 "consent-less send fails closed (HTTP 451)"
ins=$(curl -sS -H "authorization: Bearer $TOKEN" "$SITE/api/insights?days=7")
echo "$ins" | grep -q '"windowDays":7' && echo "ok   insights auth read" || { echo "FAIL insights auth read"; fail=1; }
check "$(curl -sS -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer wrong' "$SITE/api/insights")" 404 "insights bad token → 404"
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED for $SITE ($PRODUCT)" || { echo "FAILED for $SITE"; exit 1; }