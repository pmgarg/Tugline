from inventory.parse import parse_line


def test_parse_line():
    assert parse_line("apple, 3") == ("apple", 3)
