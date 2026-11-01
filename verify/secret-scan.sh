#!/usr/bin/env bash
# OBS-203 — CISO C5: scan every file that ships to the client (public/) for
# client-bundled secrets: VITE_/NEXT_PUBLIC_/REACT_APP_ env injection, key-looking
# strings, bearer tokens. Fails the build if any hit is found. Run before every deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "scanning public/ for client-bundled secrets (C5)..."
status=0

# VITE_-style client env injection (the OBS-137 (a) failure class)
if grep -rInE 'VITE_[A-Z]|NEXT_PUBLIC_[A-Z]|REACT_APP_[A-Z]' public/ ; then
  echo "FAIL: client-bundled env secret pattern found"; status=1
fi

# Key/token-like literals in the published bundle
if grep -rInE '(-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})' public/ ; then
  echo "FAIL: key/token literal found in public output"; status=1
fi

# WAITLIST_* token values must never appear in any shipped/tracked file.
# (excluded: verify/, which contains only obvious "test-" dummy fixtures)
if grep -rInE 'WAITLIST_(ADMIN|EXPORT)_TOKEN(_[A-Z]+)?\s*=\s*["'"'"'][^"'"'"']+' \
  public/ netlify/ scripts/ netlify.toml 2>/dev/null ; then
  echo "FAIL: literal WAITLIST_* token value committed"; status=1
fi

if [ "$status" -eq 0 ]; then echo "C5 secret scan: CLEAN"; else exit 1; fi