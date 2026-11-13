# Tugline 1.6.0: connections, set up in the panel (CLI and VS Code extension)

A stable release, like 1.4.0. Pilot users asked for three things after 1.4.0: choosing another endpoint still went through VS Code's command picker, a custom URL needed every value in one place (name, key, context length), and the panel still looked plain next to current agent extensions. This release answers all three.

## Connections
- **Save each place your model runs once**, and switch between them from the model button under the message box. The button's menu lists your connections first, then the models on the one in use with their context size, so switching takes one click. The endpoint you already use becomes the first connection, with its key.
- **Add a connection** opens a gallery:
  - On this computer: Ollama, LM Studio and llama.cpp. Each is marked "Running" with its number of models when it answers.
  - Your company: a company server (vLLM, SGLang, TGI), Open WebUI, an API gateway (LiteLLM, Portkey), or any URL.
  - Hosted: OpenRouter, OpenAI, Google Gemini, DeepSeek, Mistral, Groq and Together AI, each with a link to create a key.
- **One form holds everything:**
  - the base URL and API key;
  - the model, searched from the server's list, with each model's context size and whether it calls tools (coder and tool-capable models first);
  - the context window: **Auto** uses the size the server reports for the model (vLLM, OpenRouter, Groq, Mistral, LM Studio, llama.cpp and Ollama report it), or pick 8K, 16K, 32K, 64K, 128K, 200K, 256K or 1M, or type any number;
  - under More options: the longest reply, tool calling (Auto, Native, Text), images, custom headers for gateways, and a name.
- **Test checks the connection step by step, on a line** from your editor to the model: the server answers, it serves the model, the model chats, the model calls a tool. Each step lights up as its result comes back. A failed step says what to fix, for example "refused the API key (401)", "has no API at this path; the base URL usually ends in /v1", or a certificate the computer does not trust. When the address is a chat website, the test offers the API address it found on the same server.
- **Keys stay with their server.** Each connection's key and custom header values are kept in VS Code's secret storage, separately, and are never sent back to the panel. A key is sent only to the server it was saved for: change a connection's address to another server and its key is dropped unless you type a new one. A fix that comes with this: in 1.4.0, switching to another server (a local server on the setup card, or editing the address) could send the previous server's key to the new one in the model-list request made during the switch. The old key is now removed before the address changes, and a test in a real VS Code checks that no request to the new server carries it.

## Nothing opens the command palette
**Tugline: Connections**, **Add a Connection** and **Change the API Key** open the panel. So do the status bar's model, the setup card's **Add a connection**, and **New skill** (its description is typed in the panel). The step-by-step palette wizard is gone.

## A new look
- Tugline's own colours on top of your theme: harbour indigo for actions, and signal amber only for something live (a connection that answers, a step that passed). High-contrast themes keep their own colours.
- The welcome screen shows the line from your editor to your model, which model and server it is, and whether it answered its last test.
- Settings are three tabs: **Connections**, **Behaviour** (the permission modes as a list to choose from, notifications, the visible terminal) and **Safety** (protected paths, allow and deny rules, hooks).
- Your own messages are lightly tinted, so turns read apart at a glance.

## For the CLI and SDK
`LLMClient.listModelInfo()` returns what a server's `GET /models` says about each model: context window, output limit, tool calling and images, across vLLM, OpenRouter, Together, Groq, Mistral, LM Studio and llama.cpp field names.

## Upgrading
Nothing to do: the endpoint in your settings becomes your first connection the first time the panel opens. The `tugline.baseUrl`, `tugline.model` and related settings still work; switching connections writes them.
