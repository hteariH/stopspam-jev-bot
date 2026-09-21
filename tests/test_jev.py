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


# --- TypeSafeJevClient ------------------------------------------------------
#
# The only module that talks to the network, and the only one the fake above
# does not cover. Nothing here makes a request: the SDK client is constructed
# (which performs no I/O) and then replaced with a stub, so these exercise
# __init__, classify's two except branches and every branch of _to_verdict.

import asyncio  # noqa: E402

from typesafe_sdk import TypeSafeError  # noqa: E402

from core.jev import TypeSafeJevClient  # noqa: E402


class StubAnswer:
    """Stands in for one SDK answer object, with only the attributes asked of
    it - so an answer missing `.noul` or `.choice` behaves like the real thing
    would when the API changes shape."""

    def __init__(self, **fields):
        self.__dict__.update(fields)


class StubResponse:
    def __init__(self, answers, **fields):
        self.answers = answers
        self.__dict__.update(fields)


def well_formed(**overrides) -> dict:
    answers = {
        "is_spam": StubAnswer(noul=0.91),
        "is_scam": StubAnswer(noul=0.77),
        "solicits_contact": StubAnswer(noul=0.64),
        "looks_like_member": StubAnswer(noul=0.12),
        "kind": StubAnswer(choice="phishing"),
        "severity": StubAnswer(score=2, confidence=0.83),
    }
    answers.update(overrides)
    return answers


def client() -> TypeSafeJevClient:
    return TypeSafeJevClient(api_key="test-key", model="jev-1", timeout=1.5)


class StubSDK:
    """Replaces the SDK client inside TypeSafeJevClient. Returns or raises."""

    def __init__(self, result=None, raises=None):
        self._result = result
        self._raises = raises
        self.calls: list = []

    async def system_one(self, state, questions, *, model=None, timeout=None):
        self.calls.append((state, model, timeout))
        if self._raises is not None:
            raise self._raises
        return self._result


def test_constructor_falls_back_to_config():
    import config
    made = TypeSafeJevClient(api_key="test-key")
    assert made._model == config.JEV_MODEL
    assert made._timeout == config.JEV_TIMEOUT


def test_constructor_prefers_explicit_arguments():
    made = client()
    assert made._model == "jev-1"
    assert made._timeout == 1.5


async def test_a_well_formed_response_maps_onto_every_verdict_field():
    """Production edit this catches: swapping any two answer keys in
    _to_verdict (is_spam for is_scam, choice for noul), or dropping the
    int() around the severity score.
    """
    made = client()
    made._client = StubSDK(result=StubResponse(well_formed(), model="jev-2026-01"))
    verdict = await made.classify("# Message\nhello")
    assert verdict.is_spam == 0.91
    assert verdict.is_scam == 0.77
    assert verdict.solicits_contact == 0.64
    assert verdict.looks_like_member == 0.12
    assert verdict.kind == "phishing"
    assert verdict.severity == 2 and isinstance(verdict.severity, int)
    assert verdict.severity_confidence == 0.83
    assert verdict.model == "jev-2026-01"


async def test_the_model_and_timeout_reach_the_sdk_call():
    """Production edit this catches: dropping the model= or timeout= keyword
    from the system_one call, which silently falls back to the SDK's own
    defaults and abandons the spec's 2 s budget.
    """
    made = client()
    stub = StubSDK(result=StubResponse(well_formed()))
    made._client = stub
    await made.classify("state")
    assert stub.calls == [("state", "jev-1", 1.5)]


async def test_a_response_with_no_model_field_is_labelled_jev():
    """Pins what getattr(response, "model", "jev") does when the field is
    absent: the audit row's model column reads "jev" rather than blowing up.

    Production edit this catches: replacing that getattr with
    response.model, which raises AttributeError - caught as a JevError, so
    the whole classification is lost over a missing label.
    """
    made = client()
    made._client = StubSDK(result=StubResponse(well_formed()))
    verdict = await made.classify("state")
    assert verdict.model == "jev"


async def test_a_missing_answer_key_raises_jev_error():
    made = client()
    answers = well_formed()
    del answers["severity"]
    made._client = StubSDK(result=StubResponse(answers))
    with pytest.raises(JevError):
        await made.classify("state")


async def test_an_answer_of_the_wrong_shape_raises_jev_error():
    """A Noul answer that carries no `.noul` - the shape an SDK or API
    change would produce."""
    made = client()
    made._client = StubSDK(
        result=StubResponse(well_formed(is_spam=StubAnswer(probability=0.9))))
    with pytest.raises(JevError):
        await made.classify("state")


async def test_a_non_numeric_score_raises_jev_error():
    made = client()
    made._client = StubSDK(
        result=StubResponse(well_formed(severity=StubAnswer(score="high", confidence=0.9))))
    with pytest.raises(JevError):
        await made.classify("state")


async def test_a_response_with_no_answers_at_all_raises_jev_error():
    class Empty:
        pass

    made = client()
    made._client = StubSDK(result=Empty())
    with pytest.raises(JevError):
        await made.classify("state")


async def test_an_sdk_error_becomes_a_jev_error():
    """Every SDK failure derives from TypeSafeError, and the pipeline only
    knows how to degrade from JevError.

    Production edit this catches: removing the `except TypeSafeError` branch
    in classify, which lets an SDK error escape the one network seam and
    reach the handler as an unhandled exception.
    """
    made = client()
    made._client = StubSDK(raises=TypeSafeError("rate limited"))
    with pytest.raises(JevError) as caught:
        await made.classify("state")
    assert "TypeSafeError" in str(caught.value)
    assert "rate limited" in str(caught.value)


async def test_a_timeout_becomes_a_jev_error_naming_the_budget():
    """Production edit this catches: removing the `except asyncio.TimeoutError`
    branch, which is not a TypeSafeError and would otherwise escape.
    """
    made = client()
    made._client = StubSDK(raises=asyncio.TimeoutError())
    with pytest.raises(JevError) as caught:
        await made.classify("state")
    assert "1.5" in str(caught.value)
