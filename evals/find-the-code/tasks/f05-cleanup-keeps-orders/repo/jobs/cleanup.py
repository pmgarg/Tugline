"""Nightly maintenance."""
import datetime as dt


def purge_abandoned_carts(db, older_than_days: int = 14) -> int:
    """Delete carts nobody touched for two weeks; returns how many were removed."""
    cutoff = dt.datetime.utcnow() - dt.timedelta(days=older_than_days)
    rows = db.execute("DELETE FROM carts WHERE updated_at < ?", (cutoff,))
    return rows.rowcount


def schedule(cron):
    cron.every_day_at("03:15", purge_abandoned_carts)
