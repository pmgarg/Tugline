/**
 * WS9 clickable onboarding (pure; no `vscode` import, unit-tested with node).
 *
 * Decides whether the chat panel shows the onboarding card and what it holds:
 *  - the endpoint does not answer → buttons for the local servers that DO answer
 *    (Ollama :11434, LM Studio :1234, llama.cpp :8080);
 *  - no model set, or the configured model is not in /models (the default
 *    qwen3-coder:30b usually isn't pulled) → one button per chat model, sorted
 *    with tool-capable coder models first (Ollama /api/show capabilities), and
 *    embedding-only models left out.
 * Every action on the card is a button, so setup works with the mouse only. The
 * keyboard wizard (Tugline: Configure LLM Endpoint) stays for custom URLs.
 */
import { LLMClient, LLMError } from '../../src/core/llm/client.js';
import { detectLocalServers, detectOllama, LOCAL_SERVERS, ollamaCapabilities, sortModelChoices, toChoice, type LocalServer, type ModelChoice } from '../../src/core/llm/ollama.js';
import type { ModelProfile } from '../../src/core/types.js';

export type OnboardingState = 'unreachable' | 'noModel' | 'missingModel' | 'pickModel';

export interface OnboardingView {
  state: OnboardingState;
  baseUrl: string;
  model: string;
  error?: string;
  /** state 'unreachable': the server answered, but with a web page (the chat site's address, not its API) */
  notApi?: boolean;
  /** with notApi: a base URL on the same server that answers as an API */
  suggestBaseUrl?: string;
  /** local servers that answered (state 'unreachable') */
  servers: LocalServer[];
  /** chat models, best first */
  models: ModelChoice[];
  /** Ollama version when the endpoint is Ollama */
  ollama?: string;
}

export interface OnboardingDeps {
  fetch?: typeof fetch;
  /** local server candidates (tests point these at mock servers) */
  candidates?: LocalServer[];
  /** GET /models timeout */
  timeoutMs?: number;
}

type Endpoint = Pick<ModelProfile, 'baseUrl' | 'model' | 'apiKey' | 'headers'>;

/** Same tolerance as the probe: exact, `org/model`, `model` vs `model:tag`. */
export function modelListed(model: string, ids: string[]): boolean {
  if (!model) return false;
  const lc = model.toLowerCase();
  const tagless = (s: string) => s.toLowerCase().replace(/:latest$/, '');
  return ids.some((m) => {
    const x = m.toLowerCase();
    return x === lc || tagless(x) === tagless(lc) || x.endsWith(`/${lc}`) || x.split(':')[0] === lc;
  });
}

const notApi = (e: unknown): Pick<OnboardingView, 'notApi' | 'suggestBaseUrl'> =>
  e instanceof LLMError && e.kind === 'not_api' ? { notApi: true, ...(e.suggestedBaseUrl ? { suggestBaseUrl: e.suggestedBaseUrl } : {}) } : {};

async function listModels(p: Endpoint, timeoutMs: number): Promise<string[]> {
  return new LLMClient({ name: 'onboarding', baseUrl: p.baseUrl, apiKey: p.apiKey, headers: p.headers, model: p.model, contextWindow: 0, maxOutputTokens: 0, toolMode: 'auto', vision: false, timeoutMs }).listModels(AbortSignal.timeout(timeoutMs));
}

/** Chat models of an endpoint, best first (Ollama: by /api/show capabilities; others: by name). */
export async function modelChoices(baseUrl: string, ids: string[], d: OnboardingDeps = {}): Promise<{ models: ModelChoice[]; ollama?: string }> {
  const ollama = await detectOllama(baseUrl, { probeRoot: true, fetch: d.fetch });
  const caps = ollama ? await ollamaCapabilities(baseUrl, ids, { fetch: d.fetch }) : undefined;
  return { models: sortModelChoices(ids.map((id) => toChoice(id, caps?.get(id)))), ollama };
}

/**
 * The card for this endpoint, or undefined when the endpoint answers and the
 * model is installed (nothing to set up).
 */
export async function setupCheck(p: Endpoint, d: OnboardingDeps = {}): Promise<OnboardingView | undefined> {
  let ids: string[];
  try {
    ids = await listModels(p, d.timeoutMs ?? 5000);
  } catch (e) {
    const servers = await detectLocalServers(d.candidates ?? LOCAL_SERVERS, { fetch: d.fetch });
    return { state: 'unreachable', baseUrl: p.baseUrl, model: p.model, error: (e as Error).message.slice(0, 500), ...notApi(e), servers, models: [] };
  }
  if (p.model && modelListed(p.model, ids)) return undefined;
  const { models, ollama } = await modelChoices(p.baseUrl, ids, d);
  return { state: p.model ? 'missingModel' : 'noModel', baseUrl: p.baseUrl, model: p.model, servers: [], models, ollama };
}

/** After a server button: always the server's model list to pick from (the configured model, if present, is marked by the webview). */
export async function serverModels(p: Endpoint, d: OnboardingDeps = {}): Promise<OnboardingView> {
  let ids: string[];
  try {
    ids = await listModels(p, d.timeoutMs ?? 5000);
  } catch (e) {
    return { state: 'unreachable', baseUrl: p.baseUrl, model: p.model, error: (e as Error).message.slice(0, 500), ...notApi(e), servers: await detectLocalServers(d.candidates ?? LOCAL_SERVERS, { fetch: d.fetch }), models: [] };
  }
  const { models, ollama } = await modelChoices(p.baseUrl, ids, d);
  return { state: 'pickModel', baseUrl: p.baseUrl, model: p.model, servers: [], models, ollama };
}
