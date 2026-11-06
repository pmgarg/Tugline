#!/bin/bash
# Terminal-bench runs this inside the task container (tug bench --isolation docker does too, after the agent).
# The official tasks install pytest with uv; this sample works offline: pytest when the image or host has it,
# else the same test_* functions run by a minimal runner (the task image has python3 but no pytest).
set -e
if python3 -c 'import pytest' 2>/dev/null; then
  python3 -m pytest "$TEST_DIR/test_outputs.py" -rA -q -p no:cacheprovider
else
  python3 - "$TEST_DIR/test_outputs.py" <<'PY'
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
