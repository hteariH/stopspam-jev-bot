"""One-off: regenerate texts.py with a Ukrainian column alongside English and Russian.

Rewriting the whole STRINGS block beats 42 surgical edits — one chance to get the
shape wrong instead of forty-two. English and Russian are carried over verbatim
from the live module, so only the Ukrainian below is new.

    python tools/add_ukrainian.py
"""
import textwrap

import texts

BULLET, DASH = "\u2022", "\u2014"

UK = {
    "card_title": "Схоже на спам",
    "card_author": "Автор",
    "card_chat": "Чат",
    "card_risk": "Ризик",
    "card_kind": "Тип",
    "card_breakdown": "Розбір",
    "card_deleted": "Видалено автоматично",
    "outage_title": "Повідомлення не перевірено",
    "outage_body": (
        "Класифікатор був недоступний, тому це повідомлення не перевірялося. "
        "У ньому є посилання, пересилання або підпис до медіа " + DASH + " тому я "
        "про нього повідомляю. Нічого не видалено, погляньте, будь ласка, самі."
    ),
    "btn_ban": "Видалити й заблокувати",
    "btn_delete": "Видалити",
    "btn_not_spam": "Не спам",
    "done_ban": "Видалено, автора заблоковано.",
    "done_delete": "Видалено.",
    "done_not_spam": "Позначено як не спам. Автора додано до білого списку цього чату.",
    "already_handled": "Уже опрацьовано.",
    "not_admin": "Ці кнопки доступні лише адміністраторам того чату.",
    "welcome": (
        "Я прибираю спам і шахрайські повідомлення з груп Telegram.\n\n"
        "Додайте мене до своєї групи, дайте право видаляти повідомлення та "
        "блокувати учасників, а потім надішліть сюди /chats, щоб налаштувати мене.\n\n"
        "Перші 7 днів я лише повідомляю, що саме видалив би, " + DASH + " щоб ви "
        "оцінили мою точність, перш ніж вмикати втручання."
    ),
    "too_many_requests": "Забагато запитів. Спробуйте ще раз за хвилину.",
    "no_chats": (
        "Я ще не в жодній групі, де ви адміністратор. Спершу додайте мене до групи."
    ),
    "menu_title": "Налаштування для {title}",
    "menu_mode": "Режим",
    "menu_jev": "Класифікація",
    "menu_lang": "Мова",
    "menu_thresholds": "Пороги",
    "menu_delete_threshold": "видалення",
    "menu_review_threshold": "перевірка",
    "menu_log_chat": "Картки розбору надходять до",
    "log_chat_unset": (
        "нікуди " + DASH + " адресата не задано, тож картки не доставляються"
    ),
    "log_chat_dm": "особистий чат з адміністратором {user_id}",
    "log_chat_group": "чат {chat_id}",
    "btn_log_here": "надсилати картки мені",
    "setlog_not_admin": "Команду /setlog може використати лише адміністратор цього чату.",
    "setlog_done": "Готово. Картки тепер надходять сюди. Груп перенаправлено: {count}.",
    "setlog_none": (
        "Я не знайшов жодної вашої групи, щоб перенаправити сюди. Спершу напишіть "
        "повідомлення в тій групі, щоб я знав, що ви в ній, а потім виконайте "
        "/setlog тут ще раз."
    ),
    "menu_not_admin": "Ви не адміністратор того чату.",
    "btn_mode_observe": "режим: спостереження",
    "btn_mode_active": "режим: активний",
    "btn_jev_on": "класифікація: увімк",
    "btn_jev_off": "класифікація: вимк",
}

UK["help"] = UK["welcome"]

UK["privacy"] = (
    "<b>Приватність</b>\n\n"
    "Щоб класифікувати повідомлення, я надсилаю його текст і частину метаданих "
    "(домени посилань, чи було це пересилання, скільки часу автор у групі) до API "
    "TypeSafe Jev, який працює у Сполучених Штатах.\n\n"
    "<b>Що я надсилаю:</b>\n"
    + BULLET + " кожне повідомлення від учасника, який ще не написав 5 чистих "
    "повідомлень у цій групі (адміністратор може змінити це число);\n"
    + BULLET + " кожне повідомлення від учасника, якого тут уже позначали " + DASH
    + " це не припиняється;\n"
    + BULLET + " будь-яке повідомлення з посиланням, запрошенням до Telegram, "
    "пересиланням або підписом до медіа, від кого завгодно, хоч би скільки він "
    "тут пробув;\n"
    + BULLET + " наступне повідомлення від довіреного учасника, який мовчав "
    "понад 30 днів.\n\n"
    "<b>Чого я не надсилаю ніколи:</b> повідомлення адміністраторів і власників "
    "групи, повідомлення тих, кого адміністратор позначив як не спам, і "
    "повідомлення без тексту та підпису (входи, закріплення, фото без підпису).\n\n"
    "Текст повідомлення зберігається щонайбільше 7 днів у черзі розбору, а потім "
    "стирається. Журнал аудиту ніколи не зберігає текст повідомлень.\n\n"
    "Будь-який адміністратор може вимкнути класифікацію для чату через /chats."
)


def emit(value: str, indent: str) -> str:
    """One Python string literal, wrapped like the rest of the file."""
    if "\n" not in value and len(value) + len(indent) < 84:
        return repr_dq(value)
    parts, width = [], 78 - len(indent)
    for i, chunk in enumerate(value.split("\n")):
        pieces = textwrap.wrap(chunk, width=width) or [""]
        for j, piece in enumerate(pieces):
            tail = "" if (j == len(pieces) - 1) else " "
            parts.append(repr_dq(piece + tail))
        if i != len(value.split("\n")) - 1:
            parts[-1] = repr_dq(pieces[-1] + "\n")
    return ("\n" + indent).join(parts)


def repr_dq(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def main() -> None:
    missing = sorted(set(texts.STRINGS) - set(UK))
    if missing:
        raise SystemExit(f"no Ukrainian for: {missing}")
    extra = sorted(set(UK) - set(texts.STRINGS))
    if extra:
        raise SystemExit(f"Ukrainian for unknown keys: {extra}")

    out = ['"""All user-visible strings. English is the default and the fallback."""',
           "",
           "STRINGS: dict[str, dict[str, str]] = {"]
    for key, langs in texts.STRINGS.items():
        row = {"en": langs["en"], "ru": langs["ru"], "uk": UK[key]}
        short = all("\n" not in v and len(v) < 30 for v in row.values())
        if short:
            inline = ", ".join(f'"{k}": {repr_dq(v)}' for k, v in row.items())
            if len(inline) < 92:
                out.append(f'    "{key}": {{{inline}}},')
                continue
        out.append(f'    "{key}": {{')
        for lang, value in row.items():
            out.append(f'        "{lang}": {emit(value, " " * 14)},')
        out.append("    },")
    out += ["}", "", "",
            "def t(key: str, lang: str = \"en\", **kwargs) -> str:",
            "    template = STRINGS.get(key, {}).get(lang) or "
            "STRINGS.get(key, {}).get(\"en\", key)",
            "    return template.format(**kwargs) if kwargs else template",
            ""]
    with open("texts.py", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out))
    print(f"rewrote texts.py with {len(texts.STRINGS)} keys in en, ru, uk")


if __name__ == "__main__":
    main()
