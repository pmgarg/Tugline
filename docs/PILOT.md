# Company pilot: Tugline vs Cline (and others) on your own model

This is the protocol for a pilot that compares Tugline with another agent on your own model and tasks. The question it answers:

> *For our company's model, repositories and engineering workflows, this harness produces more verified results with less developer supervision.*

A pilot that follows this page gives a paired, same-model comparison with uncertainty. A number from anything looser is anecdote: different models, different endpoints, tasks the harness was tuned on, or one repeat. `tug bench --compare --pilot pilot.json` checks the protocol mechanically and evaluates the target you declared in advance (§7).

## 1. What is held fixed

Every arm gets exactly the same:

| Held fixed | How | Checked by `--compare --pilot` |
|---|---|---|
| **Model weights and quantisation** | One checkpoint and quantisation for every arm. Record the file hash (`sha256sum model.gguf`) or the served model's revision in `pilot.json` → `model`. | same `model` in every run; `model.sha256` and `model.quant` declared |
| **Endpoint** | One OpenAI-compatible server process (llama.cpp, vLLM, Ollama…) with the same flags (`model.server`). External agents reach it through Tugline's metering proxy (`{{base_url}}`), so tokens and calls are counted the same way for every arm. | same `baseUrl` in every run |
| **Chat template** | The server's template, unchanged during the pilot (`model.chatTemplate`: name or file hash). | declared |
| **Context and generation budget** | One context window and max output for every arm: on the server, in the Tugline profile (`contextWindow`, `maxOutputTokens`), and with each external tool's equivalent where it has one. | same `contextWindow` and `maxOutputTokens` in every run; equal to `model.contextWindow` if declared |
| **Sampling** | One temperature / top-p for every arm. | same `temperature` in every run |
| **Wall-clock budget per task** | One `timeout_s` per task, and `agent.maxTurns` for Tugline. External presets pass `{{timeout_s}}` where the tool supports it. | (task.json) |
| **Repos and instructions** | Byte-identical task workspaces (the runner copies the fixture fresh for every run) and the same prompt text. | (runner) |
| **Harness prompts** | Each harness's own system prompt is part of its arm. Tugline records it from the agent, and external agents from the first request the metering proxy sees. Every run carries its sha256, and the text is saved once per arm in `<out>/prompts/<arm>.txt`. Keep these files with the results. | every arm has `systemPromptSha` |
| **Judge** | Hidden acceptance tests that no arm can see or edit, run by the scorer **outside the agent runtime** after the agent has ended. Protected files are restored from the task source before acceptance (R1), and with `--isolation docker` the tests reach the container only then (G5). | every run has an acceptance result; host-isolated runs are flagged |

## 2. Tasks

- **Start with 30–50 tasks, and grow to 100+.** Draw them from real tickets of the last 3–6 months: bug fixes with a failing test, small features with acceptance tests, refactors with a behaviour-preserving check, and config/CI fixes. Write each as an eval task (`task.json` + `repo/` + hidden `acceptance`; see `evals/coding-basics`). At 30 held-out tasks a sign test only detects large differences (about an 8–2 split of the tasks that differ). At 100+ it detects differences of a few points. The report warns below `targetTasks` (default 100) and fails below `minTasks` (default 30).
- **Held-out split.** Split the tasks **before anyone looks at results**: about 70% development, 30% held-out. List the held-out ids in `pilot.json` → `heldOut`. Prompts, skills, presets and settings may be tuned on development tasks only. **The decision uses the held-out tasks only.** The report shows development tasks in a separate section and never uses them for the verdict.
- Include 3–5 tasks with **ambiguity** (an under-specified ticket), 3–5 with a **misleading symptom**, and 2–3 that are **not solvable** as stated (missing access, contradictory requirements). These measure false success.
- For each task, record what a developer would have to do to finish it if the agent stopped. This is used for "interventions" (§5).

## 3. Arms

| Arm | What | Role |
|---|---|---|
| `default` | Tugline as shipped | candidate |
| `cline` | **the company's installed Cline CLI** (`cline` on PATH; its `--version` is recorded) | baseline |
| `cline-pinned` | **a pinned current Cline release** (`npx -y cline@3.0.74`, `CLINE_PINNED` in `src/core/eval/external.ts`; override with `"pin"`) | baseline (current) |
| `mini-swe-agent` | a ~100-line bash-only agent | control |
| `aider`, `openhands`, `codex` | optional further baselines | – |
| `oh-full`, `oh-no-planner`, `oh-no-reviewer`, `oh-no-subagents`, `oh-no-code-mode`, `oh-simple` | **ablations** (§3.1) | ablation |

