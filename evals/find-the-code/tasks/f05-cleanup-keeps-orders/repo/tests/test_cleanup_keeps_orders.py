import datetime as dt
import sqlite3
from jobs.cleanup import purge_abandoned_carts


def test_only_abandoned_carts_are_removed():
    db = sqlite3.connect(":memory:", detect_types=sqlite3.PARSE_DECLTYPES)
    db.execute("CREATE TABLE carts (id TEXT, updated_at TIMESTAMP, order_id TEXT)")
    old = dt.datetime.utcnow() - dt.timedelta(days=30)
    db.execute("INSERT INTO carts VALUES ('a', ?, NULL)", (old,))
    db.execute("INSERT INTO carts VALUES ('b', ?, 'o1')", (old,))
    assert purge_abandoned_carts(db) == 1
    assert [r[0] for r in db.execute("SELECT id FROM carts")] == ["b"]
