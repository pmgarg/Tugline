/**
 * Saved connections: each is a model endpoint the user set up once (a local server, the company's server, a hosted
 * API) with its own model and limits. One is active; switching writes it to the tugline.* settings the rest of the
 * extension reads, and puts its key where the agent finds it.
 *
 * Keys and custom header values live in VS Code's secret storage, one entry per connection, never in settings or
 * in the list. A key belongs to the server it was saved for: change a connection's address to another server and
 * its key and header values are dropped unless new ones are typed, so a key is never sent somewhere new by accident.
 *
 * No `vscode` import: the store takes a Memento and a SecretStorage shape, so node tests drive it directly.
 */
import crypto from 'node:crypto';
import { sameOrigin } from './settingsConfig.js';

export type ToolMode = 'auto' | 'native' | 'text';

export interface Provider {
  id: string;
  name: string;
  /** one line under the name */
  blurb: string;
  /** '' when the user types it (a company server) */
  baseUrl: string;
  /** an example address for the URL box */
  placeholder?: string;
  /** a server on this computer (the gallery checks whether it is running) */
  local?: boolean;
  /** the provider always needs a key */
  needsKey?: boolean;
  /** where to create a key */
  keyUrl?: string;
  /** a short note shown under the URL box */
  note?: string;
  /** two letters for the tile's mark */
  mark: string;
  group: 'local' | 'company' | 'hosted';
}

