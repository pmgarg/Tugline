def paginate(items, page, size):
    """Return the items on a 1-based page of the given size."""
    start = page * size
    return items[start:start + size]


def page_count(items, size):
    """Number of pages needed to show all items."""
    return (len(items) + size - 1) // size
