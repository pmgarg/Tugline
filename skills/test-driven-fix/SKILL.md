---
name: test-driven-fix
description: Use when implementing a feature or fixing a bug in any language where no test covers the behaviour yet. Write a failing test first, then make it pass.
---
1. Find how the project runs tests (package.json scripts, pyproject/pytest.ini, Makefile, go.mod, Cargo.toml, AGENTS.md). Run the existing suite once to learn the baseline (note pre-existing failures; do not "fix" unrelated ones).
2. Write a small, focused test that expresses the requested behaviour. Run it and confirm it FAILS for the expected reason (not an import error).
3. Implement the minimal change in the source code.
4. Run the new test, then the full suite. Iterate on the code (never weaken the new test).
5. In the final answer list: the test you added, the files changed, and the exact command + result that verified it.
Keep the test next to existing tests and in the same style/framework.
