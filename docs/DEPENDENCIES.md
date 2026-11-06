# Runtime dependencies and licences

Rule (SPEC R4): MIT, Apache-2.0, BSD or ISC only. Optional dependencies are lazy-loaded. No GPL/AGPL. No nut.js.

## npm packages

### Required

| Package | Version | Licence | Used by |
|---|---|---|---|
| @modelcontextprotocol/client | ^2.4.0 | Apache-2.0 | v0.1 core (MCP client); also WS6 cua-driver transport |
| picomatch | ^4.0.2 | MIT | v0.1 core |
| zod | ^4.6.7 | MIT | v0.1 core |
| ws | 8.22.0 | MIT | WS7 G2/H5 `tug serve` WebSocket server and the TypeScript client (`src/server/`). Loaded lazily: imported only when serving or connecting |
| @agentclientprotocol/sdk | 1.8.0 | Apache-2.0 | WS7 G1 `tug --acp` (official Agent Client Protocol SDK by Zed Industries; peer dep zod ^3.25 \|\| ^4, satisfied). Loaded lazily, in ACP mode only. 1.8.0 pinned (published 2026-10-09); 2.x speaks the experimental v2 protocol |

### Optional (lazy `import()`)

| Package | Version | Licence | Used by |
|---|---|---|---|
| playwright | ^1.64.1 | Apache-2.0 | v0.1 `screenshot`; WS5 browser driver (falls back to `playwright-core` + system Chrome). ≥1.64 uses `ariaSnapshot({mode:'ai'})`/`getByRef`; older builds use the DOM-walk fallback |
| @opentelemetry/api | 1.9.1 | Apache-2.0 | WS8 H4 telemetry, only when `telemetry.enabled` or an OTLP endpoint env var is set. Pinned: `@opentelemetry/sdk-trace` 2.11 accepts api `<1.10` |
| @opentelemetry/sdk-trace | 2.11.0 | Apache-2.0 | WS8 H4: `TracerProvider`, `BatchSpanProcessor` (and `InMemorySpanExporter` in tests). The successor of `sdk-trace-base`, whose 2.12 is deprecated in its favour |
| @opentelemetry/resources | 2.11.0 | Apache-2.0 | WS8 H4: `service.name` resource |
| @opentelemetry/exporter-trace-otlp-http | 0.222.0 | Apache-2.0 | WS8 H4: OTLP/HTTP export (the 0.222 line pairs with sdk-trace 2.11) |
| web-tree-sitter | 0.27.1 | MIT | WS1 v1.1 G6: tree-sitter runtime (wasm) for A6 post-edit syntax checks and D7 repo-map definitions (`src/core/edit/treesitter.ts`). Without it: compiler/regex fallbacks |
| @vscode/tree-sitter-wasm | 0.3.1 | MIT (Microsoft); grammars inside: see below | WS1 G6: prebuilt grammar wasm for typescript, tsx, javascript, python, go, rust, java, css, bash (+ ruby, php, cpp, c-sharp, ini, regex, powershell, unused or repo-map only). Only the `.wasm` files are read; its own `tree-sitter.js` runtime is not used |
| tree-sitter-html | 0.23.2 | MIT | WS1 G6: `tree-sitter-html.wasm` (shipped in the package). Its `node-gyp-build` install step finds a prebuilt binding; if it fails the optional package is skipped and HTML is simply not checked |
| @tree-sitter-grammars/tree-sitter-yaml | 0.7.1 | MIT | WS1 G6: `tree-sitter-yaml.wasm` (same notes as tree-sitter-html) |
| keytar | (not installed) | MIT | WS5 E8 secrets vault uses the OS keychain when this package is present; otherwise `~/.tugline/secrets.json` (0600) |

### Development only

| Package | Version | Licence | Used by |
|---|---|---|---|
| @playwright/test | 1.64.1 | Apache-2.0 | WS5 E7 AC2 test: runs an exported spec with `npx playwright test`. Users who run exported specs install it themselves |
| @types/ws | 8.18.2 | MIT | types for `ws` |
| typescript-language-server | 6.0.2 | Apache-2.0 | WS1 v1.1 N3 tests (AC2/AC5) run a real language server. Users who enable `lsp.servers.typescript` install it themselves (`npm i -g typescript-language-server typescript`); it is never bundled |
| ajv | 8.17.1 | MIT | WS24 v1.2 N49 AC2: the test validates real `tug -p --output-format json|stream-json` output against the published schema `docs/schemas/headless-output.schema.json` with an independent JSON Schema validator |
| yaml | 2.9.1 | ISC | WS8: H2/I3 tests parse action.yml and the workflow. Optional at runtime: `tug bench` uses it for terminal-bench `task.yaml` when installed, and otherwise a small built-in reader for the keys it needs |

### Tree-sitter grammars (WS1 v1.1 G6)

