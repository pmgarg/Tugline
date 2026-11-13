/**
 * The panel's connection manager, on the extension side: lists the saved connections, switches between them, saves,
 * deletes and tests them step by step, lists a server's models with their limits, and finds local servers.
 *
 * Every reply goes back to the webview as a message; nothing here opens a VS Code picker or input box.
 */
import * as vscode from 'vscode';
import type { HarnessConfig } from '../../src/core/config.js';
import { LLMClient, LLMError } from '../../src/core/llm/client.js';
import { probeEndpoint } from '../../src/core/llm/probe.js';
import { detectLocalServers, detectOllama, isEmbeddingModel, LOCAL_SERVERS, ollamaShow, sameModel, type LocalServer } from '../../src/core/llm/ollama.js';
import type { ModelInfo } from '../../src/core/llm/modelInfo.js';
import type { ModelProfile } from '../../src/core/types.js';
import { checkInput, ConnectionStore, friendly, hostOf, PROVIDERS, validUrl, type Connection, type ConnectionInput, type HeaderInput } from './connections.js';
import { clientProfile, lockedFields, sameOrigin } from './settingsConfig.js';

/** The active connection's custom headers (values are secrets), read when the agent's config is built. */
export const SECRET_HEADERS = 'tugline.activeHeaders';

export interface ConnectionsDeps {
  secrets: vscode.SecretStorage;
  store: ConnectionStore;
  /** the secret-storage name of the active API key */
  keyName: string;
  buildConfig(): Promise<HarnessConfig>;
  post(m: unknown): void;
  /** the active endpoint changed: rebuild idle agents, refresh the status and the model list (and re-check setup) */
  changed(recheck: boolean): void;
  log(s: string): void;
}

/** A draft the form sends (unsaved values). */
interface Draft extends ConnectionInput {
  headers?: HeaderInput[];
}

const coderish = (id: string) => /coder|code|devstral|codestral|swe|deepseek-v|qwen3/i.test(id);

export class ConnectionsController {
  /** local servers to look for (tests point these at mock servers) */
  candidates: LocalServer[] = LOCAL_SERVERS;

  constructor(private readonly d: ConnectionsDeps) {}

  /**
   * Changes to the saved list run one at a time: a list refresh that reconciles with the settings must never run
   * while a switch is half-way through writing them. Network-only work (tests, model lists) stays outside the queue,
   * so a slow test never holds up a switch.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private locked(cfg: HarnessConfig): { baseUrl?: string; model?: string } {
    return (lockedFields(cfg) as { baseUrl?: string; model?: string }) ?? {};
  }

  /**
   * The saved list matches what the agent uses: the first time, the endpoint from the settings becomes the first
   * connection (with its key); later, an address or model changed in settings.json moves the active connection too.
   */
  ensure(): Promise<void> {
    return this.serial(() => this.ensureNow());
  }

  private async ensureNow(): Promise<void> {
    const { store } = this.d;
    let cfg: HarnessConfig;
    try {
      cfg = await this.d.buildConfig();
    } catch {
      return;
    }
    const cur = clientProfile(cfg);
    if (!validUrl(cur.baseUrl ?? '') || !cur.model) return;
    const key = (await this.d.secrets.get(this.d.keyName)) ?? '';
    if (!store.list().length) {
      await store.seed({ baseUrl: cur.baseUrl, model: cur.model, contextWindow: this.explicit('contextWindow'), maxOutputTokens: this.explicit('maxOutputTokens'), toolMode: cur.toolMode, vision: cur.vision }, key, await this.activeHeaders());
      return;
    }
    const act = store.active();
    const same = (c?: Connection) => !!c && c.baseUrl.replace(/\/+$/, '') === cur.baseUrl.replace(/\/+$/, '');
    if (same(act)) {
      if (act!.model !== cur.model) await store.save({ ...act!, model: cur.model });
      return;
    }
    // the settings point somewhere else (edited by hand, or the onboarding card picked a local server)
    const known = store.findByUrl(cur.baseUrl);
    if (known) {
      if (known.model !== cur.model) await store.save({ ...known, model: cur.model });
      await store.setActive(known.id);
      return;
    }
    const { connection } = await store.save({ baseUrl: cur.baseUrl, model: cur.model, toolMode: cur.toolMode, apiKey: key || undefined });
    await store.setActive(connection.id);
  }

  /** A number the user set in settings (not the contributed default). */
  private explicit(k: string): number | undefined {
    const i = vscode.workspace.getConfiguration('tugline').inspect<number>(k);
    const v = i?.globalValue ?? i?.workspaceValue;
    return typeof v === 'number' && v > 0 ? v : undefined;
  }

