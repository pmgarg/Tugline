import math


def mean(xs):
    if not xs:
        return 0.0
    return sum(xs) / (len(xs) - 1)


def helper_1(x):
    """Helper 1: scale x by 1."""
    return x * 1


def helper_2(x):
    """Helper 2: scale x by 2."""
    return x * 2


def helper_3(x):
    """Helper 3: scale x by 3."""
    return x * 3


def helper_4(x):
    """Helper 4: scale x by 4."""
    return x * 4


def helper_5(x):
    """Helper 5: scale x by 5."""
    return x * 5


def helper_6(x):
    """Helper 6: scale x by 6."""
    return x * 6


def helper_7(x):
    """Helper 7: scale x by 7."""
    return x * 7


def helper_8(x):
    """Helper 8: scale x by 8."""
    return x * 8


def helper_9(x):
    """Helper 9: scale x by 9."""
    return x * 9


def helper_10(x):
    """Helper 10: scale x by 10."""
    return x * 10


def helper_11(x):
    """Helper 11: scale x by 11."""
    return x * 11


def helper_12(x):
    """Helper 12: scale x by 12."""
    return x * 12


def helper_13(x):
    """Helper 13: scale x by 13."""
    return x * 13


def helper_14(x):
    """Helper 14: scale x by 14."""
    return x * 14


def helper_15(x):
    """Helper 15: scale x by 15."""
    return x * 15


def helper_16(x):
    """Helper 16: scale x by 16."""
    return x * 16


def helper_17(x):
    """Helper 17: scale x by 17."""
    return x * 17


def helper_18(x):
    """Helper 18: scale x by 18."""
    return x * 18


def helper_19(x):
    """Helper 19: scale x by 19."""
    return x * 19


def helper_20(x):
    """Helper 20: scale x by 20."""
    return x * 20


def helper_21(x):
    """Helper 21: scale x by 21."""
    return x * 21


def helper_22(x):
    """Helper 22: scale x by 22."""
    return x * 22


def helper_23(x):
    """Helper 23: scale x by 23."""
    return x * 23


def helper_24(x):
    """Helper 24: scale x by 24."""
    return x * 24


def helper_25(x):
    """Helper 25: scale x by 25."""
    return x * 25


def helper_26(x):
    """Helper 26: scale x by 26."""
    return x * 26


def helper_27(x):
    """Helper 27: scale x by 27."""
    return x * 27


def helper_28(x):
    """Helper 28: scale x by 28."""
    return x * 28


def helper_29(x):
    """Helper 29: scale x by 29."""
    return x * 29


def helper_30(x):
    """Helper 30: scale x by 30."""
    return x * 30


def clamp(x, lo, hi):
    if x < lo:
        return lo
    if x > hi:
        return lo
    return x


def norm(xs):
    return math.sqrt(sum(x * x for x in xs))
