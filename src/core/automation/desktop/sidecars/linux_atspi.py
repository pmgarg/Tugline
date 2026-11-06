#!/usr/bin/env python3
"""Tugline Linux desktop sidecar (SPEC F9; research CU §2.3, §5.5).

JSON-RPC 2.0 over stdio, one JSON object per line (NDJSON). Exits on stdin EOF,
so killing the harness kills input (research CU §4 kill switch).

  tree     AT-SPI2 via gi.repository.Atspi (GTK, Qt with QT_ACCESSIBILITY=1,
           Firefox, LibreOffice, Electron with --force-renderer-accessibility)
  actions  AT-SPI semantic actions first (do_action, set_text_contents,
           grab_focus: Wayland-safe), xdotool on X11 for keys, typing and
           pointer clicks
  pixels   ImageMagick `import` (X11) or `grim` (wlroots)

Element tokens are scoped to the latest snapshot of their window: a token
from an older snapshot returns error data {"code": "stale_element_token"}.

Same methods as windows_uia.ps1: ping health list_apps list_windows snapshot act
set_value type_text press_key menu scroll pointer screenshot clipboard launch
activate quit shutdown.
"""
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import time

VERSION = "1.0.0"

try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi  # noqa: E402

    IMPORT_ERROR = None
except Exception as e:  # pragma: no cover - reported through health
    Atspi = None
    IMPORT_ERROR = str(e)


class RpcError(Exception):
    def __init__(self, message, code=None, rpc_code=-32000):
        super().__init__(message)
        self.data_code = code
        self.rpc_code = rpc_code


MAX_ELEMENTS = 3000
MAX_DEPTH = 60
SNAP = {"seq": 0}
# window_id -> {"snap": n, "tokens": {token: accessible}}
CACHE = {}
LAUNCHED = {}


def need_atspi():
    if Atspi is None:
        raise RpcError("python gi / Atspi is not available: %s (apt install python3-gi gir1.2-atspi-2.0 at-spi2-core)" % IMPORT_ERROR, "unavailable")


def desktop():
    need_atspi()
    return Atspi.get_desktop(0)


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def children(acc):
    n = safe(acc.get_child_count, 0) or 0
    out = []
    for i in range(min(n, 2000)):
        c = safe(lambda: acc.get_child_at_index(i))
        if c is not None:
            out.append(c)
    return out


def states(acc):
    ss = safe(acc.get_state_set)
    if ss is None:
        return set()
    names = set()
    for name in ("ACTIVE", "SHOWING", "VISIBLE", "ICONIFIED", "ENABLED", "SENSITIVE", "SELECTED", "FOCUSED", "CHECKED", "EXPANDED", "EXPANDABLE", "EDITABLE", "CHECKABLE", "PRESSED"):
        st = getattr(Atspi.StateType, name, None)
        if st is not None and safe(lambda: ss.contains(st), False):
            names.add(name)
    return names


def extents(acc, coord):
    comp = safe(acc.get_component_iface)
    if comp is None:
        return None
    r = safe(lambda: comp.get_extents(coord))
    if r is None:
        return None
    return {"x": r.x, "y": r.y, "width": r.width, "height": r.height}


WINDOW_ROLES = ("frame", "window", "dialog", "alert", "file chooser")


def app_list():
    out = []
    for i, app in enumerate(children(desktop())):
        out.append((i, app))
    return out


def app_info(app):
    return {
        "name": safe(app.get_name, "") or "",
        "pid": safe(app.get_process_id),
        "toolkit": safe(app.get_toolkit_name),
        "running": True,
    }


def windows(app_filter=None):
    out = []
    for ai, app in app_list():
        name = safe(app.get_name, "") or ""
        pid = safe(app.get_process_id)
        if app_filter and app_filter.lower() not in (name.lower(), str(pid)):
            continue
        for wi, w in enumerate(children(app)):
            role = safe(w.get_role_name, "") or ""
            if role not in WINDOW_ROLES:
                continue
            st = states(w)
            out.append({
                "window_id": "%s:%s:%s" % (pid, ai, wi),
                "pid": pid,
                "app": name,
                "title": safe(w.get_name, "") or "",
                "focused": "ACTIVE" in st,
                "on_screen": "SHOWING" in st or "VISIBLE" in st,
                "minimized": "ICONIFIED" in st,
                "bounds": extents(w, Atspi.CoordType.SCREEN),
                "toolkit": safe(app.get_toolkit_name),
                "_acc": w,
            })
    return out


