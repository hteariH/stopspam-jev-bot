from core.cards import card_keyboard, render_card
from core.policy import Action, Decision
from tests.fixtures.verdicts import SCAM


def test_card_shows_why_it_fired():
    body = render_card(
        decision=Decision(Action.REVIEW, 0.93, "grey_zone"), verdict=SCAM,
        author_name="Ann", author_id=555, text="buy crypto now",
        chat_title="Python Chat", lang="en",
    )
    assert "0.93" in body
    assert "crypto" in body
    assert "buy crypto now" in body
    assert "Ann" in body


def test_card_escapes_html_in_user_text():
    body = render_card(
        decision=Decision(Action.REVIEW, 0.60, "grey_zone"), verdict=SCAM,
        author_name="<b>Ann</b>", author_id=555, text="<script>alert(1)</script>",
        chat_title="G", lang="en",
    )
    assert "<script>" not in body
    assert "&lt;script&gt;" in body
    assert "<b>Ann</b>" not in body


def test_card_truncates_very_long_text():
    body = render_card(
        decision=Decision(Action.REVIEW, 0.60, "grey_zone"), verdict=SCAM,
        author_name="Ann", author_id=555, text="x" * 5000,
        chat_title="G", lang="en",
    )
    assert len(body) < 4096, "must fit in one Telegram message"


def test_keyboard_carries_the_review_id():
    markup = card_keyboard(42, "en")
    data = [b.callback_data for row in markup.inline_keyboard for b in row]
    assert data == ["rv:ban:42", "rv:del:42", "rv:ok:42"]


def test_unknown_language_falls_back_to_english():
    from texts import t
    assert t("card_title", lang="xx") == t("card_title", lang="en")
