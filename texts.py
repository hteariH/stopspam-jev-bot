"""All user-visible strings. English is the default and the fallback."""

STRINGS: dict[str, dict[str, str]] = {
    "card_title": {"en": "Possible spam", "ru": "Похоже на спам", "uk": "Схоже на спам"},
    "card_author": {"en": "Author", "ru": "Автор", "uk": "Автор"},
    "card_chat": {"en": "Chat", "ru": "Чат", "uk": "Чат"},
    "card_risk": {"en": "Risk", "ru": "Риск", "uk": "Ризик"},
    "card_kind": {"en": "Kind", "ru": "Тип", "uk": "Тип"},
    "card_breakdown": {"en": "Breakdown", "ru": "Разбор", "uk": "Розбір"},
    "card_deleted": {"en": "Deleted automatically", "ru": "Удалено автоматически", "uk": "Видалено автоматично"},
    "outage_title": {"en": "Not checked", "ru": "Сообщение не проверено", "uk": "Повідомлення не перевірено"},
    "outage_body": {
        "en": "The classifier was unavailable, so this message was never "
              "checked. It carried a link, a forward or a media caption, which "
              "is why you are being told about it. Nothing was deleted — please "
              "take a look.",
        "ru": "Классификатор был недоступен, поэтому это сообщение не "
              "проверялось. В нём есть ссылка, пересылка или подпись к медиа — "
              "поэтому я о нём сообщаю. Ничего не удалено, посмотрите, "
              "пожалуйста, сами.",
        "uk": "Класифікатор був недоступний, тому це повідомлення не "
              "перевірялося. У ньому є посилання, пересилання або підпис до "
              "медіа — тому я про нього повідомляю. Нічого не видалено, "
              "погляньте, будь ласка, самі.",
    },
    "btn_ban": {"en": "Delete & ban", "ru": "Удалить и забанить", "uk": "Видалити й заблокувати"},
    "btn_delete": {"en": "Delete", "ru": "Удалить", "uk": "Видалити"},
    "btn_not_spam": {"en": "Not spam", "ru": "Не спам", "uk": "Не спам"},
    "done_ban": {
        "en": "Deleted and banned.",
        "ru": "Удалено, автор забанен.",
        "uk": "Видалено, автора заблоковано.",
    },
    "done_delete": {"en": "Deleted.", "ru": "Удалено.", "uk": "Видалено."},
    "done_not_spam": {
        "en": "Marked as not spam. This user is now allowlisted here.",
        "ru": "Отмечено как не спам. Автор добавлен в белый список этого чата.",
        "uk": "Позначено як не спам. Автора додано до білого списку цього чату.",
    },
    "already_handled": {"en": "Already handled.", "ru": "Уже обработано.", "uk": "Уже опрацьовано."},
    "not_admin": {
        "en": "Only admins of that chat can use these buttons.",
        "ru": "Эти кнопки доступны только админам чата.",
        "uk": "Ці кнопки доступні лише адміністраторам того чату.",
    },
    "welcome": {
        "en": "I remove spam and scam messages from Telegram groups.\n"
              "\n"
              "Add me to your group, give me permission to delete messages and "
              "ban users, then send /chats here to configure me.\n"
              "\n"
              "For the first 7 days I only report what I would have removed, so "
              "you can judge my accuracy before enabling enforcement.",
        "ru": "Я удаляю спам и мошеннические сообщения из групп в Telegram.\n"
              "\n"
              "Добавьте меня в свою группу, дайте право удалять сообщения и "
              "банить пользователей, затем отправьте мне /chats здесь, чтобы "
              "настроить меня.\n"
              "\n"
              "Первые 7 дней я только сообщаю о том, что удалил бы, чтобы вы "
              "могли оценить точность до включения принудительных действий.",
        "uk": "Я прибираю спам і шахрайські повідомлення з груп Telegram.\n"
              "\n"
              "Додайте мене до своєї групи, дайте право видаляти повідомлення "
              "та блокувати учасників, а потім надішліть сюди /chats, щоб "
              "налаштувати мене.\n"
              "\n"
              "Перші 7 днів я лише повідомляю, що саме видалив би, — щоб ви "
              "оцінили мою точність, перш ніж вмикати втручання.",
    },
    "help": {
        "en": "I remove spam and scam messages from Telegram groups.\n"
              "\n"
              "Add me to your group, give me permission to delete messages and "
              "ban users, then send /chats here to configure me.\n"
              "\n"
              "For the first 7 days I only report what I would have removed, so "
              "you can judge my accuracy before enabling enforcement.",
        "ru": "Я удаляю спам и мошеннические сообщения из групп в Telegram.\n"
              "\n"
              "Добавьте меня в свою группу, дайте право удалять сообщения и "
              "банить пользователей, затем отправьте мне /chats здесь, чтобы "
              "настроить меня.\n"
              "\n"
              "Первые 7 дней я только сообщаю о том, что удалил бы, чтобы вы "
              "могли оценить точность до включения принудительных действий.",
        "uk": "Я прибираю спам і шахрайські повідомлення з груп Telegram.\n"
              "\n"
              "Додайте мене до своєї групи, дайте право видаляти повідомлення "
              "та блокувати учасників, а потім надішліть сюди /chats, щоб "
              "налаштувати мене.\n"
              "\n"
              "Перші 7 днів я лише повідомляю, що саме видалив би, — щоб ви "
              "оцінили мою точність, перш ніж вмикати втручання.",
    },
    "privacy": {
        "en": "<b>Privacy</b>\n"
              "\n"
              "To classify a message I send its text and some metadata (link "
              "domains, whether it was forwarded, how long the author has been "
              "in the group) to the TypeSafe Jev API, which is operated in the "
              "United States.\n"
              "\n"
              "<b>What I send:</b>\n"
              "• every message from a member who has not yet posted 5 clean "
              "messages in this group (an admin can change that number);\n"
              "• every message from a member who has been flagged here before — "
              "that does not stop;\n"
              "• any message containing a link, a Telegram invite link, a "
              "forward, or a caption on media, from anyone, however long they "
              "have been here;\n"
              "• the next message from a trusted member who has been silent for "
              "more than 30 days.\n"
              "\n"
              "<b>What I never send:</b> messages from the group's admins and "
              "owners, messages from anyone an admin has marked as not spam, "
              "and messages with neither text nor a caption (joins, pins, "
              "photos with no caption).\n"
              "\n"
              "Message text is stored for at most 7 days in the review queue "
              "and is then erased. The audit log never stores message text.\n"
              "\n"
              "Any admin can switch classification off for a chat with /chats.",
        "ru": "<b>Конфиденциальность</b>\n"
              "\n"
              "Чтобы классифицировать сообщение, я отправляю его текст и часть "
              "метаданных (домены ссылок, было ли оно переслано, как давно "
              "автор состоит в группе) в API TypeSafe Jev, который работает в "
              "США.\n"
              "\n"
              "<b>Что я отправляю:</b>\n"
              "• каждое сообщение участника, который ещё не написал 5 чистых "
              "сообщений в этой группе (админ может изменить это число);\n"
              "• каждое сообщение участника, которого здесь уже отмечали как "
              "нарушителя, — и это не прекращается;\n"
              "• любое сообщение со ссылкой, пригласительной ссылкой Telegram, "
              "пересылкой или подписью к медиа — от кого угодно, как бы давно "
              "он ни состоял в группе;\n"
              "• следующее сообщение участника с доверием, который молчал "
              "больше 30 дней.\n"
              "\n"
              "<b>Что я не отправляю никогда:</b> сообщения админов и "
              "владельцев группы, сообщения тех, кого админ отметил как «не "
              "спам», и сообщения без текста и без подписи (входы в группу, "
              "закрепления, фото без подписи).\n"
              "\n"
              "Текст сообщения хранится в очереди на проверку не более 7 дней, "
              "после чего удаляется. Журнал аудита никогда не хранит текст "
              "сообщений.\n"
              "\n"
              "Любой админ может отключить классификацию для чата через /chats.",
        "uk": "<b>Приватність</b>\n"
              "\n"
              "Щоб класифікувати повідомлення, я надсилаю його текст і частину "
              "метаданих (домени посилань, чи було це пересилання, скільки часу "
              "автор у групі) до API TypeSafe Jev, який працює у Сполучених "
              "Штатах.\n"
              "\n"
              "<b>Що я надсилаю:</b>\n"
              "• кожне повідомлення від учасника, який ще не написав 5 чистих "
              "повідомлень у цій групі (адміністратор може змінити це число);\n"
              "• кожне повідомлення від учасника, якого тут уже позначали — це "
              "не припиняється;\n"
              "• будь-яке повідомлення з посиланням, запрошенням до Telegram, "
              "пересиланням або підписом до медіа, від кого завгодно, хоч би "
              "скільки він тут пробув;\n"
              "• наступне повідомлення від довіреного учасника, який мовчав "
              "понад 30 днів.\n"
              "\n"
              "<b>Чого я не надсилаю ніколи:</b> повідомлення адміністраторів і "
              "власників групи, повідомлення тих, кого адміністратор позначив "
              "як не спам, і повідомлення без тексту та підпису (входи, "
              "закріплення, фото без підпису).\n"
              "\n"
              "Текст повідомлення зберігається щонайбільше 7 днів у черзі "
              "розбору, а потім стирається. Журнал аудиту ніколи не зберігає "
              "текст повідомлень.\n"
              "\n"
              "Будь-який адміністратор може вимкнути класифікацію для чату "
              "через /chats.",
    },
    "too_many_requests": {
        "en": "Too many requests. Please try again in a minute.",
        "ru": "Слишком много запросов. Попробуйте ещё раз через минуту.",
        "uk": "Забагато запитів. Спробуйте ще раз за хвилину.",
    },
    "no_chats": {
        "en": "I am not in any group you administer yet. Add me to a group first.",
        "ru": "Я пока не состою ни в одной группе, где вы админ. Сначала "
              "добавьте меня в группу.",
        "uk": "Я ще не в жодній групі, де ви адміністратор. Спершу додайте мене "
              "до групи.",
    },
    "menu_title": {
        "en": "Settings for {title}",
        "ru": "Настройки для {title}",
        "uk": "Налаштування для {title}",
    },
    "menu_mode": {"en": "Mode", "ru": "Режим", "uk": "Режим"},
    "menu_jev": {"en": "Classification", "ru": "Классификация", "uk": "Класифікація"},
    "menu_lang": {"en": "Language", "ru": "Язык", "uk": "Мова"},
    "menu_thresholds": {"en": "Thresholds", "ru": "Пороги", "uk": "Пороги"},
    "menu_delete_threshold": {"en": "delete", "ru": "удаление", "uk": "видалення"},
    "menu_review_threshold": {"en": "review", "ru": "проверка", "uk": "перевірка"},
    "menu_log_chat": {
        "en": "Review cards go to",
        "ru": "Карточки проверки приходят",
        "uk": "Картки розбору надходять до",
    },
    "log_chat_unset": {
        "en": "nowhere — no destination is set, so cards are not delivered",
        "ru": "никуда — адресат не задан, карточки не отправляются",
        "uk": "нікуди — адресата не задано, тож картки не доставляються",
    },
    "log_chat_dm": {
        "en": "a private chat with admin {user_id}",
        "ru": "в личный чат с админом {user_id}",
        "uk": "особистий чат з адміністратором {user_id}",
    },
    "log_chat_group": {"en": "chat {chat_id}", "ru": "в чат {chat_id}", "uk": "чат {chat_id}"},
    "btn_log_here": {"en": "send cards to me", "ru": "присылать карточки мне", "uk": "надсилати картки мені"},
    "setlog_not_admin": {
        "en": "Only an admin of this chat can use /setlog.",
        "ru": "Команду /setlog может использовать только админ этого чата.",
        "uk": "Команду /setlog може використати лише адміністратор цього чату.",
    },
    "setlog_done": {
        "en": "Done. Review cards now come here. Groups redirected: {count}.",
        "ru": "Готово. Карточки проверки теперь приходят сюда. Перенаправлено "
              "групп: {count}.",
        "uk": "Готово. Картки тепер надходять сюди. Груп перенаправлено: {count}.",
    },
    "setlog_none": {
        "en": "I found no group of yours to redirect here. Post a message in "
              "that group first so I know you are in it, then run /setlog here "
              "again.",
        "ru": "Не нашёл ваших групп, которые можно сюда перенаправить. Сначала "
              "напишите сообщение в нужной группе, чтобы я знал, что вы в ней, "
              "затем снова выполните /setlog здесь.",
        "uk": "Я не знайшов жодної вашої групи, щоб перенаправити сюди. Спершу "
              "напишіть повідомлення в тій групі, щоб я знав, що ви в ній, а "
              "потім виконайте /setlog тут ще раз.",
    },
    "menu_not_admin": {
        "en": "You are not an admin of that chat.",
        "ru": "Вы не админ этого чата.",
        "uk": "Ви не адміністратор того чату.",
    },
    "btn_mode_observe": {"en": "mode: observe", "ru": "режим: наблюдение", "uk": "режим: спостереження"},
    "btn_mode_active": {"en": "mode: active", "ru": "режим: активный", "uk": "режим: активний"},
    "btn_jev_on": {"en": "classification: on", "ru": "классификация: вкл", "uk": "класифікація: увімк"},
    "btn_jev_off": {"en": "classification: off", "ru": "классификация: выкл", "uk": "класифікація: вимк"},
    "card_not_entitled": {
        "en": "I would have deleted this, but this group has no subscription.",
        "ru": "Я бы это удалил, но у группы нет подписки.",
        "uk": "Я б це видалив, але в групи немає підписки.",
    },
    "btn_subscribe": {
        "en": "Subscribe — {stars} ⭐/month",
        "ru": "Подписка — {stars} ⭐/мес",
        "uk": "Підписка — {stars} ⭐/міс",
    },
    "menu_billing": {"en": "Plan", "ru": "Тариф", "uk": "Тариф"},
    "billing_free": {
        "en": "free ({count} members, under {limit})",
        "ru": "бесплатный ({count} участников, до {limit})",
        "uk": "безкоштовний ({count} учасників, до {limit})",
    },
    "billing_subscribed": {
        "en": "paid, {days} days left",
        "ru": "оплачено, осталось дней: {days}",
        "uk": "оплачено, залишилось днів: {days}",
    },
    "billing_grace": {
        "en": "free trial, {days} days left",
        "ru": "пробный период, осталось дней: {days}",
        "uk": "пробний період, залишилось днів: {days}",
    },
    "billing_none": {
        "en": "no subscription — I report spam but do not delete it",
        "ru": "нет подписки — спам показываю, но не удаляю",
        "uk": "немає підписки — спам показую, але не видаляю",
    },
    "btn_start_deleting": {
        "en": "Seen enough — start deleting",
        "ru": "Хватит наблюдать — начать удалять",
        "uk": "Досить спостерігати — почати видаляти",
    },
    "invoice_title": {
        "en": "StopSpam: auto-delete",
        "ru": "StopSpam: автоудаление",
        "uk": "StopSpam: автовидалення",
    },
    "invoice_description": {
        "en": "Automatic deletion of spam and scam in {title}. "
              "{stars} ⭐ every 30 days, cancel any time.",
        "ru": "Автоматическое удаление спама и скама в {title}. "
              "{stars} ⭐ каждые 30 дней, можно отменить в любой момент.",
        "uk": "Автоматичне видалення спаму й шахрайства в {title}. "
              "{stars} ⭐ кожні 30 днів, скасувати можна будь-коли.",
    },
    "invoice_label": {
        "en": "30 days", "ru": "30 дней", "uk": "30 днів",
    },
    "pay_thanks": {
        "en": "Payment received. I will delete spam in {title} automatically "
              "for the next {days} days, and the subscription renews by itself.",
        "ru": "Оплата получена. Ближайшие {days} дней я буду удалять спам "
              "в {title} автоматически, подписка продлевается сама.",
        "uk": "Оплату отримано. Найближчі {days} днів я видалятиму спам "
              "у {title} автоматично, підписка подовжується сама.",
    },
    "pay_cancel_hint": {
        "en": "You can cancel it in Telegram: Settings → My Stars → Subscriptions.",
        "ru": "Отменить можно в Telegram: Настройки → Мои звёзды → Подписки.",
        "uk": "Скасувати можна в Telegram: Налаштування → Мої зірки → Підписки.",
    },
    "pay_rejected": {
        "en": "I could not recognise this invoice, so nothing was charged. "
              "Please open the subscription button in /chats again.",
        "ru": "Я не распознал этот счёт, деньги не списаны. "
              "Откройте кнопку подписки в /chats ещё раз.",
        "uk": "Я не розпізнав цей рахунок, гроші не списано. "
              "Відкрийте кнопку підписки в /chats ще раз.",
    },
    "pay_unrecorded": {
        "en": "Your payment went through, but I could not record it. "
              "Nothing is lost — contact the bot's author with this message.",
        "ru": "Оплата прошла, но я не смог её записать. "
              "Ничего не потеряно — напишите автору бота, показав это сообщение.",
        "uk": "Оплата пройшла, але я не зміг її записати. "
              "Нічого не втрачено — напишіть автору бота, показавши це повідомлення.",
    },
    "invoice_unavailable": {
        "en": "Telegram would not give me a payment link just now. Try again in a minute.",
        "ru": "Telegram сейчас не выдал ссылку на оплату. Попробуйте через минуту.",
        "uk": "Telegram зараз не видав посилання на оплату. Спробуйте за хвилину.",
    },
    "notice_grace": {
        "en": "{title} has grown past {limit} members, so automatic deletion now "
              "needs a subscription. It keeps working free for {days} more days.",
        "ru": "В {title} стало больше {limit} участников, поэтому автоудаление "
              "теперь требует подписки. Ещё {days} дней оно работает бесплатно.",
        "uk": "У {title} стало більше {limit} учасників, тому автовидалення "
              "тепер потребує підписки. Ще {days} днів воно працює безкоштовно.",
    },
    "notice_grace_ending": {
        "en": "The free trial for {title} ends in {days} days. After that I will "
              "keep reporting spam, but I will stop deleting it.",
        "ru": "Пробный период для {title} заканчивается через {days} дней. "
              "Потом я продолжу показывать спам, но перестану его удалять.",
        "uk": "Пробний період для {title} завершується за {days} днів. "
              "Потім я й далі показуватиму спам, але перестану його видаляти.",
    },
    "notice_lapsed": {
        "en": "The subscription for {title} has ended. I am still checking every "
              "message and still sending you these cards — I am just not deleting "
              "anything until it is renewed.",
        "ru": "Подписка для {title} закончилась. Я по-прежнему проверяю каждое "
              "сообщение и присылаю карточки — просто ничего не удаляю, "
              "пока её не продлят.",
        "uk": "Підписка для {title} завершилася. Я й далі перевіряю кожне "
              "повідомлення та надсилаю картки — просто нічого не видаляю, "
              "доки її не подовжать.",
    },
}


def t(key: str, lang: str = "en", **kwargs) -> str:
    template = STRINGS.get(key, {}).get(lang) or STRINGS.get(key, {}).get("en", key)
    return template.format(**kwargs) if kwargs else template