def find_window(window_id):
    for w in windows():
        if w["window_id"] == window_id:
            return w
    # The app index can shift when other apps start/stop: fall back to pid + window index.
    try:
        pid, _ai, wi = window_id.split(":")
        for w in windows():
            p, _a, i = w["window_id"].split(":")
            if p == pid and i == wi:
                return w
    except ValueError:
        pass
    raise RpcError("window %s not found" % window_id, "window_target_not_found")


def public(w):
    return {k: v for k, v in w.items() if not k.startswith("_")}


def element_value(acc, role):
    # Interface methods are called through the interface class: Accessible has a
    # deprecated get_text() of its own that shadows Text.get_text().
    t = safe(acc.get_text_iface)
    if t is not None and role in ("text", "entry", "password text", "editable text", "terminal", "spin button", "combo box", "paragraph"):
        n = safe(lambda: Atspi.Text.get_character_count(acc), 0) or 0
        if n:
            return safe(lambda: Atspi.Text.get_text(acc, 0, min(n, 4000)))
        return ""
    v = safe(acc.get_value_iface)
    if v is not None:
        cur = safe(lambda: Atspi.Value.get_current_value(acc))
        if cur is not None:
            return ("%g" % cur)
    return None


def action_names(acc):
    a = safe(acc.get_action_iface)
    if a is None:
        return []
    n = safe(a.get_n_actions, 0) or 0
    return [safe(lambda: a.get_action_name(i), "") or "" for i in range(n)]


def snapshot(window_id):
    w = find_window(window_id)
    SNAP["seq"] += 1
    snap = SNAP["seq"]
    tokens = {}
    elements = []

    def visit(acc, parent, depth):
        if len(elements) >= MAX_ELEMENTS or depth > MAX_DEPTH:
            return
        role = safe(acc.get_role_name, "unknown") or "unknown"
        st = states(acc)
        idx = len(elements)
        token = "%d-%d" % (snap, idx)
        tokens[token] = acc
        el = {
            "index": idx,
            "parent": parent,
            "role": role,
            "name": safe(acc.get_name, "") or None,
            "description": safe(acc.get_description, "") or None,
            "value": element_value(acc, role),
            "enabled": ("SENSITIVE" in st or "ENABLED" in st) if st else None,
            "selected": "SELECTED" in st,
            "focused": "FOCUSED" in st,
            "editable": "EDITABLE" in st,
            "box": extents(acc, Atspi.CoordType.WINDOW),
            "actions": action_names(acc),
            "token": token,
        }
        if "CHECKABLE" in st or role in ("check box", "radio button", "toggle button", "check menu item", "radio menu item"):
            el["checked"] = "CHECKED" in st or "PRESSED" in st
        if "EXPANDABLE" in st:
            el["expanded"] = "EXPANDED" in st
        elements.append(el)
        for c in children(acc):
            visit(c, idx, depth + 1)

    visit(w["_acc"], None, 0)
    CACHE[window_id] = {"snap": snap, "tokens": tokens}
    return {"snapshot_id": "s%d" % snap, "window": public(w), "elements": elements, "toolkit": w.get("toolkit"), "degraded": len(elements) <= 1}


def element(window_id, token):
    c = CACHE.get(window_id)
    if c is None:
        raise RpcError("no snapshot of window %s yet" % window_id, "stale_element_token")
    if token in c["tokens"]:
        return c["tokens"][token]
    if (token or "").split("-")[0] != str(c["snap"]):
        raise RpcError("stale_element_token: %s is not from the latest snapshot (s%s) of this window" % (token, c["snap"]), "stale_element_token")
    raise RpcError("unknown element %s" % token, "element_not_found")


def have(cmd):
    return shutil.which(cmd) is not None


