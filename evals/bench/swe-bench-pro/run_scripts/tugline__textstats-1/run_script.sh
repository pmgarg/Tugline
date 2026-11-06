#!/bin/bash
# Same contract as SWE-bench_Pro-os run_scripts/<instance>/run_script.sh: the selected test files
# come as one comma-separated argument; output is parsed by parser.py.
cd /app
IFS=',' read -r -a FILES <<< "$1"
python3 -m unittest -v "${FILES[@]}"
