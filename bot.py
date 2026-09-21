"""@StopSpam_jev_bot - spam and scam moderation for Telegram groups."""
import asyncio
import logging
import sqlite3
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand

import config
from core.jev import TypeSafeJevClient
from handlers import admin, group, review
from storage import reviews

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stopspam")

HOUSEKEEPING_INTERVAL = 3600

# asyncio.create_task() only keeps a weak reference to the task it returns -
# if nothing else holds a strong reference, the event loop is free to
# garbage-collect the task mid-flight, silently ending the housekeeping loop
# for the rest of the process. Assigning the task here, at module scope,
# keeps it alive for as long as the process runs.
_housekeeping_task: asyncio.Task | None = None


def build_dispatcher() -> Dispatcher:
    dispatcher = Dispatcher()
    # Order matters: the group router matches every group message, so the
    # specific routers are registered first.
    dispatcher.include_router(admin.router)
    dispatcher.include_router(review.router)
    dispatcher.include_router(group.router)
    return dispatcher


async def housekeeping(once: bool = False) -> None:
    while True:
        try:
            cleared = reviews.purge_expired()
        except sqlite3.Error as exc:
            # This loop runs unattended for the life of the process, with
            # nothing awaiting it - an uncaught exception here would kill
            # the task silently and stop future purges forever, long after
            # a transient storage hiccup (a lock, a full disk) has passed.
            log.warning("housekeeping pass failed: %s", exc)
        else:
            if cleared:
                log.info("purged text from %s expired reviews", cleared)
        if once:
            return
        await asyncio.sleep(HOUSEKEEPING_INTERVAL)


def _report_housekeeping_death(task: asyncio.Task) -> None:
    """Logs a housekeeping task that died from something its own
    sqlite3.Error guard did not catch.

    Nothing awaits this task, so without this callback such a death would
    surface only as asyncio's own "Task exception was never retrieved"
    warning - and only once the garbage collector happens to reclaim the
    task, which may be much later or never. This just makes the failure
    visible in the log immediately; it does not restart the loop. That is a
    deliberate choice: a housekeeping loop that failed on something other
    than a storage error hit a bug worth looking at, not a transient
    condition worth silently retrying forever.

    What makes that choice safe is that the 7-day erasure no longer depends
    on this task alone: storage.reviews.create() purges expired text on its
    way past, so no new message text is stored without expired text being
    cleared in the same call. This loop is what erases text in a group that
    has gone quiet, where nothing new is being written to trigger that.
    """
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error("housekeeping task died unexpectedly", exc_info=exc)


async def main() -> None:
    if not config.BOT_TOKEN:
        raise SystemExit("BOT_TOKEN is not set")
    if not config.TYPESAFE_API_KEY:
        raise SystemExit("TYPESAFE_API_KEY is not set")

    group.set_client(TypeSafeJevClient())
    bot = Bot(config.BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await bot.set_my_commands([
        BotCommand(command="chats", description="Configure your groups"),
        BotCommand(command="setlog",
                   description="Send review cards to this chat (group admins)"),
        BotCommand(command="privacy", description="What data the bot sends and keeps"),
        BotCommand(command="help", description="How this bot works"),
    ])
    global _housekeeping_task
    _housekeeping_task = asyncio.create_task(housekeeping())
    _housekeeping_task.add_done_callback(_report_housekeeping_death)
    await build_dispatcher().start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
