#!/bin/bash
# Harbor verifier: runs inside the task container after the agent, with this directory at /tests,
# and writes the reward to /logs/verifier/reward.txt. Official tasks install pytest with uv (network);
# this sample also works offline: pytest if present, else the same test_* functions with a tiny runner.
mkdir -p /logs/verifier
cd /app
if python3 -c 'import pytest' 2>/dev/null; then
  python3 -m pytest /tests/test_outputs.py -rA -q -p no:cacheprovider && ok=1 || ok=0
else
  python3 - /tests/test_outputs.py <<'PY' && ok=1 || ok=0
import importlib.util, sys, traceback
spec = importlib.util.spec_from_file_location("test_outputs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
failed = 0
for name in sorted(n for n in dir(mod) if n.startswith("test_")):
    try:
        getattr(mod, name)()
        print(f"PASSED {name}")
    except Exception:
        failed += 1
        print(f"FAILED {name}")
        traceback.print_exc()
sys.exit(1 if failed else 0)
PY
fi
echo "$ok" > /logs/verifier/reward.txt
