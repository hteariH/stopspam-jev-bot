"""Decides whether a message is worth an API call at all.

Spam in Telegram comes overwhelmingly from accounts with no history, so a member
who has behaved for a while stops being checked. Trust is not permanent: the
trigger set still applies to everyone, which is the defence against a
long-standing account that has been compromised.
"""
from dataclasses import dataclass

import config
from core.state import MessageFacts


@dataclass(frozen=True)
class GateResult:
    check: bool
    reason: str


def has_trigger(facts: MessageFacts) -> bool:
    return bool(
        facts.link_count
        or facts.has_invite_link
        or facts.is_forward
        or (facts.media_type and facts.is_caption)
    )


def needs_check(*, status: str, clean_count: int, trust_after: int,
                days_since_seen: float | None, facts: MessageFacts) -> GateResult:
    if status == "allowlisted":
        return GateResult(False, "allowlisted")
    if status == "flagged":
        return GateResult(True, "flagged")
    if clean_count < trust_after or status == "unknown":
        return GateResult(True, "low_history")
    if has_trigger(facts):
        return GateResult(True, "trigger")
    if days_since_seen is not None and days_since_seen > config.RECHECK_AFTER_DAYS:
        return GateResult(True, "returned_after_silence")
    return GateResult(False, "trusted")
