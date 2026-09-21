from texts import t
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


def test_card_in_russian():
    body = render_card(
        decision=Decision(Action.REVIEW, 0.93, "grey_zone"), verdict=SCAM,
        author_name="Анна", author_id=555, text="купи крипто",
        chat_title="Python Чат", lang="ru",
    )
    assert "Похоже на спам" in body
    assert "Автор" in body
    assert "Чат" in body
    assert "Риск" in body
    assert "Тип" in body
    assert "Разбор" in body

    # Also test keyboard buttons in Russian
    markup = card_keyboard(42, "ru")
    button_texts = [b.text for row in markup.inline_keyboard for b in row]
    assert "Удалить и забанить" in button_texts
    assert "Удалить" in button_texts
    assert "Не спам" in button_texts


def test_card_worst_case_length():
    """All three truncation branches fire: each field one character over cap.
    With MAX_TITLE=128, MAX_NAME=128, MAX_QUOTE=500, inputs of 129/129/501
    trigger truncation. Each truncation appends "…", verified by count.
    Worst case should stay under 4096 (Telegram limit) with real margin."""
    body = render_card(
        decision=Decision(Action.REVIEW, 0.99, "no_delete_permission"),
        verdict=SCAM,
        author_name="<" * 129,  # One over MAX_NAME
        author_id=9999999999,
        text="<" * 501,  # One over MAX_QUOTE
        chat_title="<" * 129,  # One over MAX_TITLE
        lang="en",
    )
    assert len(body) < 4096, f"Card length {len(body)} exceeds Telegram limit"
    # All three truncation branches fire, each appending "…"
    assert body.count("…") == 3, f"Expected 3 ellipsis marks from truncations, got {body.count('…')}"


# --- localisation coverage -------------------------------------------------

def test_every_string_exists_in_every_language():
    """A new key that lands without a translation is a silent English fallback."""
    from handlers.admin import _LANGS
    from texts import STRINGS

    missing = {
        key: [lang for lang in _LANGS if lang not in langs]
        for key, langs in STRINGS.items()
        if any(lang not in langs for lang in _LANGS)
    }
    assert missing == {}, f"untranslated: {missing}"


def test_no_translation_is_an_untouched_copy_of_the_english():
    """Catches a placeholder pasted in instead of a real translation."""
    from texts import STRINGS

    copied = [
        key for key, langs in STRINGS.items()
        if langs.get("uk") == langs["en"] or langs.get("ru") == langs["en"]
    ]
    assert copied == [], f"left in English: {copied}"


def test_language_cycle_returns_to_english():
    from handlers.admin import _LANGS

    assert _LANGS[0] == "en"
    assert set(_LANGS) == {"en", "ru", "uk"}
    seen = [_LANGS[(_LANGS.index("en") + step) % len(_LANGS)] for step in range(4)]
    assert seen == ["en", "ru", "uk", "en"]


def test_ukrainian_card_renders_with_ukrainian_labels():
    from core.policy import Action, Decision
    from tests.fixtures.verdicts import SCAM

    body = render_card(
        decision=Decision(Action.REVIEW, 0.80, "grey_zone"), verdict=SCAM,
        author_name="Ann", author_id=555, text="buy crypto now",
        chat_title="G", lang="uk",
    )
    for key in ("card_title", "card_author", "card_risk", "card_breakdown"):
        assert t(key, "uk") in body

    labels = [b.text for row in card_keyboard(1, "uk").inline_keyboard for b in row]
    assert labels == [t("btn_ban", "uk"), t("btn_delete", "uk"), t("btn_not_spam", "uk")]
