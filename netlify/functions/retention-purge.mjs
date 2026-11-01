// OBS-125 — R4 retention purge (scheduled daily): delete event + quality day-partitions older than 90 days.
// Raw events are never backed up (no secondary copy of PII-adjacent data); aggregates live in the dashboards.
// OBS-226: also purge aged moderation/audit/* day-partitions. moderation/bans is operator state,
// not an event — it is never purged here.
'use strict';
import { getStore } from '@netlify/blobs';
import { listKeys } from '../shared/aggregate.mjs';

const RETENTION_DAYS = 90;
const dayRe = /^\d{4}-\d{2}-\d{2}$/;

export async function purge(store) {
  const s = store || getStore('site-analytics');
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const keys = listKeys(await s.list());
  let deleted = 0;
  for (const key of keys) {
    const m = /^(events|quality|moderation\/audit)\/(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (m && dayRe.test(m[2]) && m[2] < cutoff) {
      await s.delete(key);
      deleted++;
    }
  }
  return { ok: true, cutoff, deleted };
}

export const config = { schedule: '17 3 * * *' }; // daily 03:17 UTC

export default async () => {
  const { cutoff, deleted } = await purge();
  console.log(`retention-purge: cutoff=${cutoff} deleted=${deleted}`);
  return new Response(JSON.stringify({ ok: true, cutoff, deleted }), { status: 200 });
};