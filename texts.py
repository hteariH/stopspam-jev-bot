"""All user-visible strings. English is the default and the fallback."""

STRINGS: dict[str, dict[str, str]] = {
    "card_title": {"en": "Possible spam", "ru": "Похоже на спам"},
    "card_author": {"en": "Author", "ru": "Автор"},
    "card_chat": {"en": "Chat", "ru": "Чат"},
    "card_risk": {"en": "Risk", "ru": "Риск"},
    "card_kind": {"en": "Kind", "ru": "Тип"},
    "card_breakdown": {"en": "Breakdown", "ru": "Разбор"},
    "card_deleted": {"en": "Deleted automatically", "ru": "Удалено автоматически"},
    "outage_title": {"en": "Not checked", "ru": "Сообщение не проверено"},
    "outage_body": {
        "en": "The classifier was unavailable, so this message was never checked. "
              "It carried a link, a forward or a media caption, which is why you "
              "are being told about it. Nothing was deleted — please take a look.",
        "ru": "Классификатор был недоступен, поэтому это сообщение не проверялось. "
              "В нём есть ссылка, пересылка или подпись к медиа — поэтому я о нём "
              "сообщаю. Ничего не удалено, посмотрите, пожалуйста, сами.",
    },
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
    "welcome": {
        "en": "I remove spam and scam messages from Telegram groups.\n\n"
              "Add me to your group, give me permission to delete messages and ban "
              "users, then send /chats here to configure me.\n\n"
              "For the first 7 days I only report what I would have removed, so you "
              "can judge my accuracy before enabling enforcement.",
        "ru": "Я удаляю спам и мошеннические сообщения из групп в Telegram.\n\n"
              "Добавьте меня в свою группу, дайте право удалять сообщения и "
              "банить пользователей, затем отправьте мне /chats здесь, чтобы "
              "настроить меня.\n\n"
              "Первые 7 дней я только сообщаю о том, что удалил бы, чтобы вы "
              "могли оценить точность до включения принудительных действий.",
    },
    "help": {
        "en": "I remove spam and scam messages from Telegram groups.\n\n"
              "Add me to your group, give me permission to delete messages and ban "
              "users, then send /chats here to configure me.\n\n"
              "For the first 7 days I only report what I would have removed, so you "
              "can judge my accuracy before enabling enforcement.",
        "ru": "Я удаляю спам и мошеннические сообщения из групп в Telegram.\n\n"
              "Добавьте меня в свою группу, дайте право удалять сообщения и "
              "банить пользователей, затем отправьте мне /chats здесь, чтобы "
              "настроить меня.\n\n"
              "Первые 7 дней я только сообщаю о том, что удалил бы, чтобы вы "
              "могли оценить точность до включения принудительных действий.",
    },
    "privacy": {
        "en": "<b>Privacy</b>\n\n"
              "To classify a message I send its text and some metadata (link domains, "
              "whether it was forwarded, how long the author has been in the group) to "
              "the TypeSafe Jev API, which is operated in the United States.\n\n"
              "<b>What I send:</b>\n"
              "• every message from a member who has not yet posted 5 clean messages "
              "in this group (an admin can change that number);\n"
              "• every message from a member who has been flagged here before — that "
              "does not stop;\n"
              "• any message containing a link, a Telegram invite link, a forward, or "
              "a caption on media, from anyone, however long they have been here;\n"
              "• the next message from a trusted member who has been silent for more "
              "than 30 days.\n\n"
              "<b>What I never send:</b> messages from the group's admins and owners, "
              "messages from anyone an admin has marked as not spam, and messages "
              "with neither text nor a caption (joins, pins, photos with no "
              "caption).\n\n"
              "Message text is stored for at most 7 days in the review queue and is "
              "then erased. The audit log never stores message text.\n\n"
              "Any admin can switch classification off for a chat with /chats.",
        "ru": "<b>Конфиденциальность</b>\n\n"
              "Чтобы классифицировать сообщение, я отправляю его текст и часть "
              "метаданных (домены ссылок, было ли оно переслано, как давно автор "
              "состоит в группе) в API TypeSafe Jev, который работает в США.\n\n"
              "<b>Что я отправляю:</b>\n"
              "• каждое сообщение участника, который ещё не написал 5 чистых "
              "сообщений в этой группе (админ может изменить это число);\n"
              "• каждое сообщение участника, которого здесь уже отмечали как "
              "нарушителя, — и это не прекращается;\n"
              "• любое сообщение со ссылкой, пригласительной ссылкой Telegram, "
              "пересылкой или подписью к медиа — от кого угодно, как бы давно "
              "он ни состоял в группе;\n"
              "• следующее сообщение участника с доверием, который молчал больше "
              "30 дней.\n\n"
              "<b>Что я не отправляю никогда:</b> сообщения админов и владельцев "
              "группы, сообщения тех, кого админ отметил как «не спам», и "
              "сообщения без текста и без подписи (входы в группу, закрепления, "
              "фото без подписи).\n\n"
              "Текст сообщения хранится в очереди на проверку не более 7 дней, "
              "после чего удаляется. Журнал аудита никогда не хранит текст "
              "сообщений.\n\n"
              "Любой админ может отключить классификацию для чата через /chats.",
    },
    "too_many_requests": {
        "en": "Too many requests. Please try again in a minute.",
        "ru": "Слишком много запросов. Попробуйте ещё раз через минуту.",
    },
    "no_chats": {
        "en": "I am not in any group you administer yet. Add me to a group first.",
        "ru": "Я пока не состою ни в одной группе, где вы админ. Сначала добавьте "
              "меня в группу.",
    },
    "menu_title": {
        "en": "Settings for {title}",
        "ru": "Настройки для {title}",
    },
    "menu_mode": {
        "en": "Mode",
        "ru": "Режим",
    },
    "menu_jev": {
        "en": "Classification",
        "ru": "Классификация",
    },
    "menu_lang": {
        "en": "Language",
        "ru": "Язык",
    },
    "menu_thresholds": {
        "en": "Thresholds",
        "ru": "Пороги",
    },
    "menu_delete_threshold": {
        "en": "delete",
        "ru": "удаление",
    },
    "menu_review_threshold": {
        "en": "review",
        "ru": "проверка",
    },
    "menu_log_chat": {
        "en": "Review cards go to",
        "ru": "Карточки проверки приходят",
    },
    "log_chat_unset": {
        "en": "nowhere — no destination is set, so cards are not delivered",
        "ru": "никуда — адресат не задан, карточки не отправляются",
    },
    "log_chat_dm": {
        "en": "a private chat with admin {user_id}",
        "ru": "в личный чат с админом {user_id}",
    },
    "log_chat_group": {
        "en": "chat {chat_id}",
        "ru": "в чат {chat_id}",
    },
    "btn_log_here": {
        "en": "send cards to me",
        "ru": "присылать карточки мне",
    },
    "setlog_not_admin": {
        "en": "Only an admin of this chat can use /setlog.",
        "ru": "Команду /setlog может использовать только админ этого чата.",
    },
    "setlog_done": {
        "en": "Done. Review cards now come here. Groups redirected: {count}.",
        "ru": "Готово. Карточки проверки теперь приходят сюда. "
              "Перенаправлено групп: {count}.",
    },
    "setlog_none": {
        "en": "I found no group of yours to redirect here. Post a message in that "
              "group first so I know you are in it, then run /setlog here again.",
        "ru": "Не нашёл ваших групп, которые можно сюда перенаправить. Сначала "
              "напишите сообщение в нужной группе, чтобы я знал, что вы в ней, "
              "затем снова выполните /setlog здесь.",
    },
    "menu_not_admin": {
        "en": "You are not an admin of that chat.",
        "ru": "Вы не админ этого чата.",
    },
    "btn_mode_observe": {
        "en": "mode: observe",
        "ru": "режим: наблюдение",
    },
    "btn_mode_active": {
        "en": "mode: active",
        "ru": "режим: активный",
    },
    "btn_jev_on": {
        "en": "classification: on",
        "ru": "классификация: вкл",
    },
    "btn_jev_off": {
        "en": "classification: off",
        "ru": "классификация: выкл",
    },
}


def t(key: str, lang: str = "en", **kwargs) -> str:
    template = STRINGS.get(key, {}).get(lang) or STRINGS.get(key, {}).get("en", key)
    return template.format(**kwargs) if kwargs else template