  private async activeHeaders(): Promise<Record<string, string>> {
    try {
      const h = JSON.parse((await this.d.secrets.get(SECRET_HEADERS)) ?? '{}');
      return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
    } catch {
      return {};
    }
  }

  /** The list for the panel (never a key or header value). */
  private async payload(): Promise<object> {
    await this.ensureNow().catch((e) => this.d.log(`[connections] ${(e as Error).message}`));
    let locked = {};
    try {
      locked = this.locked(await this.d.buildConfig());
    } catch {
      /* shown when the agent is built */
    }
    return { type: 'connections', list: await this.d.store.views(), providers: PROVIDERS, locked };
  }

  /** The saved connections in short, for the composer's switcher (sync: sent with every status). */
  brief(): { id: string; name: string; provider: string; host: string; model: string; active: boolean; lastTest?: Connection['lastTest'] }[] {
    const act = this.d.store.activeId();
    return this.d.store.list().map((c) => ({ id: c.id, name: c.name, provider: c.provider, host: hostOf(c.baseUrl), model: c.model, active: c.id === act, lastTest: c.lastTest }));
  }

  findByUrl(baseUrl: string): Connection | undefined {
    return this.d.store.findByUrl(baseUrl);
  }

  post(): Promise<void> {
    return this.serial(() => this.postNow());
  }

  private async postNow(): Promise<void> {
    this.d.post(await this.payload());
  }

  /** Make a connection the one every chat uses (`recheck`: show the setup card if it does not answer). */
  activate(id: string, recheck = true): Promise<Connection> {
    return this.serial(() => this.activateNow(id, recheck));
  }

  private async activateNow(id: string, recheck: boolean): Promise<Connection> {
    const c = this.d.store.get(id);
    if (!c) throw new Error('That connection no longer exists.');
    const locked = this.locked(await this.d.buildConfig());
    if (locked.baseUrl && !sameOrigin(locked.baseUrl, c.baseUrl)) throw new Error('Your organisation manages the model endpoint, so you cannot switch to another server.');
    const s = vscode.workspace.getConfiguration('tugline');
    const g = vscode.ConfigurationTarget.Global;
    // the old key and headers go first: a model-list refresh that fires when the address changes must never send
    // the previous server's key to this one
    await this.d.secrets.delete(this.d.keyName);
    await this.d.secrets.delete(SECRET_HEADERS);
    await s.update('baseUrl', c.baseUrl, g);
    await s.update('model', c.model, g);
    // unset means the default (or the size the server reports, for Ollama)
    await s.update('contextWindow', c.contextWindow, g);
    await s.update('maxOutputTokens', c.maxOutputTokens, g);
    await s.update('toolMode', c.toolMode === 'auto' ? undefined : c.toolMode, g);
    await s.update('vision', c.vision ? true : undefined, g);
    const key = await this.d.store.key(c.id);
    if (key) await this.d.secrets.store(this.d.keyName, key);
    const headers = await this.d.store.headers(c.id);
    if (Object.keys(headers).length) await this.d.secrets.store(SECRET_HEADERS, JSON.stringify(headers));
    await this.d.store.setActive(c.id);
    this.d.changed(recheck);
    return c;
  }

  /** The key and header values for a draft: typed ones, else the saved ones when the draft is for the same server. */
  private async secretsFor(dr: Draft): Promise<{ apiKey: string; headers: Record<string, string> }> {
    const saved = this.d.store.get(dr.id);
    const same = !!saved && sameOrigin(saved.baseUrl, dr.baseUrl);
    const apiKey = (typeof dr.apiKey === 'string' && dr.apiKey.trim()) || (same && !dr.clearKey ? await this.d.store.key(saved!.id) : '');
    const savedHeaders = same ? await this.d.store.headers(saved!.id) : {};
    const list: HeaderInput[] = dr.headers ?? (same ? (saved!.headerNames ?? []).map((name) => ({ name })) : []);
    const headers: Record<string, string> = {};
    for (const h of list) {
      const v = h.value ?? savedHeaders[h.name];
      if (h.name && v !== undefined) headers[h.name] = v;
    }
    return { apiKey, headers };
  }

