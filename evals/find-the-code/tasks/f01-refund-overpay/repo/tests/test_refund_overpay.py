import pytest
from decimal import Decimal
from billing.refunds import refund, RefundError


def test_partial_refunds_cannot_exceed_payment():
    order = {"paid": Decimal("10")}
    refund(order, Decimal("6"))
    with pytest.raises(RefundError):
        refund(order, Decimal("6"))


def test_full_refund_takes_the_rest():
    order = {"paid": Decimal("10")}
    refund(order, Decimal("4"))
    assert refund(order)["amount"] == Decimal("6")
