from stats import mean, clamp, helper_7

def test_mean():
    assert mean([1, 2, 3]) == 2

def test_clamp():
    assert clamp(15, 0, 10) == 10
    assert clamp(-1, 0, 10) == 0

def test_helpers_untouched():
    assert helper_7(2) == 14
