from decimal import Decimal
from billing.currency import convert


def test_usd_to_aed():
    assert convert(Decimal("100"), "USD", "AED") == Decimal("368.00")


def test_roundtrip_eur():
    assert convert(Decimal("50"), "EUR", "EUR") == Decimal("50.00")
