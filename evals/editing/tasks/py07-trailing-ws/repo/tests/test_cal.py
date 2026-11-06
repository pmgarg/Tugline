from calendar_utils import is_leap, days_in_year

def test_leap():
    assert is_leap(2000)
    assert not is_leap(1900)
    assert is_leap(2024)
    assert days_in_year(2000) == 366
