from text import slugify

def test_slug():
    assert slugify("Hello — World") == "hello-world"
    assert slugify("  A  b ") == "a-b"
    assert slugify("x") == "x"
