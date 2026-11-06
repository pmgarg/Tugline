"""Give money back to customers."""
from decimal import Decimal


class RefundError(Exception):
    pass


def refund(order, amount: Decimal | None = None, reason: str = "") -> dict:
    """Full refund when amount is None, otherwise a partial one."""
    paid = order["paid"]
    already = sum(r["amount"] for r in order.get("refunds", []))
    amount = paid - already if amount is None else amount
    if amount <= 0 or amount > paid:
        raise RefundError("refund exceeds the captured payment")
    entry = {"amount": amount, "reason": reason}
    order.setdefault("refunds", []).append(entry)
    return entry
