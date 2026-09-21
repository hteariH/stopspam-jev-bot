from datetime import datetime, timezone

from aiogram.types import Chat, Message, User

from core.state import MAX_TEXT, MessageFacts, build_state, facts_from_message

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def facts(**overrides) -> MessageFacts:
    base = dict(text="hello", link_domains=(), link_count=0, has_invite_link=False,
                is_forward=False, media_type=None, is_caption=False,
                author_message_count=3, author_days_in_group=10.0,
                author_has_username=True, group_title="Python Chat",
                group_description="Talk about Python")
    base.update(overrides)
    return MessageFacts(**base)


def test_state_contains_message_and_context():
    state = build_state(facts(text="buy cheap followers"))
    assert "buy cheap followers" in state
    assert "Python Chat" in state
    assert "Talk about Python" in state


def test_state_reports_author_history():
    state = build_state(facts(author_message_count=0, author_days_in_group=0.001))
    assert "0" in state
    assert "messages" in state.lower()


def test_long_text_is_truncated():
    state = build_state(facts(text="x" * (MAX_TEXT + 500)))
    assert "x" * MAX_TEXT in state
    assert "x" * (MAX_TEXT + 1) not in state


def test_state_is_deterministic():
    assert build_state(facts()) == build_state(facts())


def test_facts_extract_links_and_invite():
    message = Message(
        message_id=1, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Ann", username="ann"),
        text="see https://evil.example/win and t.me/joinchat/AAA",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description="Talk about Python",
    )
    assert "evil.example" in extracted.link_domains
    assert extracted.link_count == 2
    assert extracted.has_invite_link is True
    assert extracted.author_has_username is True


def test_facts_handle_caption_only_media():
    message = Message(
        message_id=2, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Ann"),
        caption="earn 500 a day", photo=[],
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=None, group_description="",
    )
    assert extracted.text == "earn 500 a day"
    assert extracted.is_caption is True
    assert extracted.author_has_username is False


def test_facts_handle_malformed_ipv6_url():
    """Malformed IPv6 address (unbalanced bracket) should not crash extraction."""
    message = Message(
        message_id=3, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Eve"),
        text="click http://[::1/free-money now",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description="Talk about Python",
    )
    # Should return normally without raising ValueError
    assert extracted.text == "click http://[::1/free-money now"
    # URL was matched by regex, so link_count is 1
    assert extracted.link_count == 1
    # Domain parsing failed, so link_domains is empty
    assert extracted.link_domains == ()


def test_facts_handle_multiple_malformed_urls():
    """Multiple URLs, some valid and some malformed, should extract valid domains only."""
    message = Message(
        message_id=4, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Frank"),
        text="visit https://good.example.com and http://[::1/bad and www.another-good.net",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description="",
    )
    # Three URLs matched
    assert extracted.link_count == 3
    # Two valid domains extracted
    assert "good.example.com" in extracted.link_domains
    assert "another-good.net" in extracted.link_domains
    # Malformed URL's domain is skipped
    assert len(extracted.link_domains) == 2


def test_facts_handle_unclosed_ipv6_bracket():
    """Unclosed IPv6 bracket should not crash extraction.

    This tests a different bracket pattern: http://[invalid/path
    which raises ValueError in urlparse() due to unclosed IPv6 literal.
    Without the try/except in _domain(), extraction would crash.
    """
    message = Message(
        message_id=5, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Grace"),
        text="click http://[invalid/path here",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description="",
    )
    # URL matched by regex but urlparse raises on unclosed [
    assert extracted.link_count == 1
    # Domain parsing failed, filtered out
    assert extracted.link_domains == ()


def test_facts_handle_empty_ipv6_bracket():
    """Empty IPv6 literal bracket should not crash extraction.

    URL: http://[]empty
    The [] is an empty/degenerate IPv6 literal that raises ValueError on parse.
    This tests the try/except in _domain() against a different bracket pattern.
    """
    message = Message(
        message_id=6, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Henry"),
        text="visit http://[]empty/notvalid",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description="",
    )
    # URL matched by regex but urlparse raises on empty IPv6 literal []
    assert extracted.link_count == 1
    # Domain parsing failed, filtered out
    assert extracted.link_domains == ()


def test_facts_cap_group_title_at_128_chars():
    """Group title should be capped defensively at 128 characters."""
    long_title = "A" * 200
    message = Message(
        message_id=7, date=NOW, chat=Chat(id=-100, type="supergroup", title=long_title),
        from_user=User(id=5, is_bot=False, first_name="Ivan"),
        text="hi",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description="",
    )
    assert len(extracted.group_title) == 128
    assert extracted.group_title == "A" * 128


def test_facts_cap_group_description_at_255_chars():
    """Group description should be capped defensively at 255 characters."""
    long_description = "B" * 300
    message = Message(
        message_id=8, date=NOW, chat=Chat(id=-100, type="supergroup", title="Group"),
        from_user=User(id=5, is_bot=False, first_name="Jack"),
        text="hi",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description=long_description,
    )
    assert len(extracted.group_description) == 255
    assert extracted.group_description == "B" * 255