All optional and lazy: the runtime is initialised on the first syntax check or repo map, and each grammar on the first file of its language. `tree-sitter-wasms` (the package D7 originally looked for) is **not** a dependency because its licence is the Unlicense (not on the R4 list); a user-installed copy is still picked up. JSON grammar not added: `.json` keeps `JSON.parse` (stricter; tree-sitter-json accepts comments).

| Grammar wasm | Source package | Upstream grammar | Licence |
|---|---|---|---|
| typescript, tsx | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-typescript | MIT |
| javascript (incl. JSX) | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-javascript | MIT |
| python | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-python | MIT |
| go | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-go | MIT |
| rust | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-rust | MIT |
| java | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-java | MIT |
| css | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-css | MIT |
| bash | @vscode/tree-sitter-wasm | tree-sitter/tree-sitter-bash | MIT |
| html | tree-sitter-html | tree-sitter/tree-sitter-html | MIT |
| yaml | @tree-sitter-grammars/tree-sitter-yaml | tree-sitter-grammars/tree-sitter-yaml | MIT |
| (in the package, not bundled) ruby, php, cpp, c-sharp, regex / powershell / ini | @vscode/tree-sitter-wasm | tree-sitter/* / airbus-cert/tree-sitter-powershell / justinmk/tree-sitter-ini | MIT / MIT / Apache-2.0 |

VS Code extension: `vscode/scripts/build.mjs` copies `web-tree-sitter.cjs` + `web-tree-sitter.wasm` and the 11 grammars above into `resources/tree-sitter/` (7.6 MB unpacked, about 0.95 MB compressed in the vsix), with the packages' LICENSE files in `resources/tree-sitter/licenses/`. When the optional packages are not installed the build skips this step and the extension uses the fallbacks.

## External programs (not npm packages; run as separate processes, never linked or bundled)

| Program | Licence | Required? | Used by | Install |
|---|---|---|---|---|
| bubblewrap (`bwrap`) | LGPL-2.0-or-later | optional (Linux) | WS3 C2 OS sandbox (`shell.sandbox: "bwrap"` or `"auto"`) | `apt-get install -y bubblewrap` / `dnf install bubblewrap` |
| `sandbox-exec` (Seatbelt) | ships with macOS | optional (macOS) | WS3 C2 OS sandbox (`shell.sandbox: "seatbelt"` or `"auto"`) | built in |
| git | GPL-2.0 | optional | WS3 C1 checkpoints (shadow repo; without git, checkpoints use content-addressed copies); worktrees, arena, review | system package |
| tesseract | Apache-2.0 (5.x) | optional | WS5 E5 OCR regions (`perception.backend: "ocr"`), VS Code image OCR; spawned through `commandWrapperFor(cfg)` | system package |
| cua-driver | MIT (pinned 0.37, `desktop.cuaDriverVersion`) | optional | WS6 F1 desktop backend: `cua-driver mcp` over the MCP client. The AGPL `cua-som`/`cua-perception` are not used | `pip install cua-driver` (by the user; not bundled) |
| python3-gi + gir1.2-atspi-2.0 + at-spi2-core | LGPL-2.1+ (system libraries, not redistributed) | optional | WS6 F9 Linux sidecar (`linux_atspi.py`) | system packages |
| xdotool, ImageMagick `import`, wmctrl | BSD-3 / ImageMagick (Apache-style) / GPL-2 | optional | WS6 F9 Linux sidecar: keys, pointer, screenshots, window activation | system packages |
| Language servers: typescript-language-server, pyright, gopls, rust-analyzer, jdtls, clangd | Apache-2.0 / MIT / BSD-3 / MIT+Apache-2.0 / EPL-2.0 / Apache-2.0 with LLVM exception | optional, off by default (v1.2 N46: `lsp.autoDetect` enables installed presets; trusted plugins may declare servers; a server binary inside the workspace is refused unless allowed at user scope). Test fixtures (WS24 N46 AC1): pyright 1.1.x (`pip install pyright`) and gopls v0.20.0 (`go install golang.org/x/tools/gopls@v0.20.0`), installed in CI; locally the Python/Go cases skip with the reason when absent | WS1 v1.1 N3 `code_*` navigation and CLI post-edit diagnostics when listed in `lsp.servers`; spawned through `commandWrapperFor(cfg)` with a scrubbed env, stopped at session end. Without one, tree-sitter/regex name matching answers | installed by the user (presets name the command) |
| An embeddings endpoint (Ollama, llama.cpp, vLLM, TEI, …) | n/a (a service) | optional | WS1 v1.1 N2 `code_search` (`search.embeddings`); no client library, plain `fetch` | run by the user |
| PowerShell + .NET UI Automation | Microsoft (OS components) | optional | WS6 F9 Windows sidecar (`windows_uia.ps1`) | ships with Windows |

These are executed as external programs, so their licences do not apply to Tugline's own code (R4 covers linked or bundled dependencies). When a program is missing, the feature degrades as documented: an explicitly requested or managed-forced sandbox fails closed, `auto` runs unsandboxed with a warning, checkpoints fall back to copies, and OCR or desktop backends report that they are unavailable.
