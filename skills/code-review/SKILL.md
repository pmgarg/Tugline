---
name: code-review
description: Use when asked to review code, a diff, a pull request or recent changes for bugs, security issues and quality.
---
1. Get the change set: `git diff` / `git diff --staged` / `git log -p -1`, or the files the user named. Read surrounding code for context, not just the diff lines.
2. Review in this priority order and report only real, concrete findings:
   - Correctness: logic errors, off-by-one, null/undefined handling, error paths, concurrency, resource leaks.
   - Security: injection (SQL/shell/HTML), path traversal, secrets in code, unsafe deserialization, missing auth checks, SSRF.
   - Behaviour changes not covered by tests; tests that assert too little.
   - Performance problems with real impact.
   - Readability/maintainability only if significant.
3. For each finding give: file:line, severity (high/medium/low), what breaks and a concrete failing scenario, and a suggested fix.
4. If you can, prove a finding by running a test or a small script. Mark findings you could not verify as "plausible".
5. Do not edit files unless the user asked for fixes. Say clearly if you found nothing significant.
