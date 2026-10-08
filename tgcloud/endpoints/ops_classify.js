// One TypeSafe call from inside the platform, with the stored key: proves
// outbound fetch, the key and the time budget all work before any group
// traffic depends on them.
//
//   npx tgcloud run endpoints/ops_classify '{text: "buy crypto now"}' --ctx '{ops: true}'
import { requireOps } from '../lib/ops.js';
import { JevError, TypeSafeJevClient } from '../lib/core/jev.js';
import { buildState, MessageFacts } from '../lib/core/state.js';

export default async function (input, ctx) {
  requireOps(ctx);
  const text = (input && input.text) || 'hello everyone';
  const state = buildState(MessageFacts({
    text, link_domains: [], link_count: 0, has_invite_link: false, is_forward: false,
    media_type: null, is_caption: false, author_message_count: 0, author_days_in_group: 0,
    author_has_username: false, group_title: 'ops check', group_description: '',
  }));
  const started = Date.now();
  try {
    const verdict = await new TypeSafeJevClient().classify(state);
    return { ok: true, ms: Date.now() - started, verdict };
  } catch (exc) {
    if (!(exc instanceof JevError)) throw exc;
    return { ok: false, ms: Date.now() - started, error: exc.message };
  }
}
