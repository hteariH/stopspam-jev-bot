// Decides whether a message is worth an API call at all.
//
// Spam in Telegram comes overwhelmingly from accounts with no history, so a
// member who has behaved for a while stops being checked. Trust is not
// permanent: the trigger set still applies to everyone, which is the defence
// against a long-standing account that has been compromised.
import * as config from '../config.js';

export function GateResult(check, reason) {
  return Object.freeze({ check, reason });
}

export function hasTrigger(facts) {
  return Boolean(
    facts.link_count
    || facts.has_invite_link
    || facts.is_forward
    || (facts.media_type && facts.is_caption),
  );
}

export function needsCheck({ status, cleanCount, trustAfter, daysSinceSeen, facts }) {
  if (status === 'allowlisted') return GateResult(false, 'allowlisted');
  if (status === 'flagged') return GateResult(true, 'flagged');
  if (cleanCount < trustAfter || status === 'unknown') return GateResult(true, 'low_history');
  if (hasTrigger(facts)) return GateResult(true, 'trigger');
  if (daysSinceSeen !== null && daysSinceSeen !== undefined
      && daysSinceSeen > config.RECHECK_AFTER_DAYS) {
    return GateResult(true, 'returned_after_silence');
  }
  return GateResult(false, 'trusted');
}
