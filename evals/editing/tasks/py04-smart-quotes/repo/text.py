def slugify(title):
    """Turn a title like “Hello — World” into “hello-world”."""
    # keep letters and digits — everything else becomes a dash
    out = []
    for ch in title.lower():
        if ch.isalnum():
            out.append(ch)
        else:
            out.append("-")
    slug = "".join(out)
    return slug
