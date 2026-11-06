/**
 * Tugline VS Code extension.
 *
 * The extension host embeds the harness core (agent loop, tools, MCP, skills)
 * and talks to a webview chat panel (media/main.js) through a small message
 * protocol (chat.ts). IDE powers:
 *   - edits go through the editor buffers (host.ts, B1) and are reviewed after
 *     the write with per-hunk Keep/Undo (review.ts, B2);
 *   - inline edit on a selection (inlineEdit.ts, B3);
 *   - several chats, history, queue/steer/edit-resubmit, @-mentions, images,
 *     model picker, context meter (chat.ts, B4–B9);
 *   - visible terminal (terminal.ts, B10), MCP/skills manager and settings
 *     (B11/B12), notifications (B13), tab autocomplete (autocomplete.ts, B14);
 *   - checkpoint timeline (C1), emergency stop (F7), replay viewer (E7);
 *   - API keys live in VS Code SecretStorage, never in settings.json.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, resolveProfile } from '../../src/core/config.js';
import { LLMClient, type CompletionRequest } from '../../src/core/llm/client.js';
import { admittedComplete } from './coreBridge.js';
import { rawAdmission } from '../../src/core/llm/admission.js';
import { isKilled, killAutomation, resetKillSwitch } from '../../src/core/automation/policy/index.js';
import { clearStop, emergencyStop } from '../../src/core/automation/desktop/killswitch.js';
import { ideConfig } from '../../src/core/host/vscode-contract.js';
import { configureTreeSitter } from '../../src/core/edit/treesitter.js';
import { autocompleteAdmission, clientProfile, explicitSettings, ideFromSettings, lockedFields, mergeIde } from './settingsConfig.js';
import { ChatViewProvider, ProposedContent, PROPOSED_SCHEME, SECRET_KEY } from './chat.js';
import { DiagnosticsWatch } from './host.js';
import { BASE_SCHEME, ReviewManager } from './review.js';
import { runInlineEdit } from './inlineEdit.js';
import { TerminalOutputTracker } from './terminal.js';
import { HistoryProvider } from './historyView.js';
import { deleteSession, renameSession, type SessionInfo } from './sessions.js';
import { openReplay } from './replay.js';
import { AutocompleteController } from './autocomplete.js';
import type { ReviewHunk } from './hunks.js';
import { AgentsView } from './agentsView.js';
import { ReviewCommentsController } from './commentsController.js';
import { PreviewPanel } from './previewPanel.js';
import { NesController } from './nesController.js';
import { VoiceController } from './voiceController.js';
import { openWiki } from './wikiView.js';
import { registerParity, type ParityApi } from './parity.js';

async function configureWizard(ctx: vscode.ExtensionContext, provider: ChatViewProvider): Promise<void> {
  const s = vscode.workspace.getConfiguration('tugline');
  const governed = await provider.buildConfig(workspaceRoot() ?? process.cwd());
  const locked = lockedFields(governed);
  // the effective endpoint (config files + settings), not the contributed setting defaults
  const cur = clientProfile(governed);
  if (locked?.baseUrl || locked?.model) {
    // C4: never send the API key to a URL typed here when the organisation locked the endpoint
    void vscode.window.showWarningMessage(`Tugline: the model endpoint is locked by your organisation's managed policy (${locked.model ?? ''} @ ${locked.baseUrl ?? ''}). It cannot be changed here.`);
    return;
  }
  const presets = [
    { label: 'Ollama (local)', url: 'http://localhost:11434/v1' },
    { label: 'LM Studio (local)', url: 'http://localhost:1234/v1' },
    { label: 'llama.cpp server (local)', url: 'http://localhost:8080/v1' },
    { label: 'vLLM / SGLang / company server', url: 'http://your-server:8000/v1' },
    { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
    { label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
    { label: 'Custom URL…', url: '' },
  ];
  const pick = await vscode.window.showQuickPick(presets.map((p) => ({ label: p.label, description: p.url })), { title: 'Tugline: where is your LLM?', placeHolder: `current: ${cur.baseUrl}` });
  if (!pick) return;
  const baseUrl = await vscode.window.showInputBox({ title: 'Base URL (OpenAI-compatible)', value: pick.description || cur.baseUrl, ignoreFocusOut: true });
  if (!baseUrl) return;
  await s.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  const key = await vscode.window.showInputBox({ title: 'API key (leave empty if your endpoint needs none)', password: true, ignoreFocusOut: true, placeHolder: 'stored in VS Code SecretStorage' });
  if (key !== undefined) {
    if (key) await ctx.secrets.store(SECRET_KEY, key);
    else await ctx.secrets.delete(SECRET_KEY);
  }
  let models: string[] = [];
  try {
    models = await new LLMClient({ name: 'x', baseUrl, apiKey: key || (await ctx.secrets.get(SECRET_KEY)) || '', model: '', contextWindow: 0, maxOutputTokens: 0, toolMode: 'auto', vision: false }).listModels();
  } catch (e) {
    vscode.window.showWarningMessage(`Could not list models: ${(e as Error).message}`);
  }
  const model = models.length
    ? (await vscode.window.showQuickPick(models, { title: 'Model', placeHolder: cur.model }))
    : await vscode.window.showInputBox({ title: 'Model name', value: cur.model, ignoreFocusOut: true });
  if (model) await s.update('model', model, vscode.ConfigurationTarget.Global);
  const ctxWin = await vscode.window.showInputBox({ title: 'Context window (tokens)', value: String(cur.contextWindow), ignoreFocusOut: true });
  if (ctxWin && Number(ctxWin) > 0) await s.update('contextWindow', Number(ctxWin), vscode.ConfigurationTarget.Global);
  provider.updateStatus();
  await provider.testConnection();
}

export interface TuglineApi {
  provider: ChatViewProvider;
  review: ReviewManager;
  history: HistoryProvider;
  autocomplete: AutocompleteController;
  /** N12: the Agents view (sessions, status, worktrees) */
  agents: AgentsView;
  /** N14: review comments on agent hunks */
  comments: ReviewCommentsController;
  /** N24: live preview with an element picker */
  preview: PreviewPanel;
  /** N15: next-edit suggestions */
  nes: NesController;
  /** N25: push-to-talk voice input */
  voice: VoiceController;
  inlineEdit(args?: { instruction?: string }): ReturnType<typeof runInlineEdit>;
  /** emergency stop was triggered (tests) */
  stops: number;
  /** v1.2 N45/N47/N48: auto-approve, arena and board views, history and editor commands */
  parity: ParityApi;
  /** the core automation kill switch (F7) */
  automationKilled(): boolean;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(ctx: vscode.ExtensionContext): TuglineApi {
  // bundled tree-sitter runtime + grammars (repo map, syntax checks); absent = regex/fallbacks
  configureTreeSitter({ dirs: [path.join(ctx.extensionPath, 'resources', 'tree-sitter')] });
  const log = vscode.window.createOutputChannel('Tugline');
  const proposed = new ProposedContent();
  const review = new ReviewManager(ctx.workspaceState);
  const diagWatch = new DiagnosticsWatch();
  const terminals = new TerminalOutputTracker();
  const provider = new ChatViewProvider(ctx, proposed, log, review, diagWatch, terminals);
  const homeDir = () => {
    try {
      return loadConfig({ workspace: workspaceRoot() ?? process.cwd(), trusted: false }).homeDir;
    } catch {
      return undefined;
    }
  };
  const history = new HistoryProvider(homeDir, workspaceRoot);
  provider.onSessionsChanged(() => history.refresh());
  let apiKey = '';
  void ctx.secrets.get(SECRET_KEY).then((k) => (apiKey = k ?? ''));
  ctx.secrets.onDidChange(() => void ctx.secrets.get(SECRET_KEY).then((k) => (apiKey = k ?? '')));

  const settings = () => vscode.workspace.getConfiguration('tugline');
  // explicit values only: an unset setting must not shadow `ide.autocomplete` in ~/.tugline/config.json
  const explicit = () => {
    const s = settings();
    return explicitSettings((k) => s.inspect(k));
  };
  const acSettings = () => mergeIde(provider.lastConfig?.ide, ideFromSettings(explicit())).autocomplete ?? {};
  const autocomplete = new AutocompleteController(() => !!acSettings().enabled, {
    fetch: (...a) => fetch(...a),
    // R4: every autocomplete request is admitted against the limits and recorded (kind 'fim'); exhausted → no suggestion
    // batch 4 low: priced like the profile autocomplete posts to (dollar caps apply, the ledger records its cost)
    admit: (text, maxTokens, model) => (provider.lastConfig ? autocompleteAdmission(provider.lastConfig, acSettings().profile || undefined)(text, maxTokens, model) : { ok: false, reason: 'config not ready' }),
    config: () => {
      const ac = ideConfig({ ide: { autocomplete: { ...acSettings(), enabled: true } } }).autocomplete;
      // C4: the governed profile (a managed lockedProfile wins over settings); built async, used once ready
      const cfg = provider.lastConfig;
      if (!cfg) {
        void provider.buildConfig(workspaceRoot() ?? process.cwd()).catch(() => undefined);
        return undefined;
      }
      const p = clientProfile(cfg, ac.profile || undefined);
      return { ...ac, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey, headers: p.headers };
    },
  });

  const inlineClient = async (): Promise<LLMClient> => {
    const ws = workspaceRoot() ?? process.cwd();
    const cfg = await provider.buildConfig(ws);
    const name = ideConfig(cfg).inlineEditProfile;
    const chatAgent = provider.active?.agent;
    // the chat's profile (picker choice included) or ide.inlineEditProfile, always from the governed config
    if (!name && chatAgent) return new LLMClient(clientProfile(chatAgent.config, chatAgent.config.profile));
    return new LLMClient(clientProfile(cfg, name));
  };
  // R4: the inline-edit call is admitted like every model request (the chat agent's scope, else the governed config's)
  const inlineAdmit = async (client: LLMClient, req: CompletionRequest) => admittedComplete(client, req, { agent: provider.active?.agent, config: provider.active?.agent?.config ?? (await provider.buildConfig(workspaceRoot() ?? process.cwd())), kind: 'inline', role: 'editor' });
  const inlineEdit = (args?: { instruction?: string }) => runInlineEdit({ review, state: ctx.globalState, client: inlineClient, admit: inlineAdmit, log: (m) => log.appendLine(m) }, args);

  const agents = new AgentsView(provider, (m) => log.appendLine(m), workspaceRoot);
  const comments = new ReviewCommentsController(review, provider);
  const preview = new PreviewPanel(provider, (m) => log.appendLine(m));
  const nes = new NesController(
    () => settings().get<boolean>('nes.enabled', false),
    {
      fetch: (url, init) => fetch(url, init),
      debounceMs: () => settings().get<number>('nes.debounceMs', 150),
      config: () => {
        // C4: the governed profile (a managed lockedProfile wins over settings), as for autocomplete
        const cfg = provider.lastConfig;
        if (!cfg) {
          void provider.buildConfig(workspaceRoot() ?? process.cwd()).catch(() => undefined);
          return undefined;
        }
        const s = settings();
        const p = clientProfile(cfg, s.get<string>('nes.profile') || undefined);
        // R4: each next-edit request is admitted and recorded (kind 'nes'); exhausted → no suggestion
        return { baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey, headers: p.headers, maxTokens: s.get<number>('nes.maxTokens', 512), latencyMs: s.get<number>('nes.latencyMs', 400), admit: rawAdmission(cfg, { kind: 'nes', role: 'next-edit', pricing: p.pricing }) };
      },
    },
    (m) => log.appendLine(m),
  );
  const voice = new VoiceController(provider, (m) => log.appendLine(m));
  const parity = registerParity({ ctx, provider, history, terminal: terminals, log: (m) => log.appendLine(m), workspace: workspaceRoot });
  const api: TuglineApi = { provider, review, history, autocomplete, agents, comments, preview, nes, voice, inlineEdit, stops: 0, automationKilled: () => isKilled(), parity };
  const activeUri = () => vscode.window.activeTextEditor?.document.uri.toString();

  ctx.subscriptions.push(
    log,
    review,
    diagWatch,
    terminals,
    autocomplete,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, review.baseProvider),
    vscode.languages.registerCodeLensProvider({ pattern: '**' }, review),
    vscode.window.registerWebviewViewProvider('tugline.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider('tugline.history', history),
    agents,
    comments,
    preview,
    nes,
    voice,
    vscode.commands.registerCommand('tugline.voice.toggle', (o?: { audioFile?: string; confirmRemote?: boolean }) => voice.toggle(o && typeof o === 'object' ? o : {})),
    vscode.commands.registerCommand('tugline.nes.trigger', () => nes.trigger()),
    vscode.commands.registerCommand('tugline.nes.accept', () => nes.accept()),
    vscode.commands.registerCommand('tugline.nes.dismiss', () => nes.dismiss()),
    vscode.commands.registerCommand('tugline.preview.open', (url?: string) => preview.open(typeof url === 'string' ? url : undefined)),
    vscode.commands.registerCommand('tugline.preview.pick', () => preview.setPicking(true)),
    vscode.commands.registerCommand('tugline.reviewComments.add', (r: vscode.CommentReply) => comments.reply(r)),
    vscode.commands.registerCommand('tugline.reviewComments.delete', (t: vscode.CommentThread) => comments.deleteThread(t)),
    vscode.commands.registerCommand('tugline.reviewComments.send', () => comments.send()),
    vscode.commands.registerCommand('tugline.reviewComments.clear', () => comments.clear()),
    vscode.window.registerTreeDataProvider('tugline.agents', agents),
    vscode.commands.registerCommand('tugline.agents.newWorktreeSession', (o?: { title?: string; id?: string }) => agents.newWorktreeSession(o)),
    vscode.commands.registerCommand('tugline.agents.refresh', () => agents.refreshDiffs()),
    vscode.commands.registerCommand('tugline.agents.open', (r?: any) => agents.open(r)),
    vscode.commands.registerCommand('tugline.agents.answer', (r?: any, answer?: unknown) => agents.answer(r, answer)),
    vscode.commands.registerCommand('tugline.agents.stop', (r?: any) => agents.stop(r)),
    vscode.commands.registerCommand('tugline.agents.merge', (r?: any, confirmed?: boolean) => agents.merge(r, confirmed === true)),
    vscode.commands.registerCommand('tugline.agents.discard', (r?: any, confirmed?: boolean) => agents.discard(r, confirmed === true)),
    vscode.window.onDidChangeActiveTextEditor(() => review.updateInlineContext()),
    vscode.commands.registerCommand('tugline.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('tugline.clearChat', () => provider.clearChat()),
    vscode.commands.registerCommand('tugline.stop', () => provider.stop()),
    vscode.commands.registerCommand('tugline.emergencyStop', () => {
      // F7: one keystroke stops everything: browser/desktop automation (kill switch), every agent, every visible command.
      // Writes ~/.tugline/STOP too, so CLI/daemon/desktop runs in other processes stop as well.
      emergencyStop(homeDir() ?? path.join(os.homedir(), '.tugline'), 'emergency stop (VS Code)');
      provider.stopAll();
      api.stops++;
      log.appendLine('[emergency stop] automation killed, all agents aborted');
      void vscode.window.showWarningMessage('Tugline: EMERGENCY STOP — all agents stopped; browser/desktop automation is off until you run "Tugline: Resume Automation".', 'Resume Automation').then((p) => {
        if (p) void vscode.commands.executeCommand('tugline.resumeAutomation');
      });
    }),
    vscode.commands.registerCommand('tugline.resumeAutomation', () => {
      clearStop(homeDir() ?? path.join(os.homedir(), '.tugline'));
      void vscode.window.showInformationMessage('Tugline: automation tools are available again.');
    }),
    vscode.commands.registerCommand('tugline.undo', () => {
      const a = provider.currentAgent;
      if (!a || a.isRunning) return vscode.window.showWarningMessage('Tugline: nothing to undo (or the agent is still running).');
      const r = a.undo(1);
      vscode.window.showInformationMessage(r.restored.length ? `Tugline: restored ${r.restored.join(', ')}` : r.skipped.length ? `Tugline: not undone — ${r.skipped.join(', ')}` : 'Tugline: nothing to undo.');
    }),
    vscode.commands.registerCommand('tugline.inlineEdit', (args?: { instruction?: string }) => inlineEdit(args)),
    vscode.commands.registerCommand('tugline.inlineAccept', async () => {
      const u = activeUri();
      if (u && review.kindOf(u)) await review.keep(u);
    }),
    vscode.commands.registerCommand('tugline.inlineReject', async () => {
      const u = activeUri();
      if (u && review.kindOf(u)) await review.undo(u);
    }),
    vscode.commands.registerCommand('tugline.review.keepHunk', (uri: string, h: ReviewHunk) => review.keep(uri, h)),
    vscode.commands.registerCommand('tugline.review.undoHunk', (uri: string, h: ReviewHunk) => review.undo(uri, h)),
    vscode.commands.registerCommand('tugline.review.keepFile', (uri?: string) => review.keep(uri ?? activeUri() ?? '')),
    vscode.commands.registerCommand('tugline.review.undoFile', (uri?: string) => review.undo(uri ?? activeUri() ?? '')),
    vscode.commands.registerCommand('tugline.review.keepAll', () => review.keepAll()),
    vscode.commands.registerCommand('tugline.review.undoAll', () => review.undoAll()),
    vscode.commands.registerCommand('tugline.review.openAll', () => review.openAll()),
    vscode.commands.registerCommand('tugline.openReplay', (runDir?: string) => openReplay(workspaceRoot(), typeof runDir === 'string' ? runDir : undefined)),
    vscode.commands.registerCommand('tugline.history.resume', (s: SessionInfo) => {
      provider.resumeSession(s);
      void vscode.commands.executeCommand('tugline.chat.focus');
    }),
    vscode.commands.registerCommand('tugline.history.rename', async (s: SessionInfo) => {
      const h = homeDir();
      const ws = workspaceRoot();
      if (!s || !h || !ws) return;
      const t = await vscode.window.showInputBox({ title: 'Rename chat', value: s.title });
      if (t !== undefined) {
        renameSession(h, ws, s.id, t);
        history.refresh();
      }
    }),
    vscode.commands.registerCommand('tugline.history.delete', async (s: SessionInfo) => {
      const h = homeDir();
      const ws = workspaceRoot();
      if (!s || !h || !ws) return;
      deleteSession(h, ws, s.id);
      history.refresh();
    }),
    vscode.commands.registerCommand('tugline.history.search', async () => {
      const q = await vscode.window.showInputBox({ title: 'Search chats (prompts and answers)', value: history.filter });
      if (q !== undefined) history.setFilter(q);
    }),
    vscode.commands.registerCommand('tugline.history.clearSearch', () => history.setFilter('')),
    vscode.commands.registerCommand('tugline.history.refresh', () => history.refresh()),
    vscode.commands.registerCommand('tugline.configure', () => configureWizard(ctx, provider)),
    // WS12: the generated wiki in a panel, and /doc for the selection (a reviewable docstring edit)
    vscode.commands.registerCommand('tugline.openWiki', () => {
      const ws = workspaceRoot();
      if (!ws) return void vscode.window.showWarningMessage('Tugline: open a folder first.');
      return openWiki(ws, () => provider.buildConfig(ws), (m) => log.appendLine(`[wiki] ${m}`));
    }),
    vscode.commands.registerCommand('tugline.generateDocs', async () => {
      const ed = vscode.window.activeTextEditor;
      const ws = ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)?.uri.fsPath;
      if (!ed || !ws) return;
      const rel = path.relative(ws, ed.document.uri.fsPath).split(path.sep).join('/');
      await vscode.commands.executeCommand('tugline.chat.focus');
      await provider.sendPrompt(`/doc ${rel}:${ed.selection.active.line + 1}`);
    }),
    vscode.commands.registerCommand('tugline.testConnection', () => provider.testConnection()),
    vscode.commands.registerCommand('tugline.showLog', () => log.show()),
    vscode.commands.registerCommand('tugline.showView', async (view: string) => {
      await vscode.commands.executeCommand('tugline.chat.focus');
      provider.showView(view);
    }),
    vscode.commands.registerCommand('tugline.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'Tugline API key', password: true, ignoreFocusOut: true });
      if (key !== undefined) {
        if (key) await ctx.secrets.store(SECRET_KEY, key);
        else await ctx.secrets.delete(SECRET_KEY);
        vscode.window.showInformationMessage(key ? 'Tugline: API key saved to SecretStorage.' : 'Tugline: API key removed.');
      }
    }),
    vscode.commands.registerCommand('tugline.addSelection', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) return;
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      provider.addContext(`${rel} lines ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}:\n\`\`\`${ed.document.languageId}\n${ed.document.getText(ed.selection)}\n\`\`\``);
    }),
    vscode.commands.registerCommand('tugline.openConfig', async () => {
      const ws = workspaceRoot();
      if (!ws) return;
      const f = path.join(ws, '.tugline', 'config.json');
      if (!fs.existsSync(f)) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify({ permissions: { allow: [], deny: [], protectedPaths: ['tests/**', '.github/**'] }, mcpServers: {}, hooks: {} }, null, 2));
      }
      await vscode.window.showTextDocument(vscode.Uri.file(f));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tugline')) provider.updateStatus();
      if (e.affectsConfiguration('tugline.autocomplete.enabled')) autocomplete.refresh();
      if (e.affectsConfiguration('tugline.baseUrl')) void provider.refreshModels();
    }),
    { dispose: () => void Promise.all([...provider.chats.values()].map((c) => c.agent?.dispose())) },
  );
  log.appendLine('Tugline activated');
  return api;
}

export function deactivate(): void {}