def run(cmd, timeout=10, input_bytes=None):
    return subprocess.run(cmd, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


def screen_center(acc):
    b = extents(acc, Atspi.CoordType.SCREEN)
    if not b:
        return None
    return (b["x"] + b["width"] // 2, b["y"] + b["height"] // 2)


def xdotool_click(x, y, button=1, repeat=1):
    if not have("xdotool") or not os.environ.get("DISPLAY"):
        raise RpcError("no pointer backend: install xdotool (X11)", "unsupported")
    run(["xdotool", "mousemove", "--sync", str(int(x)), str(int(y)), "click", "--repeat", str(repeat), str(button)])


PRESS = ("click", "press", "activate", "jump", "open", "invoke")


def do_named_action(acc, wanted):
    a = safe(acc.get_action_iface)
    if a is None:
        return False
    names = action_names(acc)
    for want in wanted:
        for i, n in enumerate(names):
            if n.lower() == want:
                return bool(a.do_action(i))
    return False


def act(p):
    acc = element(p["window_id"], p["token"])
    action = p.get("action", "press")
    if action == "focus":
        comp = safe(acc.get_component_iface)
        ok = bool(comp and comp.grab_focus())
        return {"effect": "confirmed" if ok else "unverifiable"}
    if action in ("press", "click", "select"):
        if do_named_action(acc, PRESS + (("select",) if action == "select" else ())):
            return {"effect": "unverifiable", "route": "atspi"}
    if action == "toggle" and do_named_action(acc, ("toggle", "click", "press", "activate")):
        return {"effect": "unverifiable", "route": "atspi"}
    if action == "expand" and do_named_action(acc, ("expand or contract", "expand", "open", "click", "press")):
        return {"effect": "unverifiable", "route": "atspi"}
    # Fall back to a real pointer click at the element centre (X11).
    c = screen_center(acc)
    if not c:
        raise RpcError("element has no action and no geometry", "interaction_failed")
    if action == "right_click":
        xdotool_click(c[0], c[1], 3)
    elif action == "dblclick":
        xdotool_click(c[0], c[1], 1, 2)
    else:
        xdotool_click(c[0], c[1])
    return {"effect": "unverifiable", "route": "xdotool"}


def set_value(p):
    acc = element(p["window_id"], p["token"])
    value = p.get("value", "")
    et = safe(acc.get_editable_text_iface)
    if et is not None and Atspi.EditableText.set_text_contents(acc, value):
        return {"effect": "unverifiable", "route": "atspi"}
    v = safe(acc.get_value_iface)
    if v is not None:
        try:
            if Atspi.Value.set_current_value(acc, float(value)):
                return {"effect": "unverifiable", "route": "atspi"}
        except ValueError:
            pass
    raise RpcError("element is not settable", "not_settable")


XKEYS = {"enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape", "tab": "Tab", "space": "space", "backspace": "BackSpace", "delete": "Delete", "up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next", "cmd": "super", "command": "super", "meta": "super", "win": "super", "control": "ctrl", "option": "alt"}
for _k in "0123456789":
    XKEYS[_k] = _k
XKEYS.update({"+": "plus", "-": "minus", "*": "asterisk", "/": "slash", "=": "equal", ".": "period"})


def xkey(spec):
    if spec in ("+",):
        return "plus"
    parts = [x for x in spec.replace(" ", "").split("+") if x] if spec != "+" else ["+"]
    return "+".join(XKEYS.get(x.lower(), x) for x in parts)


def focus_window(window_id):
    try:
        w = find_window(window_id)
    except RpcError:
        return
    if have("xdotool") and w.get("pid"):
        run(["xdotool", "search", "--pid", str(w["pid"]), "windowactivate", "--sync"], timeout=5)


def type_text(p):
    if p.get("token"):
        acc = element(p["window_id"], p["token"])
        comp = safe(acc.get_component_iface)
        if comp:
            comp.grab_focus()
        et = safe(acc.get_editable_text_iface)
        if et is not None and not have("xdotool"):
            pos = safe(lambda: Atspi.Text.get_caret_offset(acc), 0) or 0
            Atspi.EditableText.insert_text(acc, pos, p["text"], len(p["text"].encode("utf-8")))
            return {"effect": "unverifiable", "route": "atspi"}
    elif p.get("window_id"):
        focus_window(p["window_id"])
    if have("xdotool") and os.environ.get("DISPLAY"):
        run(["xdotool", "type", "--delay", "8", "--", p["text"]], timeout=30)
        return {"effect": "unverifiable", "route": "xdotool"}
    raise RpcError("no keyboard backend: install xdotool (X11)", "background_unavailable")


def press_key(p):
    if p.get("window_id"):
        focus_window(p["window_id"])
    keys = [k for k in p["keys"].split(" ") if k] if " " in p["keys"].strip() else [p["keys"].strip()]
    if have("xdotool") and os.environ.get("DISPLAY"):
        run(["xdotool", "key", "--delay", "20"] + [xkey(k) for k in keys])
        return {"effect": "unverifiable", "route": "xdotool"}
    raise RpcError("no keyboard backend: install xdotool (X11)", "background_unavailable")


def menu(p):
    app_name = (p.get("app") or "").lower()
    path = p.get("path") or []
    for w in windows():
        if w["app"].lower() != app_name and str(w["pid"]) != app_name:
            continue
        node = w["_acc"]
        for label in path:
            found = None
            stack = [node]
            while stack and found is None:
                cur = stack.pop(0)
                for c in children(cur):
                    r = safe(c.get_role_name, "")
                    if r in ("menu", "menu item", "check menu item", "radio menu item") and (safe(c.get_name, "") or "").strip().lower() == label.strip().lower():
                        found = c
                        break
                    if r in ("menu bar", "menu", "filler", "panel", "frame", "popup menu"):
                        stack.append(c)
            if found is None:
                raise RpcError("no menu item %r" % label, "not_found")
            do_named_action(found, ("click", "press", "activate", "open"))
            time.sleep(0.15)
            node = found
        return {"effect": "unverifiable", "route": "atspi"}
    raise RpcError("no window for app %s" % p.get("app"), "not_found")


def scroll(p):
    w = find_window(p["window_id"])
    b = w.get("bounds") or {"x": 0, "y": 0, "width": 0, "height": 0}
    cx, cy = b["x"] + b["width"] // 2, b["y"] + b["height"] // 2
    if p.get("token"):
        c = screen_center(element(p["window_id"], p["token"]))
        if c:
            cx, cy = c
    button = {"up": 4, "down": 5, "left": 6, "right": 7}[p.get("direction", "down")]
    xdotool_click(cx, cy, button, int(p.get("amount") or 3))
    return {"effect": "unverifiable", "route": "xdotool"}


def pointer(p):
    w = find_window(p["window_id"])
    b = w.get("bounds") or {"x": 0, "y": 0}
    x, y = b["x"] + p["x"], b["y"] + p["y"]
    action = p.get("action", "click")
    if action == "drag_to":
        to = p.get("to") or [p["x"], p["y"]]
        run(["xdotool", "mousemove", "--sync", str(int(x)), str(int(y)), "mousedown", "1", "mousemove", "--sync", str(int(b["x"] + to[0])), str(int(b["y"] + to[1])), "mouseup", "1"])
    else:
        xdotool_click(x, y, 3 if action == "right_click" else 1, 2 if action == "dblclick" else 1)
    return {"effect": "unverifiable", "route": "xdotool"}


def screenshot(p):
    geo = None
    if p.get("window_id"):
        geo = find_window(p["window_id"]).get("bounds")
    if have("import") and os.environ.get("DISPLAY"):
        cmd = ["import", "-silent", "-window", "root"]
        if geo:
            cmd += ["-crop", "%dx%d+%d+%d" % (geo["width"], geo["height"], max(0, geo["x"]), max(0, geo["y"]))]
        r = run(cmd + ["png:-"], timeout=20)
        if r.returncode == 0 and r.stdout:
            return {"png_base64": base64.b64encode(r.stdout).decode(), "scale": 1}
    if have("grim") and os.environ.get("WAYLAND_DISPLAY"):
        cmd = ["grim"]
        if geo:
            cmd += ["-g", "%d,%d %dx%d" % (geo["x"], geo["y"], geo["width"], geo["height"])]
        r = run(cmd + ["-"], timeout=20)
        if r.returncode == 0:
            return {"png_base64": base64.b64encode(r.stdout).decode(), "scale": 1}
    raise RpcError("no screenshot backend (ImageMagick import on X11, grim on wlroots)", "screenshot_context_missing")


def clipboard(p):
    if p.get("op") == "write":
        for cmd in (["xclip", "-selection", "clipboard"], ["xsel", "-ib"], ["wl-copy"]):
            if have(cmd[0]):
                run(cmd, input_bytes=(p.get("text") or "").encode())
                return {}
    else:
        for cmd in (["xclip", "-selection", "clipboard", "-o"], ["xsel", "-ob"], ["wl-paste", "-n"]):
            if have(cmd[0]):
                return {"text": run(cmd).stdout.decode("utf-8", "replace")}
    raise RpcError("no clipboard tool (xclip, xsel or wl-clipboard)", "unsupported")


def launch(p):
    app = p["app"]
    env = dict(os.environ)
    env.update({"QT_ACCESSIBILITY": "1", "NO_AT_BRIDGE": "0", "GTK_A11Y": "atspi"})
    env.update(p.get("env") or {})
    argv = [app] + list(p.get("args") or [])
    if not shutil.which(app) and not os.path.exists(app):
        raise RpcError("app %r not found on PATH" % app, "not_found")
    proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    LAUNCHED[proc.pid] = proc
    deadline = time.time() + float(p.get("wait_s", 8))
    while time.time() < deadline:
        if any(w["pid"] == proc.pid for w in windows()):
            return {"effect": "confirmed", "pid": proc.pid}
        if proc.poll() is not None:
            raise RpcError("%s exited with %s" % (app, proc.returncode), "launch_failed")
        time.sleep(0.2)
    return {"effect": "unverifiable", "pid": proc.pid, "summary": "launched, but no accessible window appeared yet"}


def resolve_pid(p):
    if p.get("pid"):
        return int(p["pid"])
    if p.get("window_id"):
        return int(str(p["window_id"]).split(":")[0])
    name = (p.get("app") or "").lower()
    for _i, app in app_list():
        if (safe(app.get_name, "") or "").lower() == name:
            return safe(app.get_process_id)
    return None


def activate(p):
    pid = resolve_pid(p)
    if pid and have("xdotool") and os.environ.get("DISPLAY"):
        r = run(["xdotool", "search", "--onlyvisible", "--pid", str(pid), "windowactivate", "--sync"], timeout=5)
        if r.returncode == 0:
            return {"effect": "confirmed", "route": "xdotool"}
    if have("wmctrl") and p.get("app"):
        r = run(["wmctrl", "-a", p["app"]], timeout=5)
        if r.returncode == 0:
            return {"effect": "confirmed", "route": "wmctrl"}
    return {"effect": "unverifiable", "summary": "no window manager activation available"}


def quit_app(p):
    pid = resolve_pid(p)
    if not pid:
        raise RpcError("app is not running", "not_found")
    os.kill(pid, signal.SIGTERM)
    return {"effect": "confirmed"}


def health(_p):
    out = {"ok": True, "version": VERSION, "platform": sys.platform, "permissions": {}, "tools": {k: have(k) for k in ("xdotool", "import", "grim", "xclip", "wmctrl")}}
    out["display"] = os.environ.get("DISPLAY")
    out["wayland"] = os.environ.get("WAYLAND_DISPLAY")
    if Atspi is None:
        out.update(ok=False, message="gi/Atspi unavailable: %s" % IMPORT_ERROR)
        out["permissions"]["accessibility"] = False
        return out
    try:
        n = desktop().get_child_count()
        out["permissions"]["accessibility"] = True
        out["apps"] = n
    except Exception as e:
        out.update(ok=False, message="AT-SPI bus not reachable: %s" % e)
        out["permissions"]["accessibility"] = False
    return out


METHODS = {
    "ping": lambda p: {"pong": True, "version": VERSION, "backend": "linux-atspi"},
    "health": health,
    "list_apps": lambda p: {"apps": [app_info(a) for _i, a in app_list()]},
    "list_windows": lambda p: {"windows": [public(w) for w in windows(p.get("app"))]},
    "snapshot": lambda p: snapshot(p["window_id"]),
    "act": act,
    "set_value": set_value,
    "type_text": type_text,
    "press_key": press_key,
    "menu": menu,
    "scroll": scroll,
    "pointer": pointer,
    "screenshot": screenshot,
    "clipboard": clipboard,
    "launch": launch,
    "activate": activate,
    "quit": quit_app,
}


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            reply({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        rid = req.get("id")
        method = req.get("method")
        if method == "shutdown":
            reply({"jsonrpc": "2.0", "id": rid, "result": {"ok": True}})
            break
        fn = METHODS.get(method)
        if fn is None:
            reply({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "unknown method %s" % method}})
            continue
        try:
            reply({"jsonrpc": "2.0", "id": rid, "result": fn(req.get("params") or {})})
        except RpcError as e:
            reply({"jsonrpc": "2.0", "id": rid, "error": {"code": e.rpc_code, "message": str(e), "data": {"code": e.data_code}}})
        except Exception as e:  # never die on one bad call
            reply({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "%s: %s" % (type(e).__name__, e)}})


if __name__ == "__main__":
    main()
