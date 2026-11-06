from inventory.report import format_report


def test_report_sorted():
    assert format_report([("pear", 1), ("apple", 2)]) == "apple: 2\npear: 1"
