def merge(base, override):
    """Return base updated with override."""
    result = dict(base)
    result.update(override)
    return result
