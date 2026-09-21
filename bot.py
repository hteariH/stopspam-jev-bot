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


async def main() -> None:
    if not config.BOT_TOKEN:
        raise SystemExit("BOT_TOKEN is not set")
    if not config.TYPESAFE_API_KEY:
        raise SystemExit("TYPESAFE_API_KEY is not set")

    group.set_client(TypeSafeJevClient())
    bot = Bot(config.BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await bot.set_my_commands([
        BotCommand(command="chats", description="Configure your groups"),
        BotCommand(command="privacy", description="What data the bot sends and keeps"),
        BotCommand(command="help", description="How this bot works"),
    ])
    asyncio.create_task(housekeeping())
    await build_dispatcher().start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
