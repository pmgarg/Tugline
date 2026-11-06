import hashlib
from auth.passwords import hash_password, verify_password


def test_new_hash_verifies():
    assert verify_password("pw", hash_password("pw"))


def test_old_work_factor_still_verifies():
    salt = bytes(16)
    old = "pbkdf2$1000$" + salt.hex() + "$" + hashlib.pbkdf2_hmac("sha256", b"pw", salt, 1000).hex()
    assert verify_password("pw", old)
    assert not verify_password("nope", old)
