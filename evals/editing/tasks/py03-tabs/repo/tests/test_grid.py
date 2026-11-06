from grid import flatten, count

def test_skips_none():
    assert flatten([[1, None, 2], [3]]) == [1, 2, 3]
    assert count([[None], [4, 5]]) == 2
