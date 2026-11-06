"""Money in other currencies."""
from decimal import Decimal

_RATES_TO_EUR = {"EUR": Decimal("1"), "USD": Decimal("0.92"), "AED": Decimal("0.25"), "INR": Decimal("0.011")}


def convert(amount: Decimal, src: str, dst: str) -> Decimal:
    """Convert an amount between two currencies through EUR."""
    if src not in _RATES_TO_EUR or dst not in _RATES_TO_EUR:
        raise KeyError(f"unknown currency {src}->{dst}")
    eur = amount * _RATES_TO_EUR[src]
    return (eur / _RATES_TO_EUR[dst]).quantize(Decimal("0.01"))


def format_money(amount: Decimal, code: str) -> str:
    symbols = {"EUR": "€", "USD": "$", "AED": "د.إ", "INR": "₹"}
    return f"{symbols.get(code, code)}{amount:,.2f}"
