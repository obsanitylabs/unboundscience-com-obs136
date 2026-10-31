// OBS-125 — R4 retention purge (scheduled daily): delete event + quality day-partitions older than 90 days.
// Raw events are never backed up (no secondary copy of PII-adjacent data); aggregates live in the dashboards.
// OBS-226: also purge aged `moderation/audit/*` rows. `moderation/bans` is NEVER purged — a ban
// outlives the events it was meant to suppress.
'use strict';
import { getStore } from '@netlify/blobs';
import { listKeys } from '../shared/aggregate.mjs';

const RETENTION_DAYS = 90;
const dayRe = /^\d{4}-\d{2}-\d{2}$/;
const PARTITION_RE = /^(?:events|quality|moderation\/audit)\/(\d{4}-\d{2}-\d{2})$/;

// Testable core — caller supplies the store.
export async function purge(store) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const keys = listKeys(await store.list());
  let deleted = 0;
  for (const key of keys) {
    const m = key.match(PARTITION_RE);
    if (m && dayRe.test(m[1]) && m[1] < cutoff) { await store.delete(key); deleted++; }
  }
  return { cutoff, deleted };
}

export default async () => {
  const store = getStore('site-analytics');
  const { cutoff, deleted } = await purge(store);
  console.log(`retention-purge: cutoff=${cutoff} deleted=${deleted}`);
  return new Response(JSON.stringify({ ok: true, cutoff, deleted }), { status: 200 });
};

export const config = { schedule: '17 3 * * *' }; // daily 03:17 UTC
