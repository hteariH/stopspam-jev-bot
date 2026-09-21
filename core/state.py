"""Builds the structured state Jev evaluates.

Jev is built for structured program state, so we hand it a labelled document
rather than raw text: identical wording means different things from a five-year
member and from an account that joined ninety seconds ago.
"""
import re
from dataclasses import dataclass
from urllib.parse import urlparse

MAX_TEXT = 2000

_URL_RE = re.compile(r"(?:https?://|www\.|t\.me/)[^\s<>()]+", re.IGNORECASE)
_INVITE_RE = re.compile(r"(?:t\.me/(?:joinchat/|\+)|telegram\.me/joinchat/)", re.IGNORECASE)

_MEDIA_ATTRS = ("photo", "video", "animation", "document", "audio", "voice",
                "video_note", "sticker")


@dataclass(frozen=True)
class MessageFacts:
    text: str
    link_domains: tuple[str, ...]
    link_count: int
    has_invite_link: bool
    is_forward: bool
    media_type: str | None
    is_caption: bool
    author_message_count: int
    author_days_in_group: float | None
    author_has_username: bool
    group_title: str
    group_description: str


def _domain(raw: str) -> str:
    """Extract domain from URL, returning "" if parsing fails.

    Handles malformed URLs gracefully to prevent crashes on hostile input
    (e.g., unbalanced brackets in IPv6 addresses).
    """
    candidate = raw if "://" in raw else f"http://{raw}"
    try:
        host = urlparse(candidate).netloc.lower()
    except ValueError:
        # Invalid URL (e.g., malformed IPv6 literal) — skip this domain
        return ""
    return host[4:] if host.startswith("www.") else host


def build_state(facts: MessageFacts) -> str:
    age = ("unknown" if facts.author_days_in_group is None
           else f"{facts.author_days_in_group:.1f} days")
    lines = [
        "# Group",
        f"title: {facts.group_title}",
        f"description: {facts.group_description or '(none)'}",
        "",
        "# Author",
        f"messages previously sent in this group: {facts.author_message_count}",
        f"time in this group: {age}",
        f"has a username: {'yes' if facts.author_has_username else 'no'}",
        "",
        "# Message",
        f"is a media caption: {'yes' if facts.is_caption else 'no'}",
        f"media type: {facts.media_type or '(none)'}",
        f"forwarded: {'yes' if facts.is_forward else 'no'}",
        f"link count: {facts.link_count}",
        f"link domains: {', '.join(facts.link_domains) or '(none)'}",
        f"contains a Telegram invite link: {'yes' if facts.has_invite_link else 'no'}",
        "",
        "# Text",
        facts.text[:MAX_TEXT],
    ]
    return "\n".join(lines)


def facts_from_message(message, *, author_message_count: int,
                       author_days_in_group: float | None,
                       group_description: str) -> MessageFacts:
    text = message.text or message.caption or ""
    urls = _URL_RE.findall(text)
    media_type = next((name for name in _MEDIA_ATTRS
                       if getattr(message, name, None) is not None), None)
    # Filter out empty domains (from unparseable URLs)
    domains = tuple(dict.fromkeys(d for d in (_domain(u) for u in urls) if d))
    return MessageFacts(
        text=text,
        link_domains=domains,
        link_count=len(urls),
        has_invite_link=bool(_INVITE_RE.search(text)),
        is_forward=bool(getattr(message, "forward_origin", None)),
        media_type=media_type,
        is_caption=message.text is None and message.caption is not None,
        author_message_count=author_message_count,
        author_days_in_group=author_days_in_group,
        author_has_username=bool(message.from_user and message.from_user.username),
        group_title=(message.chat.title or "")[:128],
        group_description=(group_description or "")[:255],
    )
