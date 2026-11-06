---
name: python-bugfix
description: Use when a pytest/unittest run fails and Python code must be fixed. Load it before editing anything; it carries the rule that separates a real fix from a green suite.
---
Work from the failure, not from the file.

1. Run the failing test command first and read the traceback bottom-up. Note the exact assertion, expected vs actual values, and the file:line where it was raised.
2. Locate the code under test with grep (function/class name), then read only that range with read_file.
3. Form one hypothesis that explains the failure. Check it against the docstring / spec / test intent.
4. Fix the code with a minimal edit_file. Keep the public behaviour the tests describe.
5. Re-run the SAME test command. Then run the whole suite once to catch regressions.

Rules:
- **Change the code, never the test.** Do not delete, skip (`@pytest.mark.skip`), weaken assertions, or wrap the call in try/except inside a test. If a test looks wrong, leave it failing and say so in your answer. The harness refuses edits to protected test paths anyway.
- **Read before you edit.** Edits to unread files are refused.
- **Do not remove a feature to make a check pass.** Removing the code that fails is not a fix.
- **Stop after four.** If the same command fails four times in a row without converging, stop and report what you tried and what you think the cause is.
- If the fix needs something unavailable (a secret, network, a missing service), do not fake it. Report that the task cannot be completed in this environment and why.
