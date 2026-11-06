"""Login sessions."""
import secrets
import time

SESSION_TTL = 30 * 60
_sessions: dict[str, dict] = {}


def start_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    _sessions[token] = {"user": user_id, "expires": time.time() + SESSION_TTL}
    return token


def current_user(token: str) -> str | None:
    s = _sessions.get(token)
    if not s or s["expires"] < time.time():
        _sessions.pop(token, None)
        return None
    return s["user"]


def logout(token: str) -> None:
    _sessions.pop(token, None)