export const PROVIDERS: Provider[] = [
  { id: 'ollama', name: 'Ollama', blurb: 'Models on this computer', baseUrl: 'http://localhost:11434/v1', local: true, mark: 'Ol', group: 'local' },
  { id: 'lmstudio', name: 'LM Studio', blurb: 'Models on this computer', baseUrl: 'http://localhost:1234/v1', local: true, mark: 'LM', group: 'local' },
  { id: 'llamacpp', name: 'llama.cpp', blurb: 'llama-server on this computer', baseUrl: 'http://localhost:8080/v1', local: true, mark: 'll', group: 'local' },
  { id: 'company', name: 'Company server', blurb: 'vLLM, SGLang, TGI or any server on your network', baseUrl: '', placeholder: 'http://gpu-server:8000/v1', mark: 'Co', group: 'company', note: 'The API address, usually ending in /v1. Not the address of a chat website.' },
  { id: 'openwebui', name: 'Open WebUI', blurb: "Your company's chat site, through its API", baseUrl: '', placeholder: 'https://chat.example.com/api', needsKey: true, mark: 'OW', group: 'company', note: 'Use the site address followed by /api. Create a key in Open WebUI under Settings, Account, API keys.' },
  { id: 'gateway', name: 'API gateway', blurb: 'LiteLLM, Portkey or another OpenAI-compatible proxy', baseUrl: '', placeholder: 'https://llm-gateway.example.com/v1', mark: 'Gw', group: 'company', note: 'Some gateways need an extra header, such as a team or project ID. Add it under Custom headers.' },
  { id: 'openrouter', name: 'OpenRouter', blurb: 'Hundreds of models with one key', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/keys', mark: 'OR', group: 'hosted' },
  { id: 'openai', name: 'OpenAI', blurb: 'GPT models', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', mark: 'OA', group: 'hosted' },
  { id: 'gemini', name: 'Google Gemini', blurb: "Gemini through Google's OpenAI-compatible API", baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', mark: 'Ge', group: 'hosted' },
  { id: 'deepseek', name: 'DeepSeek', blurb: 'DeepSeek chat and reasoning models', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', mark: 'DS', group: 'hosted' },
  { id: 'mistral', name: 'Mistral', blurb: 'Codestral, Devstral and Mistral models', baseUrl: 'https://api.mistral.ai/v1', needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys', mark: 'Mi', group: 'hosted' },
  { id: 'groq', name: 'Groq', blurb: 'Very fast open models', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, keyUrl: 'https://console.groq.com/keys', mark: 'Gq', group: 'hosted' },
  { id: 'together', name: 'Together AI', blurb: 'Open models, hosted', baseUrl: 'https://api.together.xyz/v1', needsKey: true, keyUrl: 'https://api.together.ai/settings/api-keys', mark: 'To', group: 'hosted' },
  { id: 'custom', name: 'Custom URL', blurb: 'Any OpenAI-compatible endpoint', baseUrl: '', placeholder: 'https://ai.example.com/v1', mark: '+', group: 'company' },
];

const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

/** The provider an address belongs to: a known address, else Open WebUI for /api, else a company server. */
export function providerFor(baseUrl: string): string {
  const u = norm(baseUrl);
  const known = PROVIDERS.find((p) => p.baseUrl && norm(p.baseUrl) === u);
  if (known) return known.id;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):11434\b/.test(u)) return 'ollama';
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):1234\b/.test(u)) return 'lmstudio';
  if (/\/api$/.test(u)) return 'openwebui';
  return 'company';
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** A name for a new connection: the provider's, or the server's host for a company server. */
export function defaultName(provider: string, baseUrl: string): string {
  const p = PROVIDERS.find((x) => x.id === provider);
  if (p && p.baseUrl) return p.name;
  const h = hostOf(baseUrl).replace(/:\d+$/, '');
  return h || p?.name || 'Connection';
}

export interface LastTest {
  ok: boolean;
  at: number;
  latencyMs?: number;
  tools?: 'native' | 'text' | 'none';
  error?: string;
}

export interface Connection {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  toolMode: ToolMode;
  vision?: boolean;
  /** names of the custom headers (their values are secrets) */
  headerNames?: string[];
  lastTest?: LastTest;
}

/** What the panel shows: never a key or a header value. */
export interface ConnectionView extends Connection {
  hasKey: boolean;
  active: boolean;
  host: string;
}

export interface HeaderInput {
  name: string;
  /** undefined keeps the saved value for this name (when the server did not change) */
  value?: string;
}

export interface ConnectionInput {
  id?: string;
  name?: string;
  provider?: string;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  toolMode?: string;
  vision?: boolean;
  /** typed: replaces the saved key */
  apiKey?: string;
  /** remove the saved key */
  clearKey?: boolean;
  /** when given, the connection's headers become exactly these */
  headers?: HeaderInput[];
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

const LIST_KEY = 'tugline.connections.v1';
const ACTIVE_KEY = 'tugline.connections.active';
const keyName = (id: string) => `tugline.connection.${id}.key`;
const headersName = (id: string) => `tugline.connection.${id}.headers`;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
// these are set by the client itself; a custom value would break or misdirect requests
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host', 'accept', 'connection', 'transfer-encoding']);

export function validUrl(u: string): boolean {
  try {
    const x = new URL(u.trim());
    return (x.protocol === 'http:' || x.protocol === 'https:') && !!x.host;
  } catch {
    return false;
  }
}

const posInt = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100_000_000) : undefined;
};

/** Check a connection the panel sends; the reason is shown under the form. */
export function checkInput(i: ConnectionInput): string | undefined {
  if (!validUrl(String(i.baseUrl ?? ''))) return 'Enter the base URL, starting with http:// or https://.';
  if (!String(i.model ?? '').trim()) return 'Choose a model, or type its name.';
  for (const h of i.headers ?? []) {
    if (!HEADER_NAME.test(h.name ?? '')) return `"${h.name}" is not a valid header name.`;
    if (RESERVED_HEADERS.has(h.name.toLowerCase())) return `The ${h.name} header is set by Tugline itself.`;
    if (h.value !== undefined && /[\r\n]/.test(h.value)) return `The value of ${h.name} must be one line.`;
  }
  return undefined;
}

export class ConnectionStore {
  /**
   * The store's own copy is the truth once read or written: VS Code's globalState can briefly hand back an older
   * value after two quick writes (the main process echoes the first write after the second), which would lose a
   * connection saved a moment earlier. Every write is still persisted.
   */
  private listCache?: Connection[];
  private activeCache?: string | null;

  constructor(
    private readonly state: MementoLike,
    private readonly secrets: SecretsLike,
  ) {}

  list(): Connection[] {
    if (!this.listCache) {
      const l = this.state.get<Connection[]>(LIST_KEY);
      this.listCache = Array.isArray(l) ? l.filter((c) => c && typeof c.id === 'string') : [];
    }
    return this.listCache.map((c) => ({ ...c }));
  }

  get(id: string | undefined): Connection | undefined {
    return id ? this.list().find((c) => c.id === id) : undefined;
  }

  activeId(): string | undefined {
    if (this.activeCache === undefined) this.activeCache = this.state.get<string>(ACTIVE_KEY) ?? null;
    const id = this.activeCache ?? undefined;
    return this.get(id) ? id : undefined;
  }

  active(): Connection | undefined {
    return this.get(this.activeId());
  }

  async key(id: string): Promise<string> {
    return (await this.secrets.get(keyName(id))) ?? '';
  }

  async headers(id: string): Promise<Record<string, string>> {
    try {
      const h = JSON.parse((await this.secrets.get(headersName(id))) ?? '{}');
      return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
    } catch {
      return {};
    }
  }

  async views(): Promise<ConnectionView[]> {
    const act = this.activeId();
    return Promise.all(this.list().map(async (c) => ({ ...c, hasKey: !!(await this.key(c.id)), active: c.id === act, host: hostOf(c.baseUrl) })));
  }

  private async write(list: Connection[]): Promise<void> {
    this.listCache = list.map((c) => ({ ...c }));
    await this.state.update(LIST_KEY, list);
  }

  /**
   * Create or update a connection. A key and header values stay with the server they were saved for: when the
   * address moves to another server, they are dropped unless new ones come with the change (`dropped` says so).
   */
  async save(i: ConnectionInput): Promise<{ connection: Connection; dropped: boolean }> {
    const problem = checkInput(i);
    if (problem) throw new Error(problem);
    const list = this.list();
    const old = i.id ? list.find((c) => c.id === i.id) : undefined;
    if (i.id && !old) throw new Error('That connection no longer exists.');
    const baseUrl = i.baseUrl.trim().replace(/\/+$/, '');
    const id = old?.id ?? crypto.randomBytes(6).toString('hex');
    const moved = !!old && !sameOrigin(old.baseUrl, baseUrl);
    const provider = i.provider && i.provider !== 'custom' ? i.provider : providerFor(baseUrl);
    const toolMode: ToolMode = i.toolMode === 'native' || i.toolMode === 'text' ? i.toolMode : 'auto';
    let dropped = false;
    // the key
    if (typeof i.apiKey === 'string' && i.apiKey.trim()) await this.secrets.store(keyName(id), i.apiKey.trim());
    else if (i.clearKey) await this.secrets.delete(keyName(id));
    else if (moved && (await this.key(id))) {
      await this.secrets.delete(keyName(id));
      dropped = true;
    }
    // the headers: names in the list, values in secret storage
    let headerNames = old?.headerNames;
    const savedHeaders = old ? await this.headers(id) : {};
    if (i.headers) {
      const next: Record<string, string> = {};
      for (const h of i.headers) {
        const name = h.name.trim();
        if (!name) continue;
        if (h.value !== undefined) next[name] = h.value;
        else if (!moved && name in savedHeaders) next[name] = savedHeaders[name];
        else if (moved && name in savedHeaders) dropped = true;
      }
      headerNames = Object.keys(next);
      if (headerNames.length) await this.secrets.store(headersName(id), JSON.stringify(next));
      else await this.secrets.delete(headersName(id));
    } else if (moved && Object.keys(savedHeaders).length) {
      await this.secrets.delete(headersName(id));
      headerNames = [];
      dropped = true;
    }
    const connection: Connection = {
      id,
      name: String(i.name ?? '').trim().slice(0, 80) || old?.name || defaultName(provider, baseUrl),
      provider,
      baseUrl,
      model: i.model.trim(),
      contextWindow: posInt(i.contextWindow),
      maxOutputTokens: posInt(i.maxOutputTokens),
      toolMode,
      vision: i.vision === true ? true : undefined,
      headerNames: headerNames?.length ? headerNames : undefined,
      // a changed server or model has not been tested yet
      lastTest: old && !moved && old.model === i.model.trim() ? old.lastTest : undefined,
    };
    await this.write(old ? list.map((c) => (c.id === id ? connection : c)) : [...list, connection]);
    return { connection, dropped };
  }

  async setActive(id: string): Promise<Connection> {
    const c = this.get(id);
    if (!c) throw new Error('That connection no longer exists.');
    this.activeCache = id;
    await this.state.update(ACTIVE_KEY, id);
    return c;
  }

  /** Delete a connection and its secrets. The active one cannot be deleted (switch first). */
  async remove(id: string): Promise<void> {
    if (id === this.activeId()) throw new Error('Switch to another connection before deleting this one.');
    await this.write(this.list().filter((c) => c.id !== id));
    await this.secrets.delete(keyName(id));
    await this.secrets.delete(headersName(id));
  }

  async duplicate(id: string): Promise<Connection> {
    const c = this.get(id);
    if (!c) throw new Error('That connection no longer exists.');
    const { connection } = await this.save({ ...c, id: undefined, name: `${c.name} (copy)`, apiKey: (await this.key(id)) || undefined, headers: Object.entries(await this.headers(id)).map(([name, value]) => ({ name, value })) });
    return connection;
  }

  async setLastTest(id: string, t: LastTest): Promise<void> {
    await this.write(this.list().map((c) => (c.id === id ? { ...c, lastTest: t } : c)));
  }

  /** The connection for this address (same server and path), if one is saved. */
  findByUrl(baseUrl: string): Connection | undefined {
    const u = norm(baseUrl);
    return this.list().find((c) => norm(c.baseUrl) === u);
  }

  /**
   * First run with connections: the endpoint already in the settings becomes the first saved connection (with its
   * key), so nothing the user set up is lost. Does nothing once any connection exists.
   */
  async seed(cur: { baseUrl: string; model: string; contextWindow?: number; maxOutputTokens?: number; toolMode?: string; vision?: boolean }, key: string, headers: Record<string, string> = {}): Promise<Connection | undefined> {
    if (this.list().length || !validUrl(cur.baseUrl ?? '') || !String(cur.model ?? '').trim()) return undefined;
    const provider = providerFor(cur.baseUrl);
    const { connection } = await this.save({ ...cur, provider, name: defaultName(provider, cur.baseUrl), apiKey: key || undefined, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) });
    await this.setActive(connection.id);
    return connection;
  }
}

/** A failure in words a user can act on. */
export function friendly(e: Error, baseUrl: string): string {
  const msg = (e.message || String(e)).slice(0, 400);
  const h = hostOf(baseUrl);
  if (/ECONNREFUSED|connect ECONNREFUSED/i.test(msg)) return `Nothing answers at ${h}. Is the server running?`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return `${h} could not be found. Check the address (and your VPN, for a company server).`;
  if (/certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_/i.test(msg)) return `${h} uses a certificate this computer does not trust. Ask your IT team for the company certificate, or set NODE_EXTRA_CA_CERTS.`;
  if (/\b401\b|unauthori[sz]ed|invalid api key|incorrect api key/i.test(msg)) return `${h} refused the API key (401). Check the key, or whether this server needs one.`;
  if (/\b403\b|forbidden/i.test(msg)) return `${h} refused access (403). The key may lack permission for this model, or a custom header is needed.`;
  if (/\b404\b/.test(msg)) return `${h} has no API at this path (404). The base URL usually ends in /v1 (Open WebUI: /api).`;
  if (/aborted|timeout|timed out/i.test(msg)) return `${h} did not answer in time. Check the address, or try again if the server is busy.`;
  return msg;
}
