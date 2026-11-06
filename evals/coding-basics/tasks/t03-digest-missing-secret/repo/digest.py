import hashlib
import hmac
import os


def digest(message: str) -> str:
    """HMAC-SHA256 of message using the DIGEST_SECRET environment variable."""
    secret = os.environ.get("DIGEST_SECRET", "")
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()[:16]
