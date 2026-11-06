"""Tugline Python thin client for `tug serve` (SPEC G6).

Standard library only. Two transports:

    # WebSocket (tug serve prints the URL and token; the token is also in TUG_SERVER_TOKEN)
    client = TuglineClient.connect("ws://127.0.0.1:7878", token)

    # stdio: start `tug serve --stdio` as a child process (no token: the pipe is private)
    client = TuglineClient.spawn(["tug", "serve", "--stdio"], cwd="/path/to/repo")

    session = client.create_session(mode="ask")
    result = client.prompt(
        session["sessionId"],
        "Fix the failing test",
        on_event=lambda event: print(event["type"]),
        on_permission=lambda request: {"decision": "allow"} if request["kind"] == "read" else {"decision": "deny"},
    )
    print(result["finalText"])
    client.close()

Permission requests without an `on_permission` handler are answered "deny":
the client never approves anything by default. The protocol is described in
src/server/protocol.ts.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import subprocess
import urllib.parse
from typing import Any, Callable, Dict, List, Optional

__all__ = ["TuglineClient", "TuglineError", "PERMISSION_MODES"]

# N43: the permission modes of every Tugline surface. "auto" uses the safety classifier;
# "yolo" is the old classifier-less mode (called "auto" before v1.2).
PERMISSION_MODES = ("ask", "acceptEdits", "plan", "auto", "yolo")


def _check_mode(mode: str) -> str:
    if mode not in PERMISSION_MODES:
        raise ValueError(f"unknown permission mode {mode!r}: use {' | '.join(PERMISSION_MODES)}")
    return mode
__version__ = "1.0.0"

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class TuglineError(Exception):
    """A JSON-RPC error returned by the server."""

    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(f"{message} (code {code})")
        self.code = code
        self.data = data


class _WebSocket:
    """Minimal RFC 6455 client: text frames, fragmentation, ping/pong, close."""

    def __init__(self, url: str, timeout: float = 30.0):
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("ws", "wss"):
            raise ValueError("URL must start with ws:// or wss://")
        port = u.port or (443 if u.scheme == "wss" else 80)
        raw = socket.create_connection((u.hostname, port), timeout=timeout)
        if u.scheme == "wss":
            raw = ssl.create_default_context().wrap_socket(raw, server_hostname=u.hostname)
        self.sock = raw
        self.sock.settimeout(None)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        host = u.hostname if u.port is None else f"{u.hostname}:{u.port}"
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("connection closed during the WebSocket handshake")
            head += chunk
        lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0] + " ":
            raise ConnectionError(f"WebSocket upgrade refused: {lines[0]}")
        headers = {l.split(":", 1)[0].strip().lower(): l.split(":", 1)[1].strip() for l in lines[1:] if ":" in l}
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != expected:
            raise ConnectionError("bad Sec-WebSocket-Accept")
        self._buf = b""

    def _read(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def recv(self) -> str:
        parts: List[bytes] = []
        while True:
            b1, b2 = self._read(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                code = struct.unpack(">H", data[:2])[0] if len(data) >= 2 else 1000
                raise ConnectionError(f"server closed the connection ({code} {data[2:].decode('utf-8', 'replace')})")
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            parts.append(data)
            if fin:
                return b"".join(parts).decode("utf-8")

    def close(self) -> None:
        try:
            self._send_frame(0x8, struct.pack(">H", 1000))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class _Stdio:
    def __init__(self, argv: List[str], cwd: Optional[str], env: Optional[Dict[str, str]]):
        self.proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)

    def send(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()

    def recv(self) -> str:
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise ConnectionError("server process exited")
            if line.strip():
                return line

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


Handler = Callable[[Dict[str, Any]], Any]


class TuglineClient:
    """JSON-RPC 2.0 client for the Tugline server protocol."""

    def __init__(self, transport: Any):
        self._t = transport
        self._next = 1
        self._results: Dict[int, Dict[str, Any]] = {}
        self.on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None
        self.on_permission: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None
        self.on_ask: Optional[Callable[[str, Optional[List[str]]], str]] = None

    # ---------------------------------------------------------------- connect

    @classmethod
    def connect(cls, url: str, token: Optional[str] = None, timeout: float = 30.0) -> "TuglineClient":
        c = cls(_WebSocket(url, timeout))
        c.request("auth", {"token": token if token is not None else os.environ.get("TUG_SERVER_TOKEN", "")})
        return c

    @classmethod
    def spawn(cls, argv: List[str], cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> "TuglineClient":
        return cls(_Stdio(argv, cwd, env))

    # ---------------------------------------------------------------- JSON-RPC

    def _send(self, method: str, params: Any, want_id: bool = True) -> int:
        msg: Dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params}
        mid = self._next
        if want_id:
            msg["id"] = mid
            self._next += 1
        self._t.send(json.dumps(msg))
        return mid

    def _dispatch(self, msg: Dict[str, Any]) -> None:
        if "method" not in msg:
            if isinstance(msg.get("id"), int):
                self._results[msg["id"]] = msg
            return
        m, p = msg["method"], msg.get("params") or {}
        if m == "session/event":
            if self.on_event:
                self.on_event(p.get("sessionId"), p.get("event"))
        elif m == "session/permission":
            answer = {"decision": "deny", "feedback": "the Python client has no approval handler"}
            if self.on_permission:
                try:
                    answer = self.on_permission(p.get("request")) or answer
                except Exception as e:  # never approve on error
                    answer = {"decision": "deny", "feedback": f"approval handler failed: {e}"}
            self._send("session/permissionReply", {"sessionId": p.get("sessionId"), "requestId": p.get("requestId"), **answer})
        elif m == "session/ask":
            text = ""
            if self.on_ask:
                try:
                    text = self.on_ask(p.get("question"), p.get("options")) or ""
                except Exception:
                    text = ""
            self._send("session/askReply", {"sessionId": p.get("sessionId"), "requestId": p.get("requestId"), "answer": text})
        elif m == "session/plan":
            self._send("session/planReply", {"sessionId": p.get("sessionId"), "requestId": p.get("requestId"), "approved": False})
        elif m == "session/elicit":
            self._send("session/elicitReply", {"sessionId": p.get("sessionId"), "requestId": p.get("requestId"), "action": "decline"})

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Send a request and process notifications until its response arrives."""
        mid = self._send(method, params or {})
        while mid not in self._results:
            self._dispatch(json.loads(self._t.recv()))
        msg = self._results.pop(mid)
        if "error" in msg:
            e = msg["error"]
            raise TuglineError(e.get("code", -1), e.get("message", "error"), e.get("data"))
        return msg.get("result")

    # ---------------------------------------------------------------- API

    def initialize(self) -> Dict[str, Any]:
        return self.request("initialize", {"client": f"tugline-python/{__version__}"})

    def create_session(self, workspace: Optional[str] = None, mode: Optional[str] = None, profile: Optional[str] = None) -> Dict[str, Any]:
        p: Dict[str, Any] = {}
        if workspace:
            p["workspace"] = workspace
        if mode:
            p["mode"] = _check_mode(mode)
        if profile:
            p["profile"] = profile
        return self.request("session/create", p)

    def prompt(self, session_id: str, text: str, on_event: Optional[Callable[[Dict[str, Any]], None]] = None, on_permission: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Run a prompt to completion. Events and approvals are handled while it runs."""
        old = (self.on_event, self.on_permission)
        if on_event:
            self.on_event = lambda sid, e: on_event(e) if sid == session_id else None
        if on_permission:
            self.on_permission = on_permission
        try:
            return self.request("session/prompt", {"sessionId": session_id, "text": text})
        finally:
            self.on_event, self.on_permission = old

    def set_mode(self, session_id: str, mode: str) -> Dict[str, Any]:
        """Switch a session's permission mode (ask | acceptEdits | plan | auto | yolo).

        Managed policy may refuse auto or yolo; the returned value is the mode now in effect."""
        return self.request("config/set", {"sessionId": session_id, "key": "permissionMode", "value": _check_mode(mode)})

    def steer(self, session_id: str, text: str) -> Dict[str, Any]:
        return self.request("session/steer", {"sessionId": session_id, "text": text})

    def abort(self, session_id: str) -> Dict[str, Any]:
        return self.request("session/abort", {"sessionId": session_id})

    def list_sessions(self, workspace: Optional[str] = None) -> Dict[str, Any]:
        return self.request("session/list", {"workspace": workspace} if workspace else {})

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        return self.request("session/delete", {"sessionId": session_id})

    def checkpoints(self, session_id: str) -> List[Dict[str, Any]]:
        return self.request("checkpoints/list", {"sessionId": session_id})["checkpoints"]

    def jobs(self, session_id: str) -> List[Dict[str, Any]]:
        return self.request("jobs/list", {"sessionId": session_id})["jobs"]

    def close(self) -> None:
        self._t.close()

    def __enter__(self) -> "TuglineClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
