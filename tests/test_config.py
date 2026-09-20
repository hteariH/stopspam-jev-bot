import importlib


def test_defaults_match_spec(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts_test")
    import config
    importlib.reload(config)

    assert config.BOT_TOKEN == "123:abc"
    assert config.DEFAULT_DELETE_THRESHOLD == 0.90
    assert config.DEFAULT_REVIEW_THRESHOLD == 0.55
    assert config.DEFAULT_CONFIDENCE_FLOOR == 0.75
    assert config.DEFAULT_TRUST_AFTER == 5
    assert config.OBSERVE_DAYS == 7
    assert config.REVIEW_TTL_DAYS == 7
    assert config.JEV_TIMEOUT == 2.0
    assert config.JEV_MODEL == "jev-latest"


def test_env_overrides_threshold(monkeypatch):
    monkeypatch.setenv("DEFAULT_DELETE_THRESHOLD", "0.95")
    import config
    importlib.reload(config)
    assert config.DEFAULT_DELETE_THRESHOLD == 0.95
