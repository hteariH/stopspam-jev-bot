import os
import tempfile

import pytest

from core.jev import FakeJevClient
from core.policy import Action
from core.state import MessageFacts
from tests.fixtures.verdicts import CHATTER, SCAM, UNSURE


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    monkeypatch.setenv("DB_PATH", path)
    import importlib
    import config
    importlib.reload(config)
    from storage import db
    db.reset()
    yield
    db.reset()


def facts(**overrides) -> MessageFacts:
    base = dict(text="buy crypto now", link_domains=(), link_count=0,
                has_invite_link=False, is_forward=False, media_type=None,
                is_caption=False, author_message_count=0, author_days_in_group=0.0,
                author_has_username=False, group_title="G", group_description="")
    base.update(overrides)
    return MessageFacts(**base)


def active_chat(**overrides):
    from storage import chats
    chat = chats.ensure_chat(-100, "G")
    fields = dict(mode="active", observe_until="2020-01-01T00:00:00+00:00")
    fields.update(overrides)
    return chats.update_chat(-100, **fields)


def trust_row(**overrides):
    from storage import trust
    trust.seen(-100, 555)
    return trust.get(-100, 555)


async def run(client, *, chat=None, message_facts=None, is_admin=False, can_delete=True):
    from core import pipeline
    return await pipeline.evaluate(
        client,
        chat=chat or active_chat(),
        facts=message_facts or facts(),
        trust_row=trust_row(),
        is_admin=is_admin,
        can_delete=can_delete,
    )


async def test_scam_from_newcomer_is_deleted():
    outcome = await run(FakeJevClient({"buy crypto": SCAM}))
    assert outcome.decision.action == Action.DELETE
    assert outcome.verdict == SCAM


async def test_trusted_member_never_reaches_the_api():
    from storage import trust
    trust.seen(-100, 555)
    for _ in range(5):
        trust.record_clean(-100, 555, trust_after=5)
    from core import pipeline
    client = FakeJevClient({}, default=CHATTER)
    outcome = await pipeline.evaluate(
        client, chat=active_chat(), facts=facts(text="morning all"),
        trust_row=trust.get(-100, 555), is_admin=False, can_delete=True,
    )
    assert outcome.skipped == "trusted"
    assert outcome.decision is None
    assert client.calls == [], "the gate must short-circuit before the API"


async def test_jev_disabled_for_chat_skips_the_api():
    client = FakeJevClient({}, default=SCAM)
    outcome = await run(client, chat=active_chat(jev_enabled=False))
    assert outcome.skipped == "jev_disabled"
    assert client.calls == []


async def test_outage_never_deletes():
    outcome = await run(FakeJevClient({}, fail=True))
    assert outcome.decision is None
    assert outcome.skipped == "jev_unavailable"


async def test_outage_with_trigger_still_reaches_a_human():
    outcome = await run(
        FakeJevClient({}, fail=True),
        message_facts=facts(link_count=1, link_domains=("evil.example",)),
    )
    assert outcome.skipped == "jev_unavailable_flagged"


async def test_uncertain_verdict_is_reviewed():
    outcome = await run(FakeJevClient({"buy crypto": UNSURE}))
    assert outcome.decision.action == Action.REVIEW


async def test_observation_mode_downgrades_to_review():
    outcome = await run(
        FakeJevClient({"buy crypto": SCAM}),
        chat=active_chat(observe_until="2999-01-01T00:00:00+00:00"),
    )
    assert outcome.decision.action == Action.REVIEW
    assert outcome.decision.reason == "observing"


async def test_clean_message_builds_trust():
    from storage import trust
    await run(FakeJevClient({}, default=CHATTER), message_facts=facts(text="morning all"))
    assert trust.get(-100, 555).clean_count == 1


async def test_every_evaluation_is_audited():
    from storage import audit
    await run(FakeJevClient({"buy crypto": SCAM}))
    row = audit.recent(-100)[0]
    assert row["action"] == "delete"
    assert row["model"] == "jev-test"
