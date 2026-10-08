// Rollback only: removes the platform's webhook so the old long-polling bot
// can receive updates again. A later `tgcloud push` (or `tgcloud webhook
// sync`) sets it back.
//
//   npx tgcloud run endpoints/ops_delete_webhook '{}' --ctx '{ops: true}'
import { api } from 'sdk';

import { requireOps } from '../lib/ops.js';

export default async function (_input, ctx) {
  requireOps(ctx);
  await api.deleteWebhook({ drop_pending_updates: false });
  return { ok: true };
}
