import pytest

from core.jev import FakeJevClient, JevError, QUESTIONS
from tests.fixtures.verdicts import CHATTER, SCAM


def test_questions_cover_the_spec():
    assert set(QUESTIONS) == {
        "is_spam", "is_scam", "solicits_contact", "looks_like_member", "kind", "severity",
    }


def test_kind_offers_every_spec_category():
    from core.verdict import KINDS
    assert set(QUESTIONS["kind"].criteria) == set(KINDS)


def test_severity_rubric_has_three_levels():
    assert len(QUESTIONS["severity"].criteria) == 3


async def test_fake_matches_on_state_substring():
    client = FakeJevClient({"buy crypto": SCAM}, default=CHATTER)
    assert await client.classify("please buy crypto now") == SCAM
    assert await client.classify("good morning everyone") == CHATTER


async def test_fake_records_calls():
    client = FakeJevClient({}, default=CHATTER)
    await client.classify("hello")
    assert client.calls == ["hello"]


async def test_fake_can_simulate_an_outage():
    client = FakeJevClient({}, default=CHATTER, fail=True)
    with pytest.raises(JevError):
        await client.classify("hello")
