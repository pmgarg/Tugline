---
name: git-workflow
description: Use when asked to commit, branch, write a commit message, prepare a pull request description, or inspect history.
---
- Inspect first: `git status`, `git diff`, `git log --oneline -10` to match the repository's message style.
- Never commit secrets (.env, keys, tokens) or large generated artefacts; check the staged file list before committing.
- Stage specific files (`git add path ...`), not `git add -A`, unless the user asked to commit everything.
- Commit messages: imperative summary ≤ 72 chars, blank line, then why/what. Reference issue numbers the user mentioned.
- Do not rewrite published history (no force push, no rebase of pushed branches) and do not `git push` unless the user explicitly asks — pushing publishes the change and always requires the user's approval.
- For a PR description: summary, motivation, list of changes, how it was tested, risks/rollback.
