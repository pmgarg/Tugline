"""V0.1 driver body for the Python SDK: drive `tug serve` through sdk/python/tugline_client.py.

Argv: <sdk dir> <server url> <workspace> <prompt>; the token comes in TUG_SERVER_TOKEN.
Approval prompts are relayed to the TypeScript test (which plays the human): one JSON line
`PERMISSION {...}` on stdout, the answer ("allow" | "deny") on one stdin line.
Every event is printed as `EVENT {...}`, the result as `RESULT {...}`.
"""
import json
import os
import sys

sdk, url, workspace, prompt = sys.argv[1:5]
sys.path.insert(0, sdk)
from tugline_client import TuglineClient  # noqa: E402


def on_permission(req):
    sys.stdout.write("PERMISSION " + json.dumps(req) + "\n")
    sys.stdout.flush()
    answer = sys.stdin.readline().strip()
    return {"decision": "allow" if answer == "allow" else "deny"}


def on_event(e):
    sys.stdout.write("EVENT " + json.dumps(e) + "\n")
    sys.stdout.flush()


with TuglineClient.connect(url, os.environ["TUG_SERVER_TOKEN"]) as c:
    c.initialize()
    s = c.create_session(workspace=workspace)
    r = c.prompt(s["sessionId"], prompt, on_event=on_event, on_permission=on_permission)
    sys.stdout.write("RESULT " + json.dumps(r) + "\n")
    sys.stdout.flush()