`--arm pilot` expands to `default,cline,cline-pinned,mini-swe-agent`, and `--arm ablations` to the six ablation arms. Running both the installed and the pinned Cline separates "Tugline vs Cline" from "our Cline install is old".

The external presets are user-run: install each tool first (`npm install -g cline`, `aider-install`, `uv tool install openhands`, `npm install -g @openai/codex`, `pip install mini-swe-agent`), and check its flags against `<tool> --help`. **mini-swe-agent is the control.** A harness that does not beat it on the same model has not earned its complexity.

**Equal tuning effort.** Every arm gets the same time for prompt, skill and settings work, done on development tasks only: the Tugline profile and skills, Cline's rules and settings, mini-swe-agent's config. Declare the hours per arm in `pilot.json` → `arms.<arm>.tuningHours` (with `tuningNotes`). The report fails the check if the hours are more than 25% apart.

### 3.1 Ablations: is each piece of Tugline worth it?

Each switch turns one feature off on the same model and tasks:

| Feature | Off means |
|---|---|
| planner | no `todo_write` / `exit_plan_mode` tools, no D10 planner routing |
| reviewer | no fresh-context validator subagent before finishing (`agent.autoValidate: false`) |
| subagents | no `task` tool |
| Code Mode | `codeMode.enabled: false` (N21). **Until N21 is merged this switch is recorded but changes nothing.** |

`oh-full` has every feature on, `oh-no-<x>` turns one off, and `oh-simple` turns all of them off (a read/edit/bash loop). The paired report's ablation table gives resolved and Δ (percentage points) vs `oh-full`. A feature whose removal does not lower verified resolution (within its interval) is a candidate for removal, or for off-by-default.

## 4. Runs

- **≥ 3 repeats** of every task × arm × condition (`--repeats 3`). Model outputs vary between runs, so single runs are noise. The report fails below `minRepeats` (default 3).
- **Interleave** arms (task-major order, which is what the runner does), so endpoint drift and thermal state affect every arm alike.
- **Contention conditions.** Run the whole matrix under both:
  1. **quiet** (single user): the endpoint serves only the pilot (`--condition quiet`, the default);
  2. **shared** (shared server): realistic load. `--load N` starts N synthetic clients that keep sending ~1.5k-token chat requests to the same endpoint for the whole run (`--load-prompt-tokens` sets their size), and each run's manifest records the condition, the clients and the load requests served. Pick N from the real number of concurrent users, and set `--gpu-share` to the share the pilot measured.

  Latency claims hold only under the condition they were measured in. The verdict needs the target met under **every** declared condition (`pilot.json` → `conditions`, default `quiet` + `shared`).
- **Isolation.** Use `--isolation docker` for benchmark tasks, so hidden tests stay unreachable. For company repos, run the agents inside a dev container, or check that the protected paths cover the judge.

```bash
# fixed before any run: pilot.json with declaredAt, heldOut, arms.*.tuningHours and target (§7)
tug bench suite --data pilot/ --arm pilot --repeats 3 --condition quiet --pilot pilot.json --out pilot-results/quiet
tug bench suite --data pilot/ --arm pilot --repeats 3 --load 8 --gpu-share 0.35 --pilot pilot.json --out pilot-results/shared
tug bench suite --data pilot/ --arm ablations --repeats 3 --out pilot-results/ablations
tug bench --compare pilot-results/quiet,pilot-results/shared --pilot pilot.json --out pilot-results/PILOT.md
```

## 5. What is measured (per arm, per condition)