  private async profileFor(dr: Draft): Promise<ModelProfile> {
    const { apiKey, headers } = await this.secretsFor(dr);
    return {
      name: 'connection',
      baseUrl: dr.baseUrl.trim(),
      apiKey,
      model: String(dr.model ?? '').trim(),
      contextWindow: Number(dr.contextWindow) > 0 ? Number(dr.contextWindow) : 32768,
      maxOutputTokens: Number(dr.maxOutputTokens) > 0 ? Math.min(Number(dr.maxOutputTokens), 4096) : 1024,
      toolMode: dr.toolMode === 'native' || dr.toolMode === 'text' ? dr.toolMode : 'auto',
      vision: !!dr.vision,
      headers,
      timeoutMs: 60_000,
    } as ModelProfile;
  }

  /** C4: a draft for another server is refused when the organisation locked the endpoint (its key never goes there). */
  private async lockProblem(baseUrl: string): Promise<string | undefined> {
    const locked = this.locked(await this.d.buildConfig());
    return locked.baseUrl && !sameOrigin(locked.baseUrl, baseUrl) ? 'Your organisation manages the model endpoint.' : undefined;
  }

  /** The server's models with what it says about them (and, for Ollama, what /api/show says). */
  async models(m: { reqId: number; draft: Draft }): Promise<void> {
    const reply = (x: object) => this.d.post({ type: 'connModels', reqId: m.reqId, ...x });
    const dr = m.draft;
    if (!validUrl(String(dr?.baseUrl ?? ''))) return reply({ models: [], error: 'Enter the base URL, starting with http:// or https://.' });
    const lp = await this.lockProblem(dr.baseUrl).catch((e) => (e as Error).message);
    if (lp) return reply({ models: [], error: lp });
    try {
      const p = await this.profileFor(dr);
      let infos: (ModelInfo & { coder?: boolean })[] = await new LLMClient({ ...p, timeoutMs: 8000 }).listModelInfo(AbortSignal.timeout(15_000));
      let ollama = false;
      if (await detectOllama(p.baseUrl, { probeRoot: true, timeoutMs: 1500 }).catch(() => undefined)) {
        ollama = true;
        infos = await this.ollamaDetails(p.baseUrl, infos);
      }
      infos = infos.map((x) => ({ ...x, coder: coderish(x.id) }));
      reply({ models: infos, ollama });
    } catch (e) {
      const notApi = e instanceof LLMError && e.kind === 'not_api';
      reply({ models: [], error: friendly(e as Error, dr.baseUrl), ...(notApi && (e as LLMError).suggestedBaseUrl ? { suggestBaseUrl: (e as LLMError).suggestedBaseUrl } : {}) });
    }
  }

  private async ollamaDetails(baseUrl: string, infos: ModelInfo[]): Promise<ModelInfo[]> {
    const out = new Map(infos.map((i) => [i.id, i]));
    const queue = infos.slice(0, 40).map((i) => i.id);
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const s = await ollamaShow(baseUrl, id, { timeoutMs: 3000 }).catch(() => undefined);
        if (!s) continue;
        const caps = s.capabilities;
        if (caps && isEmbeddingModel(id, caps)) {
          out.delete(id);
          continue;
        }
        out.set(id, { ...out.get(id)!, contextWindow: s.maxContext, ...(caps ? { tools: caps.includes('tools'), vision: caps.includes('vision') } : {}) });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return [...out.values()];
  }

  /** Which servers on this computer answer (the gallery marks them running). */
  async detect(): Promise<void> {
    const found = await detectLocalServers(this.candidates, { timeoutMs: 1200 }).catch(() => []);
    this.d.post({ type: 'connLocal', servers: found.map((s) => ({ kind: s.kind, baseUrl: s.baseUrl, models: s.models?.length ?? 0 })) });
  }

