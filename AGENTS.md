# AGENTS.md: instructions for AI agents working on Tugline

## Layout
- `src/core/`: the library. `agent/` (loop, prompt, compaction, hooks, journal), `llm/` (OpenAI-compatible client, text tool protocol, probe), `tools/` (fs, shell, web, screenshot, meta), `permissions/policy.ts`, `skills/`, `mcp/`, `eval/`.
- `src/cli/main.ts`: the `tug` CLI.
- `vscode/`: the extension (`src/extension.ts` host, `media/main.js` webview). It bundles `src/core` with esbuild.
- `skills/`, `agents/`: bundled skills and subagents. `evals/`: evaluation suites. `test/`: node:test suites.

## Commands
- Typecheck: `npx tsc --noEmit -p .` (extension: `cd vscode && ../node_modules/.bin/tsc -p tsconfig.json`)
- Tests: `npm test` (must stay green; uses a mock OpenAI server, no network)
- Build: `npm run build` (CLI → `dist/`), `cd vscode && npm run build` (extension) / `npm run package` (.vsix)

## Rules
- Authority decisions (permissions, protected paths, budgets, thrash ceilings) live in code, never in prompts or skills. `src/core/skills/` must never import `permissions/` (a test enforces this).
- Every tool failure must come back to the model as an actionable message; the loop must never throw on model output.
- Keep the system prompt byte-stable within a run (prefix caching) and history append-only (except compaction).
- No new runtime dependencies without a strong reason (companies install this behind firewalls).
- Every bug fix comes with a test that fails before the fix.
