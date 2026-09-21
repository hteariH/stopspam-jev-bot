"""A sliding-window rate limiter, used for two different keys.

Enforcement is capped per group per minute so a raid cannot turn the bot into
a flood source and get it banned. Public commands are capped per user per
minute so a stranger cannot make the bot spend its Telegram budget on demand.
Both are the same shape, so they are the same class keyed differently.
"""
import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._events: dict[int, deque[float]] = defaultdict(deque)

    def allow(self, key: int) -> bool:
        """True if this key still has budget, and spends one unit of it.

        `key` is a chat id for enforcement and a user id for commands - the
        budget is per key, never global, so one busy group or one noisy
        stranger cannot spend everybody else's.
        """
        window = self._events[key]
        now = time.monotonic()
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= self._per_minute:
            return False
        window.append(now)
        return True
