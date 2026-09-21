from core.gate import has_trigger, needs_check
from core.state import MessageFacts


def facts(**overrides) -> MessageFacts:
    base = dict(text="hello", link_domains=(), link_count=0, has_invite_link=False,
                is_forward=False, media_type=None, is_caption=False,
                author_message_count=9, author_days_in_group=100.0,
                author_has_username=True, group_title="G", group_description="")
    base.update(overrides)
    return MessageFacts(**base)


def gate(**overrides):
    base = dict(status="unknown", clean_count=0, trust_after=5,
                days_since_seen=1.0, facts=facts())
    base.update(overrides)
    return needs_check(**base)


def test_newcomer_is_checked():
    result = gate()
    assert result.check is True
    assert result.reason == "low_history"


def test_trusted_member_is_skipped():
    result = gate(status="trusted", clean_count=5)
    assert result.check is False
    assert result.reason == "trusted"


def test_allowlisted_is_never_checked():
    result = gate(status="allowlisted", clean_count=0)
    assert result.check is False
    assert result.reason == "allowlisted"


def test_flagged_is_always_checked():
    result = gate(status="flagged", clean_count=999)
    assert result.check is True
    assert result.reason == "flagged"


def test_trusted_member_posting_a_link_is_rechecked():
    result = gate(status="trusted", clean_count=50,
                  facts=facts(link_count=1, link_domains=("evil.example",)))
    assert result.check is True
    assert result.reason == "trigger"


def test_trusted_member_posting_media_with_caption_is_rechecked():
    result = gate(status="trusted", clean_count=50,
                  facts=facts(media_type="photo", is_caption=True))
    assert result.check is True


def test_trusted_member_returning_after_long_silence_is_rechecked():
    result = gate(status="trusted", clean_count=50, days_since_seen=45.0)
    assert result.check is True
    assert result.reason == "returned_after_silence"


def test_plain_text_from_trusted_member_costs_no_api_call():
    assert gate(status="trusted", clean_count=50, days_since_seen=2.0).check is False


def test_trigger_detection():
    assert has_trigger(facts(link_count=1)) is True
    assert has_trigger(facts(has_invite_link=True)) is True
    assert has_trigger(facts(is_forward=True)) is True
    assert has_trigger(facts(media_type="photo", is_caption=True)) is True
    assert has_trigger(facts(media_type="sticker", is_caption=False)) is False
    assert has_trigger(facts()) is False
