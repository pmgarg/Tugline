"""Integrity check for the editing eval (SPEC A9 "corrupted-file" metric).

Fails when the agent's edit changed bytes it had no reason to touch:
  - the UTF-8 BOM appeared or disappeared,
  - the line-ending style changed (e.g. CRLF file now LF or mixed),
  - the final newline appeared or disappeared,
  - more than `slack` lines changed outside the windows around the intended change.
Copied into every task repo as .oh-eval/intact.py (protected); data in .oh-eval/intact.json.
"""
import base64
import difflib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = json.load(open(os.path.join(HERE, "intact.json")))
root = os.path.dirname(HERE)


def eol(b):
    crlf = b.count(b"\r\n")
    lf = b.count(b"\n") - crlf
    if crlf and lf:
        return "mixed"
    return "crlf" if crlf else ("lf" if lf else "none")


bad = []
for f in spec["files"]:
    orig = base64.b64decode(f["original"])
    p = os.path.join(root, f["path"])
    if not os.path.exists(p):
        bad.append(f"{f['path']}: deleted")
        continue
    cur = open(p, "rb").read()
    bom = b"\xef\xbb\xbf"
    if orig.startswith(bom) != cur.startswith(bom):
        bad.append("%s: BOM %s" % (f["path"], "removed" if orig.startswith(bom) else "added"))
    if eol(orig) != "none" and eol(cur) != eol(orig):
        bad.append(f"{f['path']}: line endings changed from {eol(orig)} to {eol(cur)}")
    if orig.endswith(b"\n") != cur.endswith(b"\n"):
        bad.append("%s: final newline %s" % (f["path"], "removed" if orig.endswith(b"\n") else "added"))
    a = orig.split(b"\n")
    b = cur.split(b"\n")
    wins = f["windows"]
    outside = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        span = range(i1, max(i2, i1 + 1))
        if not any(w[0] <= k <= w[1] for k in span for w in wins):
            outside += max(i2 - i1, j2 - j1)
    if outside > f.get("slack", 2):
        bad.append(f"{f['path']}: {outside} line(s) changed outside the edited region")

if bad:
    print("INTEGRITY FAILED: " + "; ".join(bad))
    sys.exit(1)
print("integrity ok")
