#!/usr/bin/env bash
# OBS-125 — full-taxonomy acceptance for a DEPLOYED Netlify site (run per site).
# OBS-355 — every dictionary event name probed per product, checking accepted count
# (HTTP is 200 even for collector-rejected events, so we assert on "accepted").
# Usage: SITE=https://demo.unboundscience.io PRODUCT=ubs TOKEN=<insights token> bash verify-e2e.sh
set -uo pipefail
SITE="${SITE:?set SITE=https://<site-domain>}"
PRODUCT="${PRODUCT:?set PRODUCT=ubs|pff}"
TOKEN="${TOKEN:?set TOKEN=<INSIGHTS_TOKEN from the secret store>}"

AID="a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d"
SID="b2c3d4e5-f6a7-4b5c-9d0e-1f2a3b4c5d6e"
BASE="$(printf '{"product":"%s","anonymous_id":"%s","session_id":"%s","utm_source":"direct","utm_medium":"community","wallet_connected":false,"build_version":"verify-1","timestamp":"%s"' "$PRODUCT" "$AID" "$SID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
req() { # $1=event json-suffix; echoes the "accepted" count from the response body
  printf '{"events":[%s]}' "$BASE$1" > /tmp/obs-verify-event.json
  curl -sS --data @/tmp/obs-verify-event.json -H 'content-type: application/json' "$SITE/api/collect" \
    | grep -o '"accepted":[0-9]*' | cut -d: -f2
}
fail=0
check() { local got="$1" want="$2" name="$3"; if [ "$got" != "$want" ]; then echo "FAIL $name (got $got want $want)"; fail=1; else echo "ok   $name (accepted=$got)"; fi }

check "$(req ',"event_name":"page_view","page_path":"/x?z=1"}')" 1 "valid page_view accepted"
check "$(req ',"event_name":"tx_submitted","tx_hash":"0xabc"}')" 0 "unknown event name rejected-at-collector (silent 200, not persisted)"
check "$(req ',"event_name":"page_view","page_path":"/y"}')" 1 "header-less send accepted (OBS-169 default-on, no consent gate)"
check "$(req ',"event_name":"session_start","is_returning":false,"days_since_last_session":1}')" 1 "session_start accepted"
if [ "$PRODUCT" = "ubs" ]; then
  check "$(req ',"event_name":"role_selected","role":"scientist"}')" 1 "role_selected accepted"
  check "$(req ',"event_name":"experiment_started","experiment_type":"unclassified"}')" 1 "experiment_started accepted"
  check "$(req ',"event_name":"core_action","action_type":"experiment_run"}')" 1 "core_action accepted"
else
  check "$(req ',"event_name":"wallet_connected","wallet_type":"metamask","chain_id":11155111}')" 1 "wallet_connected accepted"
  check "$(req ',"event_name":"core_action","action_type":"box_opened","box_type":"blue"}')" 1 "core_action accepted"
  check "$(req ',"event_name":"funnel_step","funnel_name":"pff_purchase","step_index":1,"step_name":"connect","chain_id":11155111}')" 1 "funnel_step accepted"
fi
# OBS-355 regression probe — the previously always-dropped activation_complete
ACT_EXTRA='"box_type":"blue"'
[ "$PRODUCT" = "ubs" ] && ACT_EXTRA='"experiment_type":"unclassified"'
ACT_OK=",\"event_name\":\"activation_complete\",\"first_session\":true,\"time_to_activation_s\":42,\"activation_path\":\"connect-blue_box\",$ACT_EXTRA}"
ACT_BAD=",\"event_name\":\"activation_complete\",\"first_session\":\"yes\",\"time_to_activation_s\":42,\"activation_path\":\"connect-blue_box\",$ACT_EXTRA}"
check "$(req "$ACT_OK")" 1 "activation_complete accepted (OBS-355 first_session fix)"
check "$(req "$ACT_BAD")" 0 "activation_complete with non-bool first_session dropped"
check "$(req ',"event_name":"share_click","share_target":"copy_link","surface":"result_link"}')" 1 "share_click accepted"
check "$(req ',"event_name":"error","error_code":"E1","error_surface":"client","message_key":"m1","api_status":500}')" 1 "error accepted"
ins=$(curl -sS -H "authorization: Bearer $TOKEN" "$SITE/api/insights?days=7")
echo "$ins" | grep -q '"windowDays":7' && echo "ok   insights auth read" || { echo "FAIL insights auth read"; fail=1; }
check "$(curl -sS -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer wrong" "$SITE/api/insights")" 404 "insights bad token → 404"
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED for $SITE ($PRODUCT)" || { echo "FAILED for $SITE"; exit 1; }