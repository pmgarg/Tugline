def format_report(items):
    """One 'name: qty' line per item, sorted by name A-Z."""
    rows = sorted(items, key=lambda x: x[0], reverse=True)
    return "\n".join(f"{n}: {q}" for n, q in rows)
