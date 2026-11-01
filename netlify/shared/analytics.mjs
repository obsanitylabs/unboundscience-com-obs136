// OBS-203 — analytics event recorder. First-party only; events go to our own store.
// Event types: waitlist_view, waitlist_submit, waitlist_verified, referral_share.
import { storePut, storeGet } from './store.mjs';
import { dayKey } from './util.mjs';

const EVENT_TYPES = ['waitlist_view', 'waitlist_submit', 'waitlist_verified', 'referral_share'];

export async function recordEvent(context, { type, product, utm = {}, extra = {} }) {
  if (!EVENT_TYPES.includes(type)) throw new Error('bad event type');
  const day = dayKey(Date.now());
  const seq = ((await storeGet(context, `eventseq:${day}`)) || 0) + 1;
  await storePut(context, `eventseq:${day}`, seq);
  await storePut(context, `event:${day}:${String(seq).padStart(6, '0')}`, {
    type,
    product,
    utm,
    extra,
    ts: Date.now(),
  });
  return { type, product, day, seq };
}

export { EVENT_TYPES };