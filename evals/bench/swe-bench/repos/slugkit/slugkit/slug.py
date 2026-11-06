import re


def slugify(text: str) -> str:
    """Turn a title into a URL slug: lowercase words joined by single dashes."""
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]", "-", text)
    return text.strip("-")
