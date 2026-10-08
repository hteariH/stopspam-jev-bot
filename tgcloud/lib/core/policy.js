// Probabilities in, decision out. Pure: no network, no database.
//
// Tuning the bot means changing the coefficients here and re-running the
// tests against the recorded corpus - not rewriting a prompt.

// Weights on the positive terms sum to 1.0; the counterweight is subtracted.
export const W_BASE = 0.60;
export const W_SEVERITY = 0.30;
export const W_SOLICITS = 0.10;
export const W_MEMBER = 0.25;

// A message that reads this much like ordinary community chatter is never
// deleted automatically, however high the rest of the signals run.
export const MEMBER_CEILING = 0.30;

// The reason a confident deletion became a review card because the group has
// no subscription. Named because core/cards keys the subscribe button off it.
export const REASON_NOT_ENTITLED = 'not_entitled';

export const Action = Object.freeze({
  DELETE: 'delete',
  REVIEW: 'review',
  IGNORE: 'ignore',
});

export function Thresholds(del, review, confidenceFloor) {
  return Object.freeze({ delete: del, review, confidence_floor: confidenceFloor });
}

export function Decision(action, risk, reason) {
  return Object.freeze({ action, risk, reason });
}

function clamp(value, low = 0.0, high = 1.0) {
  return Math.max(low, Math.min(high, value));
}

export function riskScore(v) {
  const base = Math.max(v.is_spam, v.is_scam);
  const severity = v.severity / 2.0;
  return clamp(
    W_BASE * base
    + W_SEVERITY * severity
    + W_SOLICITS * v.solicits_contact
    - W_MEMBER * v.looks_like_member,
  );
}

export function decide(v, t, { observing, canDelete, isAdmin, isAllowlisted, entitled }) {
  if (isAdmin) return Decision(Action.IGNORE, 0.0, 'admin');
  if (isAllowlisted) return Decision(Action.IGNORE, 0.0, 'allowlisted');

  const risk = riskScore(v);

  const deletable = (
    risk >= t.delete
    && v.severity >= 1
    && v.severity_confidence >= t.confidence_floor
    && v.looks_like_member <= MEMBER_CEILING
  );
  if (deletable) {
    if (observing) return Decision(Action.REVIEW, risk, 'observing');
    if (!entitled) return Decision(Action.REVIEW, risk, REASON_NOT_ENTITLED);
    if (!canDelete) return Decision(Action.REVIEW, risk, 'no_delete_permission');
    return Decision(Action.DELETE, risk, 'high_confidence_spam');
  }

  if (risk >= t.review) return Decision(Action.REVIEW, risk, 'grey_zone');
  return Decision(Action.IGNORE, risk, 'below_threshold');
}
