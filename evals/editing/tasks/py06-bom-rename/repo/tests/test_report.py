from report import format_row, render, render_one

def test_render():
    assert render([("a", 1), ("b", 2)]) == "a: 1\nb: 2"
    assert render_one("x", 3) == format_row("x", 3) == "x: 3"
