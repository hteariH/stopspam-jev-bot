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
