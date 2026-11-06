from calc import average


def test_empty():
    assert average([]) == 0


def test_mean():
    assert average([1, 2, 3]) == 2
