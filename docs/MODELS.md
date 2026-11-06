# Choosing a model and a server

Researched 2026-10-26. Prices change often, so re-check the provider page before you commit money. Tugline works with anything that speaks OpenAI `/v1/chat/completions`. Run `tug doctor` after configuring: it tells you whether the endpoint supports native tool calling or needs the text protocol.

## Local (Mac, Apple Silicon)

| Server | Base URL | Notes |
|---|---|---|
| **Ollama** | `http://localhost:11434/v1` | Easiest option. **Raise the context**: the default is only 4K on machines with less than 24 GB and it silently drops old messages, which makes the agent look broken. Use `launchctl setenv OLLAMA_CONTEXT_LENGTH 65536` and restart the app, or set it in the app's Settings slider, or use a Modelfile with `PARAMETER num_ctx 65536`. Check with `ollama ps`. Optionally set `OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0`. |
| **LM Studio** | `http://localhost:1234/v1` | GGUF + MLX. Use models with the 🔨 (tool) badge. `lms load <model> --context-length 65536`. |
| **llama.cpp** | `http://127.0.0.1:8080/v1` | `brew install llama.cpp`, then `llama-server -hf unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M --jinja -c 65536 --port 8080`. Pass `--port`: the default port changed. |
| **MLX (`mlx_lm.server`)** | `http://localhost:8080/v1` | Often the fastest on Apple Silicon. The default `max_tokens` is 512; Tugline always sends `max_tokens`. |

**Which model for your RAM** (Ollama tags; Q4 unless noted):

| RAM | Recommended | Pull |
|---|---|---|
| 16 GB | Qwen3.5 9B, or gpt-oss 20b (tight: keep the context at 8–16K) | `ollama pull qwen3.5:9b` / `ollama pull gpt-oss:20b` |
| 32 GB (sweet spot) | **Qwen3-Coder 30B-A3B** (fast MoE), Qwen3.6 35B-A3B, Qwen3.8 27B, Devstral Small 2 24B, GLM-4.7-Flash | `ollama pull qwen3-coder:30b` |
| 64 GB | Qwen3-Coder-Next 80B-A3B, or the Q8 builds of the 32 GB picks for better tool-call accuracy | `ollama pull qwen3-coder-next` |

Settings for small models: `--compact-prompt` (or `"agent": {"promptStyle": "compact"}`), temperature 0.2–0.7, and a context of at least 32K.

## Hosted, cheap or free (OpenAI-compatible, tool calling)

| Option | Base URL | Example model | Cost for a typical 30-turn session* | Notes |
|---|---|---|---|---|
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-flash` (V4.1 Flash) | ≈ $0.03 off-peak with cache | Cheapest strong option. Off-peak = UAE afternoons, evenings and weekends. China-hosted. |
| **GLM-5.3-Flash** | Z.ai, Nebius, Together, DeepInfra, Mistral (EU) | `glm-5.3-flash` | ≈ $0.06 | $0.15 / $0.50 per 1M everywhere; strong tool use; non-China hosts available. |
| **gpt-oss-120b** | DeepInfra, Groq, Nebius, Together | `openai/gpt-oss-120b` | ≈ $0.05–0.21 | The reference "does the tool loop work" model; runs everywhere. |
| **OpenRouter free** | `https://openrouter.ai/api/v1` | `nvidia/nemotron-3-super-120b-a12b:free`, `google/gemma-4-31b-it:free` | $0 | 50 requests a day (1,000 a day after a one-time $10 credit purchase). One key covers every model above. |
| **Nebius Token Factory** | see the Nebius console | Qwen / GLM / gpt-oss / Kimi | low | EU-headquartered. You may have hackathon credits. |

\*Assumes a 6K-token system prompt, about 2.5K tokens added per turn and append-only history (prefix cache). Tugline keeps history append-only for exactly this reason.

**Caveats**
- Groq's free tier is 8K tokens per minute, too small for agent contexts.
- The Z.ai and Alibaba "Coding Plans" only license named tools (Claude Code, Cline…), so use their pay-as-you-go APIs.
- GitHub Models was retired on 2026-07-30.
- For proprietary code, prefer local models or US/EU hosts over China-hosted APIs and free tiers that train on your prompts.

## Company deployment checklist
1. Expose the model behind an OpenAI-compatible URL (vLLM: `--enable-auto-tool-choice --tool-call-parser <family>`; SGLang: `--tool-call-parser`; otherwise Tugline uses the text protocol).
2. Context of at least 32K, ideally 64K or more.
3. Put `baseUrl`, the auth header and the model in a shared `.tugline/config.json` or in VS Code settings, with keys in SecretStorage or env.
4. Self-host **SearXNG** for web search (`web.searchProvider: "searxng"`), and add intranet docs hosts to `web.allowHosts`.
5. Enforce policy with `permissions.deny`, `protectedPaths` and hooks; consider `shell.sandbox: "docker"`.
6. Measure your model + harness with `tug eval` before rollout.

## Sources
- OpenRouter limits: https://openrouter.ai/docs/api-reference/limits
- DeepSeek pricing: https://api-docs.deepseek.com/quick_start/pricing
- Ollama context length: https://docs.ollama.com/context-length · FAQ: https://docs.ollama.com/faq
- llama.cpp server / function calling: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md · https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md
- vLLM tool calling: https://docs.vllm.ai/en/latest/features/tool_calling.html
- LM Studio tool use: https://lmstudio.ai/docs/app/api/tools
