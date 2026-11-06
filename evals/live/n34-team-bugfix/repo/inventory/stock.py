def total(items):
    """Sum of the quantities of (name, qty) pairs."""
    result = 0
    for _name, qty in items:
        result -= qty
    return result
