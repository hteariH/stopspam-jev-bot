import pytest

from core.policy import Action, Decision, MEMBER_CEILING, Thresholds, decide, risk_score
from core.verdict import Verdict

DEFAULTS = Thresholds(delete=0.90, review=0.55, confidence_floor=0.75)


def verdict(**overrides) -> Verdict:
    base = dict(is_spam=0.0, is_scam=0.0, solicits_contact=0.0, looks_like_member=1.0,
                kind="none", severity=0, severity_confidence=1.0, model="jev-test")
    base.update(overrides)
    return Verdict(**base)


SCAM = dict(is_spam=0.98, is_scam=0.99, solicits_contact=1.0,
            looks_like_member=0.02, kind="crypto", severity=2, severity_confidence=0.95)


def ctx(**overrides):
    base = dict(observing=False, can_delete=True, is_admin=False,
                is_allowlisted=False, entitled=True)
    base.update(overrides)
    return base


# --- risk score ---

def test_risk_is_zero_for_ordinary_chatter():
    assert risk_score(verdict()) == pytest.approx(0.0)


def test_risk_is_high_for_blatant_scam():
    assert risk_score(verdict(**SCAM)) > 0.90


def test_looks_like_member_pulls_risk_down():
    loud = verdict(is_spam=0.9, severity=1, looks_like_member=0.0)
    friendly = verdict(is_spam=0.9, severity=1, looks_like_member=1.0)
    assert risk_score(friendly) < risk_score(loud)


def test_risk_is_clamped_to_unit_interval():
    assert 0.0 <= risk_score(verdict(**SCAM)) <= 1.0
    assert risk_score(verdict(looks_like_member=1.0)) >= 0.0


# --- bands ---

def test_blatant_scam_is_deleted():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx())
    assert d.action == Action.DELETE
    assert d.reason == "high_confidence_spam"


def test_grey_zone_goes_to_review():
    # risk = 0.60*0.90 + 0.30*0.5 + 0.10*0.50 - 0.25*0.20 = 0.69
    # over the 0.55 review bar, under the 0.90 delete bar.
    grey = verdict(is_spam=0.90, severity=1, severity_confidence=0.60,
                   solicits_contact=0.50, looks_like_member=0.20)
    d = decide(grey, DEFAULTS, **ctx())
    assert 0.55 <= d.risk < 0.90
    assert d.action == Action.REVIEW
    assert d.reason == "grey_zone"


def test_low_risk_is_ignored():
    d = decide(verdict(is_spam=0.2), DEFAULTS, **ctx())
    assert d.action == Action.IGNORE
    assert d.reason == "below_threshold"


# --- the property the whole model choice rests on ---

def test_high_risk_but_low_confidence_is_reviewed_not_deleted():
    unsure = verdict(**{**SCAM, "severity_confidence": 0.40})
    d = decide(unsure, DEFAULTS, **ctx())
    assert d.action == Action.REVIEW, "uncertainty must never delete"
    assert d.risk >= DEFAULTS.delete


def test_severity_zero_never_deletes_however_high_the_risk():
    harmless = verdict(is_spam=1.0, is_scam=1.0, solicits_contact=1.0,
                       looks_like_member=0.0, severity=0, severity_confidence=1.0)
    assert decide(harmless, DEFAULTS, **ctx()).action != Action.DELETE


def test_member_ceiling_blocks_deletion():
    borderline = verdict(**{**SCAM, "looks_like_member": MEMBER_CEILING + 0.01})
    assert decide(borderline, DEFAULTS, **ctx()).action != Action.DELETE


# --- guards ---

def test_admins_are_never_touched():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(is_admin=True))
    assert d.action == Action.IGNORE
    assert d.reason == "admin"


def test_allowlisted_users_are_never_touched():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(is_allowlisted=True))
    assert d.action == Action.IGNORE
    assert d.reason == "allowlisted"


def test_observation_mode_downgrades_delete_to_review():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(observing=True))
    assert d.action == Action.REVIEW
    assert d.reason == "observing"


def test_missing_delete_permission_downgrades_to_review():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(can_delete=False))
    assert d.action == Action.REVIEW
    assert d.reason == "no_delete_permission"


def test_thresholds_are_configurable():
    strict = Thresholds(delete=0.99, review=0.95, confidence_floor=0.99)
    d = decide(verdict(**SCAM), strict, **ctx())
    assert d.action == Action.REVIEW


def test_unentitled_chat_reviews_what_it_would_have_deleted():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=False))
    assert d.action == Action.REVIEW
    assert d.reason == "not_entitled"


def test_entitled_chat_still_deletes():
    assert decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=True)).action == Action.DELETE


def test_observing_is_reported_ahead_of_not_entitled():
    """Inside the observation window nothing is deleted on any tier, so
    advertising a subscription there would be selling something the admin does
    not yet need."""
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(observing=True, entitled=False))
    assert d.reason == "observing"


def test_not_entitled_is_reported_ahead_of_missing_delete_rights():
    """Telling an admin to buy a subscription when the real problem is that
    they never gave the bot delete rights would be a lie - but so would the
    reverse, and the subscription is the one the bot can actually fix."""
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=False, can_delete=False))
    assert d.reason == "not_entitled"


def test_entitlement_never_promotes_a_grey_zone_message():
    """Payment buys enforcement of a verdict, never a harsher verdict."""
    # is_spam=0.7 (the brief's literal value) computes to risk=0.545, just
    # under the 0.55 review threshold, which lands in below_threshold/IGNORE
    # rather than grey_zone regardless of the implementation under test.
    # Nudged to 0.72 (risk=0.557) so the fixture actually sits in the grey
    # band; severity_confidence=0.5 still keeps it non-deletable either way.
    grey = verdict(is_spam=0.72, severity=1, severity_confidence=0.5, looks_like_member=0.1)
    paid = decide(grey, DEFAULTS, **ctx(entitled=True))
    unpaid = decide(grey, DEFAULTS, **ctx(entitled=False))
    assert paid.action == unpaid.action == Action.REVIEW
    assert paid.reason == unpaid.reason == "grey_zone"


def test_entitlement_does_not_change_the_risk_score():
    paid = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=True))
    unpaid = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=False))
    assert paid.risk == unpaid.risk
