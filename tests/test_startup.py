import os
import sqlite3
import tempfile

import pytest


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setenv("DB_PATH", os.path.join(tempfile.mkdtemp(), "t.db"))
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts_test")
    import importlib
    import config
    importlib.reload(config)
    from storage import db
    db.reset()
    # admin.router, review.router, group.router and payments.router are
    # module-level aiogram Routers, and aiogram refuses to attach a Router
    # that already has a parent Dispatcher. This file calls
    # bot.build_dispatcher() from more than one test in the same process, so
    # each router module must be reloaded here to hand every test a fresh,
    # unattached Router - mirrors the same fixture pattern in
    # tests/test_group_handler.py and tests/test_admin_handler.py.
    import handlers.admin
    import handlers.group
    import handlers.payments
    import handlers.review
    importlib.reload(handlers.admin)
    importlib.reload(handlers.review)
    importlib.reload(handlers.group)
    importlib.reload(handlers.payments)
    yield
    db.reset()


def test_dispatcher_includes_every_router():
    import bot
    dispatcher = bot.build_dispatcher()
    names = {r.name for r in dispatcher.sub_routers}
    assert {"admin", "review", "group"} <= names


def test_group_router_is_last():
    """The catch-all group router must not swallow admin or callback updates."""
    import bot
    names = [r.name for r in bot.build_dispatcher().sub_routers]
    assert names[-1] == "group"


async def test_housekeeping_purges_expired_reviews():
    import json

    import bot
    from storage import db, reviews
    rid = reviews.create(-100, 1, 555, "spam", json.dumps({}), 0.9)
    db.connect().execute(
        "UPDATE reviews SET expires_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (rid,))
    db.connect().commit()

    await bot.housekeeping(once=True)
    assert reviews.get(rid)["text"] is None


async def test_housekeeping_survives_a_storage_error(monkeypatch):
    """A transient sqlite failure must not kill the unattended hourly loop."""
    import bot
    from storage import reviews

    def boom(*args, **kwargs):
        raise sqlite3.Error("disk full")

    monkeypatch.setattr(reviews, "purge_expired", boom)

    # Must return normally, not raise - this is the whole point of the
    # guard: one bad pass should not end the loop for the life of the
    # process.
    await bot.housekeeping(once=True)


async def test_housekeeping_does_not_swallow_other_errors(monkeypatch):
    """The guard is narrow: only sqlite3.Error is a storage failure worth
    absorbing. Anything else is a programming error and must still surface,
    per this project's narrow-exception-handling contract.
    """
    import bot
    from storage import reviews

    def boom(*args, **kwargs):
        raise ValueError("not a storage error")

    monkeypatch.setattr(reviews, "purge_expired", boom)

    with pytest.raises(ValueError):
        await bot.housekeeping(once=True)
