// OBS-226 — shared bearer-token gate for the admin dashboard and the insights API.
// Moved verbatim from insights.mjs so the two gates cannot drift.
// R7 — constant-time token compare (length leak only; callers return 404 either way).
'use strict';
import { timingSafeEqual } from 'node:crypto';

export function tokenOk(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Extract the Bearer value from a request; never logs or persists it.
export function bearer(req) {
  return (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
}
