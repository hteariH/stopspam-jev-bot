"""Probabilities in, decision out. Pure: no aiogram, no network, no database.

Tuning the bot means changing the coefficients here and re-running the tests
against the recorded corpus - not rewriting a prompt.
"""
from dataclasses import dataclass
from enum import Enum

from core.verdict import Verdict

# Weights on the positive terms sum to 1.0; the counterweight is subtracted.
W_BASE = 0.60
W_SEVERITY = 0.30
W_SOLICITS = 0.10
W_MEMBER = 0.25

# A message that reads this much like ordinary community chatter is never
# deleted automatically, however high the rest of the signals run.
MEMBER_CEILING = 0.30

# The reason a confident deletion became a review card because the group has
# no subscription. Named because core.cards keys the subscribe button off it.
REASON_NOT_ENTITLED = "not_entitled"


class Action(str, Enum):
    DELETE = "delete"
    REVIEW = "review"
    IGNORE = "ignore"


@dataclass(frozen=True)
class Thresholds:
    delete: float
    review: float
    confidence_floor: float


@dataclass(frozen=True)
class Decision:
    action: Action
    risk: float
    reason: str


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def risk_score(v: Verdict) -> float:
    base = max(v.is_spam, v.is_scam)
    severity = v.severity / 2.0
    return _clamp(
        W_BASE * base
        + W_SEVERITY * severity
        + W_SOLICITS * v.solicits_contact
        - W_MEMBER * v.looks_like_member
    )


def decide(v: Verdict, t: Thresholds, *, observing: bool, can_delete: bool,
           is_admin: bool, is_allowlisted: bool, entitled: bool) -> Decision:
    if is_admin:
        return Decision(Action.IGNORE, 0.0, "admin")
    if is_allowlisted:
        return Decision(Action.IGNORE, 0.0, "allowlisted")

    risk = risk_score(v)

    deletable = (
        risk >= t.delete
        and v.severity >= 1
        and v.severity_confidence >= t.confidence_floor
        and v.looks_like_member <= MEMBER_CEILING
    )
    if deletable:
        if observing:
            return Decision(Action.REVIEW, risk, "observing")
        if not entitled:
            return Decision(Action.REVIEW, risk, REASON_NOT_ENTITLED)
        if not can_delete:
            return Decision(Action.REVIEW, risk, "no_delete_permission")
        return Decision(Action.DELETE, risk, "high_confidence_spam")

    if risk >= t.review:
        return Decision(Action.REVIEW, risk, "grey_zone")
    return Decision(Action.IGNORE, risk, "below_threshold")
