// OBS-203 — GET /api/waitlist/outbox : token-gated staging view of pending confirmation
// links. Only for the staging window while no email provider is wired; requires the ADMIN
// token. Never exposed publicly in production (function disabled by env WAITLIST_STAGING=1).
import { storeList } from '../shared/store.mjs';
import { json, toResponse } from '../shared/util.mjs';
import { authScope } from '../shared/auth.mjs';

const handler = async (req, context) => {
  if (process.env.WAITLIST_STAGING !== '1') return json(null, 404, { error: 'not_found' });
  // CISO C1 convention: scoped WAITLIST_ADMIN_TOKEN_<PRODUCT> (or unscoped) tokens.
  // Each site's blob store only holds its own product's outbox, so a scoped token
  // can never read another product's confirm links.
  if (!authScope(req, 'WAITLIST_ADMIN_TOKEN')) return json(null, 401, { error: 'unauthorized' });
  return json(null, 200, { outbox: Object.values(await storeList(context, 'outbox:')) });
};

export const config = { path: '/api/waitlist/outbox' };

export default toResponse(handler);
