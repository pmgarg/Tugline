def fmt_row(name, value):
    return f"{name}: {value}"


def render(rows):
    return "\n".join(fmt_row(n, v) for n, v in rows)


def render_one(name, value):
    return fmt_row(name, value)
