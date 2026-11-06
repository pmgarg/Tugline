from pathlib import Path


def test_error_count():
    assert Path("error_count.txt").read_text().strip() == "3"


def test_log_untouched():
    lines = Path("app.log").read_text().splitlines()
    assert len(lines) == 8 and lines[1].endswith("database connection refused")
