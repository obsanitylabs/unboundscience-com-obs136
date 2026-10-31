#!/usr/bin/env bash
# OBS-226 — live admin acceptance for a DEPLOYED Netlify site.
# Cannot pass until OBS-163 deploys `main` and binds INSIGHTS_TOKEN; ship the script, run it after.
# Usage: SITE=https://unboundscience.com TOKEN=<INSIGHTS_TOKEN> bash verify-admin.sh
# Never prints the token. Redacted transcript: status codes and closed error codes only.
set -uo pipefail
SITE="${SITE:?set SITE=https://<site-domain>}"
TOKEN="${TOKEN:?set TOKEN=<INSIGHTS_TOKEN from the secret store>}"
UA='ObsAdminVerify/1.0'          # must NOT match BOT_UA (which includes 'curl/'); override the UA header
ADMIN_DOC_PREFIX='203.0.113.0/24' # TEST-NET-3 (RFC 5737) — documentation only; we never claim our own IP was rejected
fail=0

say() { printf '%s\n' "$*"; }
check() { local got="$1" want="$2" name="$3"; if [ "$got" != "$want" ]; then say "FAIL $name (got $got want $want)"; fail=1; else say "ok   $name ($got)"; fi; }
status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

new_uuid() { # allocates a UUID v4 without uuidgen portability concerns
  local h; h=$(openssl rand -hex 16)
  printf '%s-%s-4%s-8%s-%s\n' "${h:0:8}" "${h:8:4}" "${h:13:3}" "${h:17:3}" "${h:20:12}"
}

summary() { curl -sS -H "authorization: Bearer $TOKEN" "$SITE/api/admin/summary?days=7"; }
sum_counter() { printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | awk -F: '{s+=$2} END{print s+0}'; }

collect() { # $1 anonymous_id, $2 session_id
  curl -sS -X POST -H 'content-type: application/json' -H "User-Agent: $UA" \
    --data "{\"events\":[{\"product\":\"ubs\",\"event_name\":\"page_view\",\"anonymous_id\":\"$1\",\"session_id\":\"$2\",\"utm_source\":\"direct\",\"utm_medium\":\"community\",\"wallet_connected\":false,\"build_version\":\"verify-admin\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"page_path\":\"/verify\"}]}" \
    "$SITE/api/collect"
}

post_mod() { curl -sS -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' --data "$1" "$SITE/api/admin/moderation"; }

# 1 — unauthenticated admin read is hidden (404, not 401)
check "$(status "$SITE/api/admin/summary")" 404 "summary no token -> 404"

# 2 — token read returns 200 and the asset tiles stay unavailable
SUM=$(summary)
check "$(printf '%s' "$SUM" | grep -c '"reason":"no-asset-ledger"')" 1 "summary 200 + assets.reason=no-asset-ledger"

# warm-up: persist one accepted event so today's events/* partition exists and dataQuality is
# surfaced by summary (the shared insights object only reads quality for days that have events).
WARM=$(collect "$(new_uuid)" "$(new_uuid)")
check "$(printf '%s' "$WARM" | grep -c '"accepted":1')" 1 "warm-up collect accepted"

# 3 — ban a fresh UUID
BAN_UUID=$(new_uuid)
BAN=$(post_mod "{\"op\":\"ban-user\",\"anonymousId\":\"$BAN_UUID\"}")
check "$(printf '%s' "$BAN" | grep -c '"enforced":true')" 1 "ban-user enforced"

# 4 — the banned id is dropped before persist; bannedRejected increases. Retry tolerates the 30s
# warm-instance cache lag documented in the guide.
BEFORE=$(sum_counter "$SUM" bannedRejected)
DROPPED=0
for _ in 1 2 3 4 5 6 7 8; do
  if printf '%s' "$(collect "$BAN_UUID" "$(new_uuid)")" | grep -q '"accepted":0'; then DROPPED=1; break; fi
  sleep 5
done
check "$DROPPED" 1 "banned collect -> accepted 0"
AFTER=$(sum_counter "$(summary)" bannedRejected)
[ "$AFTER" -gt "$BEFORE" ] && say "ok   bannedRejected increased ($BEFORE -> $AFTER)" || { say "FAIL bannedRejected did not increase ($BEFORE -> $AFTER)"; fail=1; }

# 5 — unban, then a new session is accepted again (retry for cache lag)
check "$(printf '%s' "$(post_mod "{\"op\":\"unban-user\",\"anonymousId\":\"$BAN_UUID\"}")" | grep -c '"enforced":true')" 1 "unban-user enforced"
UNBANNED=0
for _ in 1 2 3 4 5 6 7 8; do
  if printf '%s' "$(collect "$BAN_UUID" "$(new_uuid)")" | grep -qE '"accepted":[1-9]'; then UNBANNED=1; break; fi
  sleep 5
done
check "$UNBANNED" 1 "unbanned collect accepted again"

# 6 — reject a documentation prefix, confirm it is listed, then remove it (idempotent script)
check "$(printf '%s' "$(post_mod "{\"op\":\"reject-ip-range\",\"prefix\":\"$ADMIN_DOC_PREFIX\"}")" | grep -c "\"prefix\":\"$ADMIN_DOC_PREFIX\"")" 1 "reject-ip-range stored"
check "$(curl -sS -H "authorization: Bearer $TOKEN" "$SITE/api/admin/moderation" | grep -c "$ADMIN_DOC_PREFIX")" 1 "moderation lists the prefix"
check "$(printf '%s' "$(post_mod "{\"op\":\"allow-ip-range\",\"prefix\":\"$ADMIN_DOC_PREFIX\"}")" | grep -c '"enforced":true')" 1 "allow-ip-range removed"

# 7 — wallet bans are hash-only and non-enforcing; the raw address never appears in GET
WALLET_ADDR="0x$(printf 'deadbeef%.0s' 1 2 3 4 5)"
WALLET_HEX="$(printf 'deadbeef%.0s' 1 2 3 4 5)"
WBAN=$(post_mod "{\"op\":\"ban-wallet\",\"address\":\"$WALLET_ADDR\"}")
check "$(printf '%s' "$WBAN" | grep -c '"enforced":false')" 1 "ban-wallet non-enforcing"
check "$(printf '%s' "$WBAN" | grep -c '"reason":"no-wallet-source"')" 1 "ban-wallet reason no-wallet-source"
check "$(curl -sS -H "authorization: Bearer $TOKEN" "$SITE/api/admin/moderation" | grep -ci "$WALLET_HEX")" 0 "moderation body has no wallet address"
post_mod "{\"op\":\"unban-wallet\",\"address\":\"$WALLET_ADDR\"}" >/dev/null

# 8 — the admin page is public HTML (loads zero data without the bearer), noindex, no secrets in source
PAGE=$(curl -sS "$SITE/admin/")
check "$(printf '%s' "$PAGE" | grep -ci 'noindex')" 1 "admin page noindex"
check "$(printf '%s' "$PAGE" | grep -c 'INSIGHTS_TOKEN')" 0 "admin page leaks no env name"
check "$(printf '%s' "$PAGE" | grep -cF "$TOKEN")" 0 "admin page leaks no token"

[ "$fail" = 0 ] && say "ALL ADMIN CHECKS PASSED for $SITE" || { say "ADMIN CHECKS FAILED for $SITE"; exit 1; }
