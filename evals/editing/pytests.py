"""Test runner for the Python tasks of the editing eval (SPEC A9; v1.1 R7).

With pytest installed, this runs `python3 -m pytest <args>` unchanged, so the
acceptance check is exactly what it always was. Without pytest (the active
Python on a fresh macOS has none), it falls back to a minimal runner. That is
enough for these fixtures, which use only plain `def test_*()` functions (and
`Test*` classes) with bare asserts. A test that needs a pytest fixture fails
with a message saying to install pytest, so nothing passes by accident.

Exit codes follow pytest: 0 all passed, 1 failures, 2 collection error,
5 nothing collected. TUG_MINI_PYTEST=1 forces the fallback (used by the suite's tests).
Copied into every Python task repo as .oh-eval/pytests.py (protected).
"""
import importlib.util
import inspect
import os
import subprocess
import sys
import traceback


def have_pytest():
    try:
        return importlib.util.find_spec("pytest") is not None
    except Exception:  # a broken or blocked install counts as missing
        return False


args = sys.argv[1:]
if os.environ.get("TUG_MINI_PYTEST") != "1" and have_pytest():
    # subprocess rather than os.execv: on Windows execv does not keep the exit code.
    sys.exit(subprocess.call([sys.executable, "-m", "pytest", *args]))

paths = [a for a in args if not a.startswith("-")] or ["."]
files = []
for p in paths:
    if os.path.isfile(p):
        files.append(p)
        continue
    for d, subdirs, names in os.walk(p):
        subdirs[:] = sorted(s for s in subdirs if not s.startswith(".") and s != "__pycache__")
        files += [os.path.join(d, n) for n in sorted(names) if n.endswith(".py") and (n.startswith("test_") or n.endswith("_test.py"))]

# Like `python -m pytest` (cwd on sys.path) with the default "prepend" import mode (the test file's folder too).
sys.path.insert(0, os.getcwd())
passed = failed = errors = 0
for i, f in enumerate(files):
    folder = os.path.dirname(os.path.abspath(f))
    if folder not in sys.path:
        sys.path.insert(0, folder)
    try:
        spec = importlib.util.spec_from_file_location(f"_oh_test_{i}", f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception:
        errors += 1
        print(f"ERROR collecting {f}")
        traceback.print_exc()
        continue
    cases = []
    for name, obj in list(vars(mod).items()):
        if name.startswith("test") and inspect.isfunction(obj) and obj.__module__ == mod.__name__:
            cases.append((name, obj))
        elif name.startswith("Test") and inspect.isclass(obj) and obj.__module__ == mod.__name__:
            for m, fn in vars(obj).items():
                if m.startswith("test") and inspect.isfunction(fn):
                    cases.append((f"{name}::{m}", (lambda c=obj, m=m: getattr(c(), m)())))
    for name, fn in cases:
        need = [p for p in inspect.signature(fn).parameters.values() if p.default is inspect.Parameter.empty]
        if need:
            failed += 1
            print(f"FAILED {f}::{name} - needs pytest fixture(s) {', '.join(p.name for p in need)}: install pytest (python3 -m pip install pytest)")
            continue
        try:
            fn()
            passed += 1
        except Exception:
            failed += 1
            print(f"FAILED {f}::{name}")
            traceback.print_exc()

print(f"{failed} failed, {passed} passed" + (f", {errors} errors" if errors else "") + " (built-in runner: pytest is not installed)")
if errors:
    sys.exit(2)
if failed:
    sys.exit(1)
sys.exit(0 if passed else 5)
