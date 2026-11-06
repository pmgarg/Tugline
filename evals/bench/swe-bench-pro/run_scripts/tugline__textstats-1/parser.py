"""Same contract as SWE-bench_Pro-os run_scripts/<instance>/parser.py:
parser.py <stdout file> <stderr file> <output.json> → {"tests": [{"name", "status"}]}."""
import json
import re
import sys

text = open(sys.argv[1]).read() + "\n" + open(sys.argv[2]).read()
tests = []
for m in re.finditer(r"^(\w+) \(([\w.]+)\.(\w+)\.\w+\) \.\.\. (ok|FAIL|ERROR|skipped.*)$", text, re.M):
    name, module, cls, outcome = m.groups()
    status = {"ok": "PASSED", "FAIL": "FAILED", "ERROR": "FAILED"}.get(outcome, "SKIPPED")
    tests.append({"name": f"{module.replace('.', '/')}.py::{cls}::{name}", "status": status})
json.dump({"tests": tests}, open(sys.argv[3], "w"), indent=1)
