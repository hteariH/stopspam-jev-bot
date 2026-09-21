"""The only module that talks to the TypeSafe API.

Every question is atomic on purpose: TypeSafe evaluates them in parallel against
the same state, so asking six narrow questions costs about as much as one broad
one and gives the policy something to combine in code.
"""
import asyncio
from typing import Protocol

from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, Score, TypeSafeError

import config
from core.verdict import Verdict

SEVERITY_RUBRIC = [
    "Harmless self-promotion or an on-topic mention of the author's own work",
    "Clear unsolicited spam: advertising or mass-posted content nobody asked for",
    "Active fraud: an attempt to take money, credentials or accounts from the reader",
]

QUESTIONS = {
    "is_spam": Noul(
        instructions="The message is unsolicited promotion, advertising, "
                     "or mass-posted content.",
    ),
    "is_scam": Noul(
        instructions="The message attempts to defraud the reader: fake earnings, "
                     "crypto giveaways, phishing, impersonated support, or requests "
                     "for credentials or a seed phrase.",
    ),
    "solicits_contact": Noul(
        instructions="The message pushes the reader to move to a private message "
                     "or an external channel.",
    ),
    "looks_like_member": Noul(
        instructions="This reads as an ordinary message from a member of this "
                     "community, given the group's topic.",
    ),
    "kind": Choice(
        instructions="Which category best describes this message",
        criteria={
            "crypto": "Crypto investment, trading signals, giveaways or wallet drainers",
            "job_mule": "Fake job or easy-money offer, often money-mule recruitment",
            "phishing": "Credential theft, fake login or fake support",
            "porn": "Adult content or dating spam",
            "channel_promo": "Promoting another channel, group or bot",
            "impersonation": "Pretending to be an admin, support or a known brand",
            "none": "Not spam of any kind",
        },
    ),
    "severity": Score(
        instructions="How harmful this message is to the group",
        criteria=SEVERITY_RUBRIC,
    ),
}


class JevError(RuntimeError):
    """Any failure reaching or parsing a Jev answer."""


class JevClient(Protocol):
    async def classify(self, state: str) -> Verdict: ...


class TypeSafeJevClient:
    """Real client, over the SDK's native async interface.

    Verified against the installed typesafe-sdk: AsyncTypeSafeClient takes
    api_key/model/timeout as keyword arguments, system_one takes state and
    questions positionally with model and timeout keyword-only, and every SDK
    failure derives from TypeSafeError.
    """

    def __init__(self, api_key: str | None = None, model: str | None = None,
                 timeout: float | None = None) -> None:
        self._model = model or config.JEV_MODEL
        self._timeout = timeout or config.JEV_TIMEOUT
        self._client = AsyncTypeSafeClient(
            api_key=api_key or config.TYPESAFE_API_KEY,
            model=self._model,
            timeout=self._timeout,
        )

    async def classify(self, state: str) -> Verdict:
        try:
            response = await self._client.system_one(
                state, QUESTIONS, model=self._model, timeout=self._timeout,
            )
        except TypeSafeError as exc:
            raise JevError(f"{type(exc).__name__}: {exc}") from exc
        except asyncio.TimeoutError as exc:
            raise JevError(f"jev timed out after {self._timeout}s") from exc
        return self._to_verdict(response)

    @staticmethod
    def _to_verdict(response) -> Verdict:
        try:
            answers = response.answers
            severity = answers["severity"]
            return Verdict(
                is_spam=answers["is_spam"].noul,
                is_scam=answers["is_scam"].noul,
                solicits_contact=answers["solicits_contact"].noul,
                looks_like_member=answers["looks_like_member"].noul,
                kind=answers["kind"].choice,
                severity=int(severity.score),
                severity_confidence=severity.confidence,
                model=getattr(response, "model", "jev"),
            )
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            raise JevError(f"unexpected Jev response shape: {exc}") from exc


class FakeJevClient:
    """Test double. Matches a substring of the state to a canned verdict."""

    def __init__(self, verdicts: dict[str, Verdict], default: Verdict | None = None,
                 fail: bool = False) -> None:
        self._verdicts = verdicts
        self._default = default
        self._fail = fail
        self.calls: list[str] = []

    async def classify(self, state: str) -> Verdict:
        self.calls.append(state)
        if self._fail:
            raise JevError("simulated outage")
        for needle, verdict in self._verdicts.items():
            if needle.lower() in state.lower():
                return verdict
        if self._default is None:
            raise JevError(f"no canned verdict matches: {state[:60]!r}")
        return self._default
