import auth.session as s


def test_activity_extends_the_session(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(s.time, "time", lambda: now[0])
    tok = s.start_session("u1")
    now[0] += 20 * 60
    assert s.current_user(tok) == "u1"
    now[0] += 20 * 60
    assert s.current_user(tok) == "u1", "still active: 20 minutes since the last request"
    now[0] += 31 * 60
    assert s.current_user(tok) is None