| Metric | Definition |
|---|---|
| **Verified resolution** | The hidden acceptance check passed (`outcome = pass`), as a % of all runs, with a **95% Wilson interval**. Runs that never reached the model count as failures; they are never silently dropped. |
| **False success** | The check failed, but the agent's final message claimed success, as a % of runs (Wilson). |
| **Self-verified** | Resolved, and the agent ran the task's own check after its last edit (Tugline arms only; external agents' commands are not visible). |
| **Integrity violations** | A protected file (the judge) changed, or a write to it was attempted and refused. |
| **Edit retries / corruption** | Failed edit tool calls; files left syntactically broken (A9 edit metrics). Not visible for external agents. |
| **Interventions** | Manual: the steps a developer needed to finish or correct the result (0 = merge as is). Score them blind to the arm. |
| **Latency** | p50 / p95 wall seconds per run. |
| **Tokens** | p50 / p95 prompt + completion tokens per run, metered at the endpoint. |
| **GPU-seconds per resolved task** | Σ(wall seconds × gpuShare) / resolved runs. **This is the cost unit for a local model:** `$0` per token does not mean free. |
| **Recovery** | Of runs that hit an error (failed command, failed edit), the share that still resolved. |

**Paired comparison.** The per-task table and "arm vs baseline" rows give wins, losses and ties over tasks (pass rate over repeats), and a two-sided exact **sign test** on the tasks that differ.

## 6. Decision rule

Replace or complement Cline only if, **on the held-out tasks, under every condition**:

1. verified resolution is higher (`resolvedRate higher`);
2. its 95% interval does not sit below the baseline's point estimate (`resolvedRate ciNotBelow`);
3. the false-success rate is no higher (`falseSuccessRate notHigher`);
4. there are no integrity violations (`integrity max 0`);
5. GPU-seconds per resolved task are no more than 1.5× the baseline's (`gpuSecondsPerResolved ratioMax 1.5`);
6. median interventions are no higher (manual; record it next to the report).

Otherwise keep Cline and fix what the per-task table shows. These rules are the default `target.rules` (`DEFAULT_PILOT_RULES` in `src/core/eval/compare.ts`). You may declare others, but **before** the runs.

## 7. The predeclared target: `pilot.json`

```json
{
  "name": "Q4 pilot: Tugline vs Cline on qwen3.6-27b",
  "declaredAt": "2026-11-02T09:00:00Z",
  "model": { "weights": "qwen3.6-27b-instruct-q4_k_m.gguf", "sha256": "…", "quant": "Q4_K_M", "chatTemplate": "chatml (tokenizer_config rev 3f2a…)", "server": "llama-server -c 32768 -np 4 --jinja …", "contextWindow": 32768, "maxOutputTokens": 4096, "temperature": 0.2 },
  "arms": {
    "default": { "role": "candidate", "tuningHours": 6, "tuningNotes": "profile + 2 skills, on dev tasks" },
    "cline": { "role": "baseline", "tuningHours": 6, "tuningNotes": ".clinerules on dev tasks" },
    "cline-pinned": { "role": "baseline", "tuningHours": 6 },
    "mini-swe-agent": { "role": "control", "tuningHours": 6 }
  },
  "heldOut": ["t017", "t021", "…"],
  "minTasks": 30, "targetTasks": 100, "minRepeats": 3,
  "conditions": ["quiet", "shared"],
  "target": { "candidate": "default", "baseline": "cline-pinned", "rules": [] }
}
```

`declaredAt` must be earlier than the first run; the report fails the "target predeclared" check otherwise. The file's sha256 is printed in the report, and `tug bench --pilot` copies the file next to the results, so a later edit is visible. Empty `rules` means the §6 defaults.

The report (`--compare … --pilot pilot.json`) contains:
1. **Protocol checks** (✅ / ⚠️ / ❌): same model, endpoint, context, generation budget and temperature; weights, quantisation, template and server declared; harness prompts recorded; equal tuning effort; the held-out split and its size against the minimum and the target; repeats; contention conditions; judges outside the agent runtime; target predeclared; installed and pinned Cline both present.
2. **Decision**: each rule, per condition, on held-out tasks, and a verdict. The verdict is "not established" if any condition is missing, any rule fails, or any protocol check fails.
3. Held-out results per condition, then the development tasks, separately.

## 8. Record keeping

Keep, for every condition:
- the `pilot-results/<condition>/` directories: raw `runs/*.json` and `*.external.log`, `prompts/`, `report.md`, `compare.md` and `pilot.json`;
- the model hash, the server command line, and the tool versions (from the manifests);
- N for the shared condition.

`tug rescore <dir>` and `tug bench --compare <dirs> --pilot pilot.json` regenerate every number without calling a model again. `scripts/bench-publish.sh` copies a result directory into `docs/evidence/bench/<date>/`, with its exact command.
