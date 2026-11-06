from pager import paginate, page_count

ITEMS = list(range(1, 11))


def test_first_page():
    assert paginate(ITEMS, 1, 3) == [1, 2, 3]


def test_last_page():
    assert paginate(ITEMS, 4, 3) == [10]


def test_page_count():
    assert page_count(ITEMS, 3) == 4
