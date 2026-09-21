"""All user-visible strings. English is the default and the fallback."""

STRINGS: dict[str, dict[str, str]] = {
    "card_title": {"en": "Possible spam", "ru": "Похоже на спам"},
    "card_author": {"en": "Author", "ru": "Автор"},
    "card_chat": {"en": "Chat", "ru": "Чат"},
    "card_risk": {"en": "Risk", "ru": "Риск"},
    "card_kind": {"en": "Kind", "ru": "Тип"},
    "card_breakdown": {"en": "Breakdown", "ru": "Разбор"},
    "card_deleted": {"en": "Deleted automatically", "ru": "Удалено автоматически"},
    "btn_ban": {"en": "Delete & ban", "ru": "Удалить и забанить"},
    "btn_delete": {"en": "Delete", "ru": "Удалить"},
    "btn_not_spam": {"en": "Not spam", "ru": "Не спам"},
    "done_ban": {"en": "Deleted and banned.", "ru": "Удалено, автор забанен."},
    "done_delete": {"en": "Deleted.", "ru": "Удалено."},
    "done_not_spam": {
        "en": "Marked as not spam. This user is now allowlisted here.",
        "ru": "Отмечено как не спам. Автор добавлен в белый список этого чата.",
    },
    "already_handled": {"en": "Already handled.", "ru": "Уже обработано."},
    "not_admin": {
        "en": "Only admins of that chat can use these buttons.",
        "ru": "Эти кнопки доступны только админам чата.",
    },
}


def t(key: str, lang: str = "en", **kwargs) -> str:
    template = STRINGS.get(key, {}).get(lang) or STRINGS.get(key, {}).get("en", key)
    return template.format(**kwargs) if kwargs else template
