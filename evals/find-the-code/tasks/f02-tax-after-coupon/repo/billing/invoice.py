"""Invoices: line items, tax and discounts."""
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP

VAT_RATES = {"DE": Decimal("0.19"), "FR": Decimal("0.20"), "AE": Decimal("0.05")}


@dataclass
class LineItem:
    sku: str
    quantity: int
    unit_price: Decimal


@dataclass
class Invoice:
    country: str
    items: list[LineItem] = field(default_factory=list)
    coupon_percent: Decimal = Decimal("0")

    def subtotal(self) -> Decimal:
        return sum((i.unit_price * i.quantity for i in self.items), Decimal("0"))

    def discount(self) -> Decimal:
        return (self.subtotal() * self.coupon_percent / 100).quantize(Decimal("0.01"), ROUND_HALF_UP)

    def tax(self) -> Decimal:
        rate = VAT_RATES.get(self.country, Decimal("0"))
        return (self.subtotal() * rate).quantize(Decimal("0.01"), ROUND_HALF_UP)

    def total(self) -> Decimal:
        return self.subtotal() - self.discount() + self.tax()
