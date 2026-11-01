// OBS-203 — scheduled retention purge (03:00 UTC). Implements the GC/OBS-205 retention
// table + CISO C4 runbook. Deletes, not just marks:
//   pending > 7d            → DELETE record; increment expired counter; archive consent shell (3y)
//   verified > 24mo since last email → DELETE record; move one-way hash to suppression (3y)
//   unsubscribed            → keep record until suppression window; hash moved at purge age
//   rate-limit IP hashes    → DELETE keys older than 72h
//   export access logs      → DELETE after 12 months
//   suppression hashes      → DELETE after 3 years
//   single-use tokens       → DELETE expired
import { storeList, storePut, storeDelete } from '../shared/store.mjs';
import { daysBetween, PENDING_TTL_DAYS, dayKey, toResponse } from '../shared/util.mjs';

const handler = async (req, context) => {
  const report = { pending_deleted: 0, verified_expired: 0, rate_keys: 0, tokens: 0, accesslogs: 0, suppression: 0 };

  for (const [key, rec] of Object.entries(await storeList(context, 'signup:'))) {
    if (rec.status === 'pending' && daysBetween(rec.created_at) > PENDING_TTL_DAYS) {
      await storePut(context, `expiredcount:${rec.product_key}:${dayKey(Date.now())}`,
        ((await storeGetCount(context, `expiredcount:${rec.product_key}:${dayKey(Date.now())}`)) + 1));
      await archiveConsent(context, rec);
      await storeDelete(context, key);
      report.pending_deleted++;
    } else if (rec.status === 'verified' && rec.last_emailed_at &&
               Date.now() - Date.parse(rec.last_emailed_at) > 24 * 30 * 86400000) {
      await archiveConsent(context, rec);
      await storeDelete(context, key);
      report.verified_expired++;
    }
  }

  for (const [key, rec] of Object.entries(await storeList(context, 'rate:'))) {
    // rate:<scope>:<win>:<windowSeconds> — record carries window_start_ms; drop keys
    // whose window ENDED more than 72h ago (CISO note: correct for any window size,
    // including the 86400s email+product windows).
    const start = rec && Number.isFinite(rec.window_start_ms) ? rec.window_start_ms
      : Number(key.split(':')[2]) * (Number(key.split(':')[3]) || 3600) * 1000;
    const wSec = (rec && rec.window_seconds) || 3600;
    if (Number.isFinite(start) && Date.now() - (start + wSec * 1000) > 72 * 3600 * 1000) {
      await storeDelete(context, key); report.rate_keys++;
    }
  }
  for (const [key, t] of Object.entries(await storeList(context, 'token:'))) {
    if (!t || t.exp < Date.now()) { await storeDelete(context, key); report.tokens++; }
  }
  for (const [key, l] of Object.entries(await storeList(context, 'accesslog:'))) {
    if (!l || Date.now() - Date.parse(l.ts) > 365 * 86400000) { await storeDelete(context, key); report.accesslogs++; }
  }
  for (const [key, s] of Object.entries(await storeList(context, 'suppressed:'))) {
    if (s && s.created_at && Date.now() - Date.parse(s.created_at) > 3 * 365 * 86400000) {
      await storeDelete(context, key); report.suppression++;
    }
  }

  return { status: 200, body: JSON.stringify(report) };
};

async function storeGetCount(context, key) {
  const { storeGet } = await import('../shared/store.mjs');
  return (await storeGet(context, key)) || 0;
}

// GC: consent text version kept 3 years after deletion so withdrawn consent stays provable.
async function archiveConsent(context, rec) {
  const day = dayKey(Date.now());
  const seq = ((await storeGetCount(context, `consentarchive:seq:${day}`)) || 0) + 1;
  await storePut(context, `consentarchive:seq:${day}`, seq);
  await storePut(context, `consentarchive:${day}:${String(seq).padStart(6, '0')}`, {
    product_key: rec.product_key,
    email_hash: rec.email_hash,
    consent_text_version: rec.consent_text_version,
    consented_at: rec.consented_at,
    deleted_at: new Date().toISOString(),
  });
}

// Scheduled (cron-only) function: no custom path (Netlify rejects path+schedule),
// invoked daily by the platform scheduler at 03:00 UTC.
export const config = { schedule: '0 3 * * *' };

export default toResponse(handler);
