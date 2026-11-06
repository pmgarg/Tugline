"""Tests for the Python client against a running `tug serve` (SPEC G6 AC2).

Run by test/platform-sdk.test.ts, which starts `tug serve` with a mock LLM and sets:
  TUG_SERVER_URL, TUG_SERVER_TOKEN   the WebSocket server
  TUG_STDIO_ARGV                    JSON argv that starts `tug serve --stdio`
  TUG_TEST_WORKSPACE                a workspace directory
The mock LLM answers "PY-OK" after one bash call that the test approves.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tugline_client import TuglineClient, TuglineError  # noqa: E402


class WebSocketClientTest(unittest.TestCase):
    def test_prompt_events_and_permission(self):
        events, asked = [], []
        with TuglineClient.connect(os.environ["TUG_SERVER_URL"], os.environ["TUG_SERVER_TOKEN"]) as c:
            self.assertEqual(c.initialize()["server"], "tugline")
            s = c.create_session(workspace=os.environ["TUG_TEST_WORKSPACE"], mode="ask")
            r = c.prompt(
                s["sessionId"],
                "run the check",
                on_event=lambda e: events.append(e["type"]),
                on_permission=lambda req: (asked.append(req["tool"]), {"decision": "allow"})[1],
            )
            self.assertEqual(r["stopReason"], "end_turn")
            self.assertIn("PY-OK", r["finalText"])
            self.assertEqual(asked, ["bash"])
            for t in ("run_start", "tool_start", "tool_end", "run_end"):
                self.assertIn(t, events)
            self.assertTrue(os.path.exists(os.path.join(os.environ["TUG_TEST_WORKSPACE"], "py-made.txt")))
            self.assertEqual(c.delete_session(s["sessionId"]), {"deleted": True})

    def test_wrong_token_is_rejected(self):
        with self.assertRaises((TuglineError, ConnectionError)):
            TuglineClient.connect(os.environ["TUG_SERVER_URL"], "wrong-token")

    def test_no_handler_means_deny(self):
        with TuglineClient.connect(os.environ["TUG_SERVER_URL"], os.environ["TUG_SERVER_TOKEN"]) as c:
            s = c.create_session(workspace=os.environ["TUG_TEST_WORKSPACE"], mode="ask")
            r = c.prompt(s["sessionId"], "run the check again")
            self.assertEqual(r["stats"]["refusals"], 1)


class StdioClientTest(unittest.TestCase):
    def test_stdio(self):
        argv = json.loads(os.environ["TUG_STDIO_ARGV"])
        with TuglineClient.spawn(argv, cwd=os.environ["TUG_TEST_WORKSPACE"]) as c:
            s = c.create_session(mode="yolo")
            r = c.prompt(s["sessionId"], "run the check over stdio")
            self.assertIn("PY-OK", r["finalText"])


if __name__ == "__main__":
    unittest.main()
