// OBS-203 — confirmation email dispatch. GC/OBS-205 VERBATIM subject + body; do not
// paraphrase. No tracking pixel. No "limited spots"/"whitelist"/"guaranteed access".
// If WAITLIST_EMAIL_WEBHOOK_URL is configured (platform env secret), the message is
// POSTed there; otherwise it lands in the token-gated staging outbox. The marketing
// footer (postal address / verified-list footer) is NOT used on the confirmation email
// (transactional) per GC; nothing else may be sent until a vendor is named (GC §4).
import { storePut, storeGet } from './store.mjs';
import { nowIso } from './util.mjs';

export const PRODUCT_NAMES = {
  'unbound-science': 'Unbound Science',
  'phreaking-fun': 'Phreaking Fun',
  'mydaywas': 'MyDayWas',
  'draftcrypto': 'DraftCrypto',
};

export async function sendConfirmation(context, { to, product, confirmUrl, unsubscribeUrl }) {
  const name = PRODUCT_NAMES[product] || product;
  const msg = {
    kind: 'waitlist_confirmation',
    to,
    subject: `Confirm your ${name} waitlist request`, // GC verbatim
    // GC verbatim body. [Confirm] is the confirmUrl link.
    text: `Confirm that you want product updates for ${name} from Obsanity Labs.\n\n${confirmUrl}\n\nIf you did not request this, ignore this email. We will delete the address in 7 days. This is not an offer to sell a security, token, or investment.\n\nUnsubscribe from ${name} emails: ${unsubscribeUrl} You will stop receiving product updates. We will keep a suppression record so we do not add you again by mistake.`,
    created_at: nowIso(),
  };
  const webhook = process.env.WAITLIST_EMAIL_WEBHOOK_URL;
  if (webhook) {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (!r.ok) throw new Error(`email webhook ${r.status}`);
    return { delivered: true };
  }
  // Staging path: token-gated outbox (ADMIN token). Never public in production.
  const seq = ((await storeGet(context, 'outbox:seq')) || 0) + 1;
  await storePut(context, 'outbox:seq', seq);
  await storePut(context, `outbox:${String(seq).padStart(6, '0')}`, { ...msg, confirmUrl, unsubscribeUrl });
  return { delivered: false, outboxSeq: seq };
}