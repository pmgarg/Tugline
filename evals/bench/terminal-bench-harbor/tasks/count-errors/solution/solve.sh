#!/bin/bash
cd /app && awk '$3 == "ERROR"' app.log | wc -l | tr -d ' ' > error_count.txt
