import os
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
    # admin.router, review.router and group.router are module-level aiogram
    # Routers, and aiogram refuses to attach a Router that already has a
    # parent Dispatcher. This file calls bot.build_dispatcher() from more
    # than one test in the same process, so each router module must be
    # reloaded here to hand every test a fresh, unattached Router - mirrors
    # the same fixture pattern in tests/test_group_handler.py and
    # tests/test_admin_handler.py.
    import handlers.admin
    import handlers.group
    import handlers.review
    importlib.reload(handlers.admin)
    importlib.reload(handlers.review)
    importlib.reload(handlers.group)
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
