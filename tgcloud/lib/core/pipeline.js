// update -> gate -> state -> jev -> policy. Failure always resolves downward.
import * as gate from './gate.js';
import * as guards from './guards.js';
import * as policy from './policy.js';
import * as state from './state.js';
import { JevError } from './jev.js';
import * as audit from '../storage/audit.js';
import * as chats from '../storage/chats.js';
import * as trust from '../storage/trust.js';
import { logger } from '../log.js';

const log = logger('stopspam.pipeline');

// The skip reason core/actions turns into an outage notice. A message the
// classifier never saw that carried a link, an invite, a forward or a media
// caption is the one case the spec does not let pass in silence.
export const UNAVAILABLE_WITH_TRIGGER = 'jev_unavailable_flagged';
export const UNAVAILABLE = 'jev_unavailable';

export function Outcome(decision, verdict, facts, skipped, entitlement = null) {
  return Object.freeze({ decision, verdict, facts, skipped, entitlement });
}

// evaluate()'s contract is "never raises": a moderation decision must reach
// the caller even if the database fails. Nothing here reads the result back -
// the write is attempted, and a failure is logged rather than raised.
const bestEffort = (...args) => guards.bestEffort(log, ...args);

export async function evaluate(client, { chat, facts, trustRow, isAdmin, canDelete, entitlement }) {
  if (isAdmin) return Outcome(null, null, facts, 'admin');

  if (!chat.jev_enabled) return Outcome(null, null, facts, 'jev_disabled');

  const gated = gate.needsCheck({
    status: trustRow.status,
    cleanCount: trustRow.clean_count,
    trustAfter: chat.trust_after,
    daysSinceSeen: trust.daysSinceSeen(trustRow),
    facts,
  });
  if (!gated.check) return Outcome(null, null, facts, gated.reason);

  const started = Date.now();
  let verdict;
  try {
    verdict = await client.classify(state.buildState(facts));
  } catch (exc) {
    if (!(exc instanceof JevError)) throw exc;
    log.warning('jev unavailable for chat %s: %s', chat.chat_id, exc);
    const reason = gate.hasTrigger(facts) ? UNAVAILABLE_WITH_TRIGGER : UNAVAILABLE;
    await bestEffort('audit', chat.chat_id, audit.record,
      chat.chat_id, trustRow.user_id, null, null, 'failed', reason);
    return Outcome(null, null, facts, reason);
  }

  // One line per billable call, naming the chat that caused it. This is the
  // only record of successful spend outside the audit table, and it is what
  // makes "which chats are costing me money, and are any of them paying?"
  // answerable with a log search.
  log.info('jev call for chat %s (user %s, %s, tier=%s, entitled=%s) took %d ms',
    chat.chat_id, trustRow.user_id, gated.reason, entitlement.tier,
    entitlement.active ? 'yes' : 'no', Date.now() - started);

  const decision = policy.decide(
    verdict,
    policy.Thresholds(chat.delete_threshold, chat.review_threshold, chat.confidence_floor),
    {
      observing: chats.isObserving(chat),
      canDelete,
      isAdmin: false,
      isAllowlisted: trustRow.status === trust.ALLOWLISTED,
      entitled: entitlement.active,
    },
  );

  if (decision.reason === policy.REASON_NOT_ENTITLED) {
    log.info('enforcement withheld in chat %s: tier %s has no subscription (risk %.2f)',
      chat.chat_id, entitlement.tier, decision.risk);
  }

  if (decision.action === policy.Action.IGNORE) {
    await bestEffort('record_clean', chat.chat_id, trust.recordClean,
      chat.chat_id, trustRow.user_id, chat.trust_after);
  } else {
    await bestEffort('mark_flagged', chat.chat_id, trust.markFlagged, chat.chat_id, trustRow.user_id);
  }

  await bestEffort('audit', chat.chat_id, audit.record,
    chat.chat_id, trustRow.user_id, null, decision.risk, decision.action, decision.reason, verdict.model);
  return Outcome(decision, verdict, facts, null, entitlement);
}
