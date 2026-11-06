def format_row(name, value):
    return f"{name}: {value}"


def render(rows):
    return "\n".join(format_row(n, v) for n, v in rows)


def render_one(name, value):
    return format_row(name, value)
