"""update -> gate -> state -> jev -> policy. Failure always resolves downward."""
import logging
import sqlite3
from dataclasses import dataclass

from core import gate, policy, state
from core.jev import JevClient, JevError
from core.policy import Action, Decision, Thresholds
from core.state import MessageFacts
from core.verdict import Verdict
from storage import audit, chats, trust
from storage.chats import ChatConfig
from storage.trust import TrustRow

log = logging.getLogger("stopspam.pipeline")


@dataclass(frozen=True)
class Outcome:
    decision: Decision | None
    verdict: Verdict | None
    facts: MessageFacts | None
    skipped: str | None


def _best_effort(what: str, chat_id: int, fn, *args, **kwargs) -> None:
    """Runs a storage write without letting a DB failure escape evaluate().

    evaluate()'s contract is "never raises": a moderation decision must reach
    the caller even if sqlite is locked, the disk is full, or the schema has
    drifted. Losing one row here (a flagged status, a trust bump, an audit
    line) is an acceptable trade against silently dropping the message from
    moderation entirely. The warning below is what keeps a persistent storage
    problem from going unnoticed, since the meter row itself is gone either way.
    """
    try:
        fn(*args, **kwargs)
    except sqlite3.Error as exc:
        log.warning("storage write failed (%s) for chat %s: %s", what, chat_id, exc)


async def evaluate(client: JevClient, *, chat: ChatConfig, facts: MessageFacts,
                   trust_row: TrustRow, is_admin: bool, can_delete: bool) -> Outcome:
    if is_admin:
        return Outcome(None, None, facts, "admin")

    if not chat.jev_enabled:
        return Outcome(None, None, facts, "jev_disabled")

    gated = gate.needs_check(
        status=trust_row.status,
        clean_count=trust_row.clean_count,
        trust_after=chat.trust_after,
        days_since_seen=trust.days_since_seen(trust_row),
        facts=facts,
    )
    if not gated.check:
        return Outcome(None, None, facts, gated.reason)

    try:
        verdict = await client.classify(state.build_state(facts))
    except JevError as exc:
        log.warning("jev unavailable for chat %s: %s", chat.chat_id, exc)
        reason = "jev_unavailable_flagged" if gate.has_trigger(facts) else "jev_unavailable"
        _best_effort("audit", chat.chat_id, audit.record,
                     chat.chat_id, trust_row.user_id, None, None, "failed", reason)
        return Outcome(None, None, facts, reason)

    decision = policy.decide(
        verdict,
        Thresholds(chat.delete_threshold, chat.review_threshold, chat.confidence_floor),
        observing=chats.is_observing(chat),
        can_delete=can_delete,
        is_admin=False,
        is_allowlisted=trust_row.status == trust.ALLOWLISTED,
    )

    if decision.action == Action.IGNORE:
        _best_effort("record_clean", chat.chat_id, trust.record_clean,
                     chat.chat_id, trust_row.user_id, chat.trust_after)
    else:
        _best_effort("mark_flagged", chat.chat_id, trust.mark_flagged,
                     chat.chat_id, trust_row.user_id)

    _best_effort("audit", chat.chat_id, audit.record,
                 chat.chat_id, trust_row.user_id, None, decision.risk,
                 decision.action.value, decision.reason, model=verdict.model)
    return Outcome(decision, verdict, facts, None)
