// OBS-125 — R4 retention purge (scheduled daily): delete event + quality day-partitions older than 90 days.
// Raw events are never backed up (no secondary copy of PII-adjacent data); aggregates live in the dashboards.
'use strict';
import { getStore } from '@netlify/blobs';

const RETENTION_DAYS = 90;
const dayRe = /^\d{4}-\d{2}-\d{2}$/;

export default async () => {
  const store = getStore('site-analytics');
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const keys = await store.list();
  let deleted = 0;
  for (const { key } of keys) {
    const m = key.match(/^(events|quality)\/(\d{4}-\d{2}-\d{2})$/);
    if (m && dayRe.test(m[2]) && m[2] < cutoff) { await store.delete(key); deleted++; }
  }
  console.log(`retention-purge: cutoff=${cutoff} deleted=${deleted}`);
  return new Response(JSON.stringify({ ok: true, cutoff, deleted }), { status: 200 });
};

export const config = { schedule: '17 3 * * *' }; // daily 03:17 UTC