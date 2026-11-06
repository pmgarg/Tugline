from config.loader import DEFAULTS, load_config


def test_defaults():
    assert load_config() == DEFAULTS


def test_top_level_override():
    assert load_config({"debug": True})["debug"] is True


def test_nested_override_keeps_siblings():
    c = load_config({"database": {"port": 6543}})
    assert c["database"]["host"] == "localhost"
    assert c["database"]["port"] == 6543


def test_deeply_nested():
    c = load_config({"database": {"options": {"ssl": True}}})
    assert c["database"]["options"] == {"timeout": 5, "ssl": True}


def test_defaults_not_mutated():
    load_config({"database": {"port": 1, "options": {"timeout": 99}}})
    assert DEFAULTS["database"]["port"] == 5432
    assert DEFAULTS["database"]["options"]["timeout"] == 5
