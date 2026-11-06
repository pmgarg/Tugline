"""N43: auto mode is selectable from the Python client (run by test/automode-surfaces.test.ts).

Environment: TUG_SERVER_URL, TUG_SERVER_TOKEN (a running `tug serve` whose mock LLM answers the
auto-mode classifier with ALLOW), TUG_TEST_WORKSPACE.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tugline_client import PERMISSION_MODES, TuglineClient, TuglineError  # noqa: E402


class AutoModeTest(unittest.TestCase):
    def test_modes_listed(self):
        self.assertEqual(PERMISSION_MODES, ("ask", "acceptEdits", "plan", "auto", "yolo"))

    def test_auto_session_runs_classifier_approved_command(self):
        asked = []
        with TuglineClient.connect(os.environ["TUG_SERVER_URL"], os.environ["TUG_SERVER_TOKEN"]) as c:
            s = c.create_session(workspace=os.environ["TUG_TEST_WORKSPACE"], mode="auto")
            self.assertEqual(s["mode"], "auto")
            r = c.prompt(s["sessionId"], "build it", on_permission=lambda req: (asked.append(req["tool"]), {"decision": "deny"})[1])
            self.assertEqual(asked, [], "the classifier approved the routine command; nobody was asked")
            self.assertTrue(os.path.exists(os.path.join(os.environ["TUG_TEST_WORKSPACE"], "py-auto.txt")))
            self.assertEqual(c.set_mode(s["sessionId"], "yolo")["value"], "yolo")
            self.assertEqual(c.set_mode(s["sessionId"], "auto")["value"], "auto")
            with self.assertRaises(ValueError):
                c.set_mode(s["sessionId"], "bypass")
            with self.assertRaises(ValueError):
                c.create_session(mode="everything")
            c.delete_session(s["sessionId"])

    def test_server_rejects_unknown_mode(self):
        with TuglineClient.connect(os.environ["TUG_SERVER_URL"], os.environ["TUG_SERVER_TOKEN"]) as c:
            with self.assertRaises(TuglineError):
                c.request("session/create", {"mode": "bypass"})


if __name__ == "__main__":
    unittest.main()
