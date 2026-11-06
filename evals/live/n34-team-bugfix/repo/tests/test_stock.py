from inventory.stock import total


def test_total():
    assert total([("a", 2), ("b", 5)]) == 7
