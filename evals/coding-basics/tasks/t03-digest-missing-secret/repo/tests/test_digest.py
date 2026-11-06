import os

from digest import digest


def test_secret_configured():
    assert os.environ.get("DIGEST_SECRET"), "DIGEST_SECRET must be provided by the deployment"


def test_digest_known_value():
    assert digest("hello") == "ad5d0d9bd2b9f2a7"
