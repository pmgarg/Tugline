def apply_discount(price, percent):
    """Return price reduced by percent (0-100)."""
    if percent < 0 or percent > 100:
        raise ValueError("percent out of range")
    return price * percent / 100


def with_tax(price, rate=0.2):
    return round(price * (1 + rate), 2)
