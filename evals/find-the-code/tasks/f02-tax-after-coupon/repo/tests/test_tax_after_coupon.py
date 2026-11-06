from decimal import Decimal
from billing.invoice import Invoice, LineItem


def test_vat_on_discounted_amount():
    inv = Invoice("DE", [LineItem("a", 1, Decimal("100"))], coupon_percent=Decimal("10"))
    assert inv.tax() == Decimal("17.10")
    assert inv.total() == Decimal("107.10")