  /**
   * Test a draft step by step (the form lights each step as its result comes in): the server answers, it serves the
   * model, the model chats, and the model calls a tool. Nothing is saved; a saved connection records the result.
   */
  async test(m: { reqId: number; draft: Draft }): Promise<void> {
    const dr = m.draft;
    const step = (name: string, state: 'run' | 'ok' | 'warn' | 'fail', detail?: string, extra: object = {}) => this.d.post({ type: 'connTest', reqId: m.reqId, step, name, state, detail, ...extra });
    const done = (ok: boolean, extra: object = {}) => this.d.post({ type: 'connTest', reqId: m.reqId, name: 'done', state: ok ? 'ok' : 'fail', ...extra });
    if (!validUrl(String(dr?.baseUrl ?? ''))) {
      step('server', 'fail', 'Enter the base URL, starting with http:// or https://.');
      return done(false);
    }
    const lp = await this.lockProblem(dr.baseUrl).catch((e) => (e as Error).message);
    if (lp) {
      step('server', 'fail', lp);
      return done(false);
    }
    const p = await this.profileFor(dr);
    step('server', 'run');
    const t0 = Date.now();
    let infos: ModelInfo[];
    try {
      infos = await new LLMClient({ ...p, timeoutMs: 10_000 }).listModelInfo(AbortSignal.timeout(15_000));
      step('server', 'ok', `${hostOf(p.baseUrl)} answered in ${Date.now() - t0} ms`);
    } catch (e) {
      const notApi = e instanceof LLMError && e.kind === 'not_api';
      step('server', 'fail', friendly(e as Error, p.baseUrl), notApi && (e as LLMError).suggestedBaseUrl ? { suggestBaseUrl: (e as LLMError).suggestedBaseUrl } : {});
      return done(false);
    }
    if (!p.model) {
      step('model', 'fail', `Choose a model: the server lists ${infos.length} model${infos.length === 1 ? '' : 's'}.`);
      return done(false);
    }
    const listed = infos.find((i) => i.id === p.model || sameModel(i.id, p.model) || i.id.endsWith(`/${p.model}`));
    step('model', listed ? 'ok' : 'warn', listed ? `${p.model} is served here` : infos.length ? `${p.model} is not in the server's list; trying it anyway` : 'The server lists no models; trying the name you typed');
    step('chat', 'run');
    const r = await probeEndpoint(p, AbortSignal.timeout(120_000)).catch((e) => ({ chatOk: false, errors: [(e as Error).message] }) as any);
    if (!r.chatOk) {
      step('chat', 'fail', (r.errors ?? []).join(' | ') || 'The model did not answer.');
      return done(false);
    }
    const speed = `First reply in ${((r.latencyMs ?? 0) / 1000).toFixed(1)} s${r.tokensPerSecond ? `, about ${Math.round(r.tokensPerSecond)} tokens a second` : ''}`;
    step('chat', 'ok', speed);
    const tools = r.nativeTools ? 'native' : r.textTools ? 'text' : 'none';
    step('tools', tools === 'native' ? 'ok' : tools === 'text' ? 'warn' : 'fail', tools === 'native' ? 'Native tool calls work' : tools === 'text' ? 'No native tool calls; the text protocol works' : 'The model did not call a tool, so it cannot edit files or run commands');
    const result = { ok: tools !== 'none', at: Date.now(), latencyMs: r.latencyMs, tools: tools as 'native' | 'text' | 'none', error: tools === 'none' ? 'no tool calls' : undefined };
    const saved = this.d.store.get(dr.id);
    if (saved && saved.baseUrl === p.baseUrl.replace(/\/+$/, '') && saved.model === p.model) {
      await this.serial(async () => {
        await this.d.store.setLastTest(saved.id, result);
        await this.postNow();
      });
    }
    done(result.ok, { recommendedToolMode: r.recommendedToolMode, contextWindow: listed?.contextWindow, tools });
  }

  /** Save the form; `use` makes it the active connection too (runs in the queue). */
  private async save(m: { draft: Draft; use?: boolean }): Promise<void> {
    const reply = (x: object) => this.d.post({ type: 'connSaved', ...x });
    const dr = m.draft;
    const problem = checkInput(dr ?? ({} as Draft)) ?? (await this.lockProblem(dr.baseUrl).catch((e) => (e as Error).message));
    if (problem) return reply({ ok: false, error: problem });
    try {
      const { connection, dropped } = await this.d.store.save(dr);
      if (m.use || connection.id === this.d.store.activeId()) await this.activateNow(connection.id, true);
      reply({ ok: true, id: connection.id, dropped, used: !!m.use });
    } catch (e) {
      reply({ ok: false, error: (e as Error).message });
    }
    await this.postNow();
  }

  async handle(m: any): Promise<void> {
    try {
      switch (m.action) {
        // network only: outside the queue
        case 'models':
          return await this.models(m);
        case 'detect':
          return await this.detect();
        case 'test':
          return await this.test(m);
      }
      await this.serial(async () => {
        switch (m.action) {
          case 'load':
            return this.postNow();
          case 'save':
            return this.save(m);
          case 'use':
            await this.activateNow(String(m.id), true);
            return this.postNow();
          case 'delete':
            await this.d.store.remove(String(m.id));
            return this.postNow();
          case 'duplicate':
            await this.d.store.duplicate(String(m.id));
            return this.postNow();
        }
      });
    } catch (e) {
      this.d.post({ type: 'connError', error: (e as Error).message });
      await this.post().catch(() => undefined);
    }
  }
}
