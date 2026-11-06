from pricing import apply_discount, with_tax

def test_discount():
    assert apply_discount(100, 20) == 80
    assert apply_discount(50, 0) == 50

def test_tax():
    assert with_tax(10) == 12.0
