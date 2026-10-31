// OBS-125 — R4 retention purge (scheduled daily): delete event + quality day-partitions older than 90 days.
// Raw events are never backed up (no secondary copy of PII-adjacent data); aggregates live in the dashboards.
  console.log(`retention-purge: cutoff=${cutoff} deleted=${deleted}`);
  return new Response(JSON.stringify({ ok: true, cutoff, deleted }), { status: 200 });
};

