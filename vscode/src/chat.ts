/**
 * The chat panel: several chats (each with its own Agent, B6), message queue,
 * steering and edit-and-resubmit (B7), @-mentions (B4), images (B5), model
 * picker and effort (B8), context meter and cost (B9), pending-change review
 * (B2), the checkpoint timeline (C1), MCP/skills manager (B11) and settings
 * (B12). The webview is `media/main.js`; this file is the extension-host side.
 */
import { makeNonce } from './webviewHtml.js';
import { attachmentBlock } from '../../src/core/util/attachments.js';
import { invalidModeMessage, isPermissionMode, YOLO_WARNING } from '../../src/core/approver/modes.js';
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { Agent, type AgentUI } from '../../src/core/agent/agent.js';
import { loadConfig, resolveProfile, trustWorkspace, type HarnessConfig } from '../../src/core/config.js';
import { probeEndpoint } from '../../src/core/llm/probe.js';
import { LLMClient } from '../../src/core/llm/client.js';
import type { AgentEvent, ContentPart, PermissionAnswer, PermissionMode, PermissionRequest } from '../../src/core/types.js';
import type { ToolDef } from '../../src/core/tools/types.js';
import { contextBreakdown } from '../../src/core/context/breakdown.js';
import { checkpointsFor } from '../../src/core/checkpoint/index.js';
import { commandWrapperFor, execCommand, scrubbedEnv } from '../../src/core/tools/shell.js';
import { webFetchTool } from '../../src/core/tools/web.js';
import { contentToText } from '../../src/core/util/text.js';
import { SkillManager, defaultSkillDirs } from '../../src/core/skills/manager.js';
import { ideConfig } from '../../src/core/host/vscode-contract.js';
import { DiagnosticsWatch, VsCodeBufferHost } from './host.js';
import { admittedComplete, completionBadge, historyWithState } from './coreBridge.js';
import type { ReviewManager } from './review.js';
import { resolveMentions, rankFiles, SPECIAL_ITEMS, type MentionDiagnostic, type MentionEnv } from './mentions.js';
import { buildUserMessage, describePrompt, type ImageText, type PastedImage } from './images.js';
import { emptyMeter, meterReduce, meterView, withBreakdown, type MeterState } from './meter.js';
import { applyPlanProfile, applySelection, pickerItems, type Effort, type ModelSelection } from './modelPick.js';
import { titleFromPrompt, listSessions, loadSessionMessages, type SessionInfo } from './sessions.js';
import { Notifier } from './notify.js';
import { createVisibleRunner, openJobTerminal, type TerminalOutputTracker } from './terminal.js';
import type { VisibleTerminalRunner } from './terminalRunner.js';
import { dispatchSlash, slashItems } from './slash.js';
import { clientProfile, explicitSettings, governedConfig, ideFromSettings, lockedFields, mergeIde } from './settingsConfig.js';
import { serverModels, setupCheck, type OnboardingView } from './onboarding.js';
import { detectOllama, effectiveContext, LOCAL_SERVERS, ollamaModelInfo, OLLAMA_SETTINGS_HINT, type LocalServer } from '../../src/core/llm/ollama.js';
import { loginMcpServer, logoutMcpServer } from './mcpAuth.js';
import type { SessionAction } from './agents.js';
import { sandboxStatus } from '../../src/core/sandbox/index.js';
import { sandboxBadge, type SandboxBadge } from './sandboxBadge.js';
import type { Worktree } from './worktreeSession.js';
import { addMcpServer, applyMcpToggles, configFile, localServerName, MCP_REGISTRY_URL, mcpToggleKey, parseRegistry, readConfigFile, removeMcpServer, rulesFile, setHooks, setMcpToggle, setPermissionMode, setPermissionRules, setProtectedPaths, setSkillEnabled, type ConfigScope } from './configEdit.js';

export const SECRET_KEY = 'tugline.apiKey';
export const PROPOSED_SCHEME = 'tugline-proposed';

export class ProposedContent implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;
  set(key: string, content: string): vscode.Uri {
    this.docs.set(key, content);
    const uri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${key}`);
    this.emitter.fire(uri);
    return uri;
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path.slice(1)) ?? '';
  }
}

function diagnosticsTool(): ToolDef<{ path?: string }> {
  return {
    name: 'ide_diagnostics',
    kind: 'read',
    readOnly: true,
    description: 'Get the errors and warnings VS Code currently reports (compiler, linter, type checker) for one file or the whole workspace. Use it after editing to catch problems without running a build.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path (omit for all files)' } } },
    title: (a) => `Diagnostics ${a.path ?? '(workspace)'}`,
    async run(a, ctx) {
      const host = ctx.host;
      const abs = a.path ? path.resolve(ctx.workspace, a.path) : undefined;
      const diags = host.diagnostics ? await host.diagnostics(abs, abs ? { waitMs: 1500 } : undefined) : [];
      const lines = diags.slice(0, 200).map((d) => `${path.relative(ctx.workspace, d.path)}:${d.line}:${d.col} ${d.severity}: ${d.message}${d.source ? ` [${d.source}]` : ''}`);
      return { output: lines.length ? lines.join('\n') : 'No errors or warnings reported.' };
    },
  };
}

type Pending = { kind: string; chatId: string; resolve: (v: any) => void };

export interface ChatState {
  id: string;
  title: string;
  agent?: Agent;
  agentKey: string;
  host: VsCodeBufferHost;
  runner?: VisibleTerminalRunner;
  selection: ModelSelection;
  /** snippets for the next message: editor selections (B4) and preview picks (N24, source "element") */
  queuedContext: { source: string; text: string }[];
  meter: MeterState;
  /** prompts sent but not started yet: uid + prompt text (matched on run_start) */
  uiQueue: { uid: string; text: string }[];
  /** user message uid → position in agent.messages and its run */
  uidIndex: Map<string, { index: number; runId: string }>;
  busy: boolean;
  resume?: SessionInfo;
  /** profiles as configured, before the picker touched them */
  originals?: HarnessConfig['profiles'];
  baseProfile?: string;
  /** N12: the session runs in its own git worktree (the agent's workspace) */
  worktree?: Worktree;
}

let uidSeq = 0;
const newUid = () => `u${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  readonly chats = new Map<string, ChatState>();
  activeId = '';
  private chatSeq = 0;
  private pending = new Map<string, Pending>();
  private status: vscode.StatusBarItem;
  /** N30: the sandbox state next to the model (same text as the CLI banner) */
  private sandboxItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  /** the last sandbox badge shown (tests) */
  lastSandbox?: SandboxBadge & { summary: string };
  private trustAsked = new Set<string>();
  private endpointModels: string[] = [];
  readonly notifier: Notifier;
  private sessionsChanged = new vscode.EventEmitter<void>();
  readonly onSessionsChanged = this.sessionsChanged.event;
  /** Test/automation hook: observe every agent event (all chats). */
  eventListeners: ((e: AgentEvent, chatId: string) => void)[] = [];
  /** Test hook: messages posted to the webview. */
  posted: any[] = [];
  /** v1.2 N45: focus the chat composer (tugline.focusChat, Cline's focusChatInput). */
  focusComposer(): void {
    this.post({ type: 'focusComposer' });
  }
  /** v1.2 N45: functions applied to each prompt before it is sent (vscode/src/parity.ts: IDE context). */
  promptDecorators: ((text: string) => string)[] = [];
  /** N12: the Agents view follows every chat through this (status reducer actions). */
  sessionHook?: (chatId: string, a: SessionAction) => void;
  private chatsChangedEmitter = new vscode.EventEmitter<void>();
  /** N12: chats were created, renamed, closed or started/stopped running. */
  readonly onChatsChanged = this.chatsChangedEmitter.event;

  constructor(
    private ctx: vscode.ExtensionContext,
    private proposed: ProposedContent,
    private log: vscode.OutputChannel,
    private review: ReviewManager,
    private diagWatch: DiagnosticsWatch,
    private terminals: TerminalOutputTracker,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = 'tugline.configure';
    this.updateStatus();
    this.status.show();
    this.sandboxItem.command = 'tugline.openConfig';
    ctx.subscriptions.push(this.status, this.sandboxItem, this.sessionsChanged, this.chatsChangedEmitter);
    this.notifier = new Notifier(vscode.window, {
      enabled: () => this.ide().notifications,
      afterMs: () => this.ide().notifyAfterMs,
      panelVisible: () => !!this.view?.visible,
      reveal: () => void vscode.commands.executeCommand('tugline.chat.focus'),
    });
    review.onDidChangePending(() => void this.postPending());
    this.newChat();
  }

  // ------------------------------------------------------------ webview

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = makeNonce();
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    // VS Code's own icon font (bundled from @vscode/codicons), so the panel's icons match the editor's
    const icons = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicons', 'codicon.css'));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${icons}" rel="stylesheet"><link href="${style}" rel="stylesheet"><title>Tugline</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: any) => this.onMessage(m).catch((e) => this.post({ type: 'error', message: (e as Error).message })));
  }

  get panelVisible(): boolean {
    return !!this.view?.visible;
  }

  private post(msg: any): void {
    this.posted.push(msg);
    if (this.posted.length > 2000) this.posted.splice(0, 1000);
    void this.view?.webview.postMessage(msg);
  }

  get active(): ChatState {
    return this.chats.get(this.activeId)!;
  }

  // ------------------------------------------------------------ config

  private workspaceRoot(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const folder = (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) ?? vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath;
  }

  /** Only the settings the user set (contributed defaults never shadow config files). */
  private settingsGet() {
    const s = vscode.workspace.getConfiguration('tugline');
    return explicitSettings((k) => s.inspect(k));
  }

  /** The `ide` keys set in VS Code settings (explicit values only). */
  private ideSettings(): HarnessConfig['ide'] {
    return ideFromSettings(this.settingsGet());
  }

  /** The effective ide config: config files, then VS Code settings, then DEFAULT_IDE. */
  private ide() {
    return ideConfig({ ide: mergeIde(this.lastConfig?.ide, this.ideSettings()) });
  }

  /** The last governed config built (sync consumers: autocomplete). */
  lastConfig?: HarnessConfig;

  async buildConfig(workspace: string): Promise<HarnessConfig> {
    const apiKey = (await this.ctx.secrets.get(SECRET_KEY)) ?? process.env.TUG_API_KEY ?? '';
    // Settings the user set win over config files, and the managed policy wins over both (governance applied last).
    const cfg = governedConfig({ workspace, get: this.settingsGet(), apiKey, vscodeTrusted: vscode.workspace.isTrusted, ide: this.ideSettings() });
    if (cfg.trust && !cfg.trust.workspaceTrusted && cfg.trust.ignored.length && !this.trustAsked.has(workspace)) {
      this.trustAsked.add(workspace);
      void vscode.window
        .showWarningMessage(`Tugline: this workspace's config wants to ${cfg.trust.ignored.join('; ')}. These can run code or change where your API key is sent. They are ignored until you trust this workspace.`, { modal: false }, 'Trust workspace config')
        .then((pick) => {
          if (pick && vscode.workspace.isTrusted) {
            trustWorkspace(cfg.homeDir, workspace);
            for (const c of this.chats.values()) c.agentKey = '';
            vscode.window.showInformationMessage('Tugline: workspace config trusted; it applies from the next message.');
          } else if (pick) vscode.window.showWarningMessage('Trust the folder in VS Code (Workspace Trust) first.');
        });
    }
    if (cfg.managed?.violations.length) this.log.appendLine(`[managed policy] ${cfg.managed.violations.join('; ')}`);
    this.lastConfig = cfg;
    this.updateSandboxStatus();
    return cfg;
  }

  // ------------------------------------------------------------ chats

  newChat(opts: { resume?: SessionInfo; worktree?: Worktree; title?: string } = {}): ChatState {
    const id = `chat${++this.chatSeq}`;
    const chat: ChatState = {
      id,
      title: opts.resume ? opts.resume.title : opts.title ?? 'New chat',
      agentKey: '',
      host: undefined as any,
      selection: {},
      queuedContext: [],
      meter: emptyMeter(),
      uiQueue: [],
      uidIndex: new Map(),
      busy: false,
      resume: opts.resume,
      worktree: opts.worktree,
    };
    chat.host = new VsCodeBufferHost(
      {
        autoSave: () => this.ide().autoSave,
        onAgentWrite: (abs, before, after) => this.onAgentWrite(chat, abs, before, after),
        runner: () => this.runnerFor(chat),
        ownEdit: (uri, fn) => this.review.own(uri, fn),
      },
      this.diagWatch,
    );
    this.chats.set(id, chat);
    this.activeId = id;
    this.postChats();
    if (opts.resume) {
      const msgs = loadSessionMessages(opts.resume.file);
      this.post({ type: 'history', chatId: id, messages: msgs.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)).map((m) => ({ role: m.role, text: contentToText(m.content) })) });
    }
    this.sendStatus();
    return chat;
  }

  switchChat(id: string): void {
    if (!this.chats.has(id)) return;
    this.activeId = id;
    this.postChats();
    this.sendStatus();
    this.postMeter(this.active);
    this.updateSandboxStatus();
  }

  async closeChat(id: string): Promise<void> {
    const c = this.chats.get(id);
    if (!c) return;
    c.agent?.abort();
    this.cancelPending(id);
    await c.agent?.dispose().catch(() => undefined);
    c.runner?.dispose();
    this.chats.delete(id);
    if (!this.chats.size) this.newChat();
    else if (this.activeId === id) this.activeId = [...this.chats.keys()].pop()!;
    this.postChats();
    this.sendStatus();
    this.sessionsChanged.fire();
  }

  /** One per extension session: the webview drops chat DOM saved by an earlier session (that is in History). */
  readonly epoch = `${Date.now()}`;

  showView(view: string): void {
    this.post({ type: 'showView', view });
  }

  private postChats(): void {
    this.chatsChangedEmitter.fire();
    this.post({ type: 'chats', epoch: this.epoch, active: this.activeId, list: [...this.chats.values()].map((c) => ({ id: c.id, title: c.title, running: c.busy })) });
  }

  resumeSession(s: SessionInfo): ChatState {
    const existing = [...this.chats.values()].find((c) => c.resume?.id === s.id || c.agent?.sessionId === s.id);
    if (existing) {
      this.switchChat(existing.id);
      return existing;
    }
    return this.newChat({ resume: s });
  }

  private runnerFor(chat: ChatState): VisibleTerminalRunner | undefined {
    if (!this.ide().visibleTerminal) return undefined;
    if (!chat.runner) chat.runner = createVisibleRunner(this.chats.size > 1 || chat.id !== 'chat1' ? `Tugline (${chat.title.slice(0, 20)})` : 'Tugline');
    return chat.runner;
  }

  /** file path → the chat whose agent last wrote it (N14 sends review comments there) */
  private writers = new Map<string, string>();

  ownerOf(abs: string): ChatState | undefined {
    const id = this.writers.get(abs);
    return id ? this.chats.get(id) : undefined;
  }

  private onAgentWrite(chat: ChatState, abs: string, before: string | null, after: string | null): void {
    this.writers.set(abs, chat.id);
    const mode = chat.agent?.policy.mode;
    if (mode !== 'acceptEdits' && mode !== 'auto' && mode !== 'yolo') return;
    void this.review.track(vscode.Uri.file(abs), before, 'agent').then(async () => {
      const uri = vscode.Uri.file(abs).toString();
      const files = await this.review.list();
      const f = files.find((x) => x.uri === uri);
      if (f && chat.agent) chat.agent.emitEvent({ type: 'diff_pending', path: abs, added: f.added, removed: f.removed, hunks: f.hunks });
    });
  }

  ui(chat: ChatState): AgentUI {
    return {
      onEvent: (e) => this.onAgentEvent(chat, e),
      requestPermission: (r) => this.requestPermission(chat, r),
      askUser: (q, options) => this.request(chat, 'ask', { question: q, options }, q),
      approvePlan: (plan) => this.request(chat, 'plan', { plan }, 'approve the plan'),
    };
  }

  private request<T>(chat: ChatState, type: string, payload: Record<string, unknown>, title: string): Promise<T> {
    const id = Math.random().toString(36).slice(2);
    this.notifier.onRequest(chat.title, title);
    this.sessionHook?.(chat.id, { type: 'blocked', requestId: id, title, kind: type });
    return new Promise<T>((resolve) => {
      const done = (v: any) => {
        this.sessionHook?.(chat.id, { type: 'answered', requestId: id });
        resolve(v);
      };
      this.pending.set(id, { kind: type, chatId: chat.id, resolve: done });
      this.post({ type, id, chatId: chat.id, ...payload });
    });
  }

  /** N12: pending approvals and questions of a chat (the Agents view answers them). */
  pendingOf(chatId: string): { id: string; kind: string }[] {
    return [...this.pending].filter(([, p]) => p.chatId === chatId).map(([id, p]) => ({ id, kind: p.kind }));
  }

  /** N12: answer a pending request from outside the chat panel; the panel's prompt is withdrawn. */
  answerPending(id: string, reply: unknown): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(reply);
    const decision = (reply as { decision?: string } | undefined)?.decision;
    this.post({ type: 'cancelPending', id, decision: typeof decision === 'string' ? decision : undefined });
    return true;
  }

  private async requestPermission(chat: ChatState, r: PermissionRequest): Promise<PermissionAnswer> {
    let right: vscode.Uri | undefined;
    if (r.diff) {
      const left = this.proposed.set(`${Date.now()}-before/${path.basename(r.diff.path)}`, r.diff.before);
      right = this.proposed.set(`${Date.now()}-after/${path.basename(r.diff.path)}`, r.diff.after);
      void vscode.commands.executeCommand('vscode.diff', left, right, `Tugline proposes: ${path.basename(r.diff.path)}`, { preview: true, preserveFocus: true });
    }
    let reply: { decision: 'allow' | 'always' | 'deny'; feedback?: string };
    try {
      reply = await this.request<{ decision: 'allow' | 'always' | 'deny'; feedback?: string }>(chat, 'permission', { request: { ...r, diff: r.diff ? { path: r.diff.path, before: r.diff.before.slice(0, 20000), after: r.diff.after.slice(0, 20000) } : undefined } }, r.title);
    } finally {
      // UI tour: the proposal tab stayed open after it was answered
      if (right) closeDiffTabs(right);
    }
    if (reply.decision === 'deny') return { decision: 'deny', feedback: reply.feedback };
    return { decision: 'allow', always: reply.decision === 'always' };
  }

  get currentAgent(): Agent | undefined {
    return this.active?.agent;
  }

  private onAgentEvent(chat: ChatState, e: AgentEvent): void {
    for (const l of this.eventListeners) l(e, chat.id);
    this.sessionHook?.(chat.id, { type: 'event', e });
    if (e.type === 'notice') this.log.appendLine(`[${chat.id}] [${e.level}] ${e.message}`);
    if (e.type === 'tool_end' && !e.ok) this.log.appendLine(`[${chat.id}] [tool ${e.name}] ${e.output.slice(0, 500)}`);
    if (e.type === 'run_end') this.log.appendLine(`[${chat.id}] [run] ${e.stopReason} ${JSON.stringify({ ...e.stats, commandsRun: e.stats.commandsRun.length })}`);
    if (e.type === 'run_start' && chat.agent) {
      const i = chat.uiQueue.findIndex((q) => q.text === e.prompt);
      const q = i >= 0 ? chat.uiQueue.splice(i, 1)[0] : undefined;
      if (q) {
        chat.uidIndex.set(q.uid, { index: chat.agent.messages.length, runId: e.runId });
        this.post({ type: 'userIndex', chatId: chat.id, uid: q.uid });
      }
    }
    if (e.type === 'job' && e.phase === 'start' && this.ide().visibleTerminal) openJobTerminal(e.jobId, e.command ?? '');
    this.notifier.onEvent(chat.title, e);
    chat.meter = meterReduce(chat.meter, e);
    if ((e.type === 'assistant_message' || e.type === 'run_end' || e.type === 'compaction') && chat.agent) chat.meter = withBreakdown(chat.meter, contextBreakdown({ systemPrompt: () => chat.agent!.systemPrompt(), toolSpecs: () => chat.agent!.toolSpecs(), messages: chat.agent.messages, llm: chat.agent.llm, config: chat.agent.config, deferredToolCount: chat.agent.deferredToolNames().length }));
    if (e.type === 'usage' || e.type === 'assistant_message' || e.type === 'run_end' || e.type === 'compaction') this.postMeter(chat);
    if (e.type === 'run_end') this.sessionsChanged.fire();
    // R2: the completion badge is computed here (one place for the wording) and rendered by the webview
    this.post({ type: 'event', chatId: chat.id, event: e.type === 'run_end' ? { ...e, badge: completionBadge(e.completion) } : e });
  }

  postMeter(chat: ChatState): void {
    if (!chat) return;
    this.post({ type: 'meter', chatId: chat.id, view: meterView(chat.meter) });
  }

  /** Get (or build) the chat's agent. Rebuilt when the endpoint/settings changed, keeping the conversation. */
  async getAgent(chat: ChatState): Promise<Agent | undefined> {
    // N12: a worktree session works inside its worktree
    const ws = chat.worktree?.path ?? this.workspaceRoot();
    if (!ws) {
      this.post({ type: 'error', chatId: chat.id, message: 'Open a folder first: the agent works inside a workspace folder.' });
      return undefined;
    }
    if (chat.agent && (chat.agent.isRunning || chat.busy)) return chat.agent;
    const cfg = await this.buildConfig(ws);
    const key = JSON.stringify([ws, cfg.profiles[cfg.profile], cfg.mcpServers, cfg.shell.mode, cfg.agent.promptStyle, cfg.web, (cfg as any).browser, (cfg as any).approver, (cfg as any).routing, cfg.permissions.protectedPaths, cfg.skills]);
    if (chat.agent && chat.agentKey === key) return chat.agent;
    // R14: a re-created agent (model/settings change) keeps the session's durable state (brief, tasks, evidence)
    const history = chat.agent ? historyWithState(chat.agent) : chat.resume ? loadSessionMessages(chat.resume.file) : undefined;
    const mode = chat.agent?.policy.mode;
    await chat.agent?.dispose();
    chat.originals = JSON.parse(JSON.stringify(cfg.profiles));
    chat.baseProfile = cfg.profile;
    if (chat.selection.choice || chat.selection.effort) {
      try {
        applySelection(cfg, chat.originals!, chat.baseProfile, chat.selection);
      } catch (e) {
        this.post({ type: 'error', chatId: chat.id, message: (e as Error).message });
        chat.selection = {};
      }
    }
    chat.agent = await Agent.create({
      workspace: ws,
      config: cfg,
      ui: this.ui(chat),
      host: chat.host,
      surface: 'VS Code (the user sees your messages in a chat panel; your edits go into the editor buffers and the user reviews them)',
      bundledSkillsDir: path.join(this.ctx.extensionPath, 'resources', 'skills'),
      bundledAgentsDir: path.join(this.ctx.extensionPath, 'resources', 'agents'),
      extraTools: [diagnosticsTool()],
    });
    if (mode) chat.agent.setMode(mode);
    if (history?.length) chat.agent.loadHistory(history);
    if (chat.resume) chat.agent.journalWrite({ type: 'resumed_from', session: chat.resume.id });
    chat.resume = undefined;
    chat.agentKey = key;
    for (const st of chat.agent.mcp?.status() ?? []) this.log.appendLine(`[mcp] ${st.name}: ${st.status} ${st.error ?? ''}`);
    this.updateStatus();
    this.sendStatus();
    return chat.agent;
  }

  /** The endpoint the next agent would use, when no agent exists yet (governed config, not contributed defaults). */
  private fallbackProfile(): { model: string; baseUrl: string; mode: string } {
    try {
      const cfg = this.lastConfig ?? loadConfig({ workspace: this.workspaceRoot() ?? process.cwd(), trusted: false });
      const p = clientProfile(cfg);
      // lastConfig is from the last build: the VS Code settings (which win, see settingsConfig) may have changed since
      const s = vscode.workspace.getConfiguration('tugline');
      return { model: s.get<string>('model') || p.model, baseUrl: s.get<string>('baseUrl') || p.baseUrl, mode: cfg.permissionMode };
    } catch {
      const s = vscode.workspace.getConfiguration('tugline');
      return { model: s.get<string>('model') ?? '', baseUrl: s.get<string>('baseUrl') ?? '', mode: s.get<string>('permissionMode') ?? 'ask' };
    }
  }

  updateStatus(): void {
    const fb = this.fallbackProfile();
    // an idle chat is rebuilt from the settings at its next send, so show the settings (UI tour: the status bar kept the
    // old model after the setting changed); a running chat, or one with its own model pick, shows the agent's model
    const c = this.active;
    const a = c?.agent && (c.agent.isRunning || c.busy || c.selection?.choice) ? c.agent : undefined;
    const model = a?.llm.profile.model ?? fb.model;
    const baseUrl = a?.llm.profile.baseUrl ?? fb.baseUrl;
    this.status.text = `$(hubot) ${model}`;
    this.status.tooltip = `Tugline: ${model} @ ${baseUrl} — click to configure`;
    this.updateSandboxStatus();
  }

  /** N30: `sandboxStatus(cfg).summary` in the status bar; warning style when unsandboxed in auto mode, error when refusing. */
  updateSandboxStatus(): void {
    const cfg = this.active?.agent?.config ?? this.lastConfig;
    if (!this.sandboxItem) return;
    if (!cfg) {
      this.sandboxItem.hide();
      return;
    }
    let st;
    try {
      st = sandboxStatus(cfg);
    } catch (e) {
      st = { runner: 'none' as const, refusing: false, summary: `sandbox: unknown (${(e as Error).message})` };
    }
    const mode = this.active?.agent?.policy.mode ?? cfg.permissionMode;
    const b = sandboxBadge(st, mode);
    this.lastSandbox = { ...b, summary: st.summary };
    this.sandboxItem.text = b.text;
    this.sandboxItem.tooltip = b.tooltip;
    this.sandboxItem.backgroundColor = b.level === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : b.level === 'warn' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.sandboxItem.show();
  }

  sendStatus(): void {
    const chat = this.active;
    if (!chat) return;
    const a = chat.agent;
    const fb = this.fallbackProfile();
    let items: { value: string; label: string; group: string }[] = [];
    try {
      const cfg = a?.config ?? loadConfig({ workspace: this.workspaceRoot() ?? process.cwd(), trusted: false });
      items = pickerItems({ ...cfg, profiles: chat.originals ?? cfg.profiles }, this.endpointModels, chat.selection.choice, vscode.workspace.getConfiguration('tugline').get<string[]>('favoriteModels', []));
    } catch {
      /* config errors are shown when the agent is built */
    }
    this.post({
      type: 'status',
      chatId: chat.id,
      model: a?.llm.profile.model ?? fb.model,
      baseUrl: a?.llm.profile.baseUrl ?? fb.baseUrl,
      mode: a?.policy.mode ?? fb.mode,
      running: chat.busy,
      skills: a?.skills.list().map((k) => k.name) ?? [],
      picker: items,
      choice: chat.selection.choice ?? '',
      effort: chat.selection.effort ?? 'default',
    });
  }

  /** Fetch the endpoint's /models for the picker (best effort). */
  async refreshModels(): Promise<void> {
    try {
      // the governed profile: a locked endpoint gets the key, never the settings URL
      const cfg = await this.buildConfig(this.workspaceRoot() ?? process.cwd());
      this.endpointModels = await new LLMClient({ ...clientProfile(cfg), timeoutMs: 5000 }).listModels();
    } catch {
      this.endpointModels = [];
    }
    this.sendStatus();
  }

  addContext(text: string, source = 'selection'): void {
    this.active.queuedContext.push({ source, text });
    this.post({ type: 'contextAdded', chatId: this.activeId, count: this.active.queuedContext.length, preview: text.slice(0, 200) });
    void vscode.commands.executeCommand('tugline.chat.focus');
  }

  /** Text the composer received from the host (preview mentions, voice), as the webview reported it back (tests). */
  lastComposerValue = '';

  /** Insert text at the composer's cursor (N24 source mention, N25 transcript). */
  insertInComposer(text: string): void {
    this.post({ type: 'composerInsert', chatId: this.activeId, text });
    void vscode.commands.executeCommand('tugline.chat.focus');
  }

  /** Resolve every pending approval/question of a chat (or all) so an aborted run can finish. */
  private cancelPending(chatId?: string): void {
    for (const [id, p] of this.pending) {
      if (chatId && p.chatId !== chatId) continue;
      if (p.kind === 'permission') p.resolve({ decision: 'deny', feedback: 'cancelled by the user' });
      else if (p.kind === 'plan') p.resolve(false);
      else p.resolve('(the user cancelled the run)');
      this.post({ type: 'cancelPending', id });
      this.pending.delete(id);
    }
  }

  clearChat(): void {
    const c = this.active;
    c.agent?.abort();
    this.cancelPending(c.id);
    c.agent?.clear();
    c.queuedContext = [];
    c.uidIndex.clear();
    c.meter = emptyMeter();
    this.post({ type: 'cleared', chatId: c.id });
  }

  stop(chatId = this.activeId): void {
    this.chats.get(chatId)?.agent?.abort();
    this.cancelPending(chatId);
  }

  /** Emergency stop (F7): abort every chat, cancel every prompt, interrupt visible terminals. */
  stopAll(): void {
    for (const c of this.chats.values()) {
      c.agent?.abort();
      c.runner?.interrupt();
    }
    this.cancelPending();
  }

  async testConnection(): Promise<void> {
    const ws = this.workspaceRoot() ?? process.cwd();
    const cfg = await this.buildConfig(ws);
    const p = clientProfile(cfg) as any;
    // WS9: endpoint down or model not installed → the clickable card instead of a probe that can only fail
    const card = await this.checkSetup();
    if (card) {
      void vscode.window.showWarningMessage(card.state === 'unreachable' ? `Tugline: cannot reach ${p.baseUrl}. Pick a local server in the chat panel, or configure another endpoint.` : `Tugline: model "${p.model}" is not available at ${p.baseUrl}. Pick one in the chat panel.`);
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Tugline: testing ${p.model} @ ${p.baseUrl}…` }, async () => {
      const r = await probeEndpoint({ name: 'probe', contextWindow: 32768, maxOutputTokens: 1024, toolMode: 'auto', vision: false, ...p });
      const ollama = await this.ollamaSummary(p).catch(() => undefined);
      this.post({ type: 'probe', chatId: this.activeId, report: r, ollama });
      // not awaited: the progress notification closes when the probe is done, not when the message is dismissed
      if (r.chatOk) {
        void vscode.window.showInformationMessage(`Tugline: connected to ${p.model}. Native tool calling: ${r.nativeTools ? 'yes' : 'no'}; text protocol: ${r.textTools ? 'yes' : 'no'}. Recommended tool mode: ${r.recommendedToolMode}.${ollama ? ` ${ollama}` : ''}`, 'Use recommended').then((pick) => {
          if (pick) void vscode.workspace.getConfiguration('tugline').update('toolMode', r.recommendedToolMode, vscode.ConfigurationTarget.Global);
        });
      } else void vscode.window.showErrorMessage(`Tugline: connection failed — ${r.errors.join(' | ')}`);
    });
  }

  // ------------------------------------------------------------ onboarding (WS9)

  /** Local servers the onboarding card probes (tests point these at mock servers). */
  onboardingCandidates: LocalServer[] = LOCAL_SERVERS;
  /** Test hook: the last card posted (null = cleared). */
  lastOnboarding?: OnboardingView | null;

  private postOnboarding(view: OnboardingView | null): void {
    this.lastOnboarding = view;
    this.post({ type: 'onboarding', chatId: this.activeId, view });
  }

  /**
   * Show the onboarding card when the endpoint does not answer or the model is
   * not installed; clear it otherwise. Never for a managed (locked) endpoint.
   */
  async checkSetup(): Promise<OnboardingView | undefined> {
    const cfg = await this.buildConfig(this.workspaceRoot() ?? process.cwd());
    const locked = lockedFields(cfg);
    if (locked?.baseUrl || locked?.model) return undefined;
    const view = await setupCheck(clientProfile(cfg), { candidates: this.onboardingCandidates });
    this.postOnboarding(view ?? null);
    return view;
  }

  /** One line about what Ollama runs the model with (context, capabilities), or undefined for other servers. */
  private async ollamaSummary(p: { baseUrl: string; model: string }): Promise<string | undefined> {
    if (!(await detectOllama(p.baseUrl, { probeRoot: true }))) return undefined;
    const info = await ollamaModelInfo(p.baseUrl, p.model);
    const eff = effectiveContext(info);
    const caps = (info.capabilities ?? []).filter((c) => c !== 'completion').join(', ') || 'none reported';
    const ctx = eff ? `${eff}-token context${info.loadedContext ? '' : ' (until loaded; the app setting applies)'}` : 'context unknown until the model is loaded';
    return `Ollama runs ${p.model} with a ${ctx}; capabilities: ${caps}. The context is detected automatically (${OLLAMA_SETTINGS_HINT}).`;
  }

  /** Button clicks on the onboarding card. */
  async onboardAction(m: { action: string; baseUrl?: string; model?: string }): Promise<void> {
    const s = vscode.workspace.getConfiguration('tugline');
    const cfg = await this.buildConfig(this.workspaceRoot() ?? process.cwd());
    const locked = lockedFields(cfg);
    if ((locked?.baseUrl || locked?.model) && (m.action === 'useServer' || m.action === 'pickModel')) {
      this.post({ type: 'notice', chatId: this.activeId, level: 'warn', message: 'The model endpoint is locked by your organisation\'s managed policy.' });
      return;
    }
    switch (m.action) {
      case 'useServer': {
        if (!m.baseUrl || !/^https?:\/\//.test(m.baseUrl)) return;
        await s.update('baseUrl', m.baseUrl, vscode.ConfigurationTarget.Global);
        const fresh = clientProfile(await this.buildConfig(this.workspaceRoot() ?? process.cwd()));
        this.postOnboarding(await serverModels(fresh, { candidates: this.onboardingCandidates }));
        this.updateStatus();
        return;
      }
      case 'pickModel': {
        if (!m.model) return;
        await s.update('model', m.model, vscode.ConfigurationTarget.Global);
        for (const c of this.chats.values()) if (!c.busy) c.agentKey = '';
        this.updateStatus();
        this.sendStatus();
        this.postOnboarding(null);
        this.post({ type: 'notice', chatId: this.activeId, level: 'info', message: `Model set to ${m.model}. Testing the connection…` });
        void this.refreshModels();
        await this.testConnection();
        return;
      }
      case 'retry':
        if (!(await this.checkSetup())) await this.testConnection();
        return;
      case 'dismiss':
        this.postOnboarding(null);
        return;
    }
  }

  // ------------------------------------------------------------ sending (B4, B5, B7)

  mentionEnv(agent: Agent): MentionEnv {
    const ws = agent.workspace;
    return {
      workspace: ws,
      policy: agent.policy,
      diagnostics: (abs) => {
        const entries = abs ? [[vscode.Uri.file(abs), vscode.languages.getDiagnostics(vscode.Uri.file(abs))] as const] : vscode.languages.getDiagnostics();
        const out: MentionDiagnostic[] = [];
        for (const [uri, diags] of entries) {
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
          for (const d of diags) {
            if (d.severity > vscode.DiagnosticSeverity.Information) continue;
            let context: string | undefined;
            if (doc) {
              const from = Math.max(0, d.range.start.line - 2);
              const to = Math.min(doc.lineCount - 1, d.range.start.line + 2);
              context = Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i + 1).padStart(5)}${from + i === d.range.start.line ? '>' : ' '} ${doc.lineAt(from + i).text}`).join('\n');
            }
            out.push({ path: uri.fsPath, line: d.range.start.line + 1, col: d.range.start.character + 1, severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info', message: d.message, source: d.source, context });
          }
        }
        return out;
      },
      terminalOutput: () => this.terminals.lastOutput(),
      git: async (args) => {
        const r = await execCommand({ argv: ['git', ...args], cwd: ws, timeoutMs: 15_000, env: scrubbedEnv(agent.config.shell.scrubEnv), wrap: commandWrapperFor(agent.config) });
        return { code: r.exitCode, output: r.output };
      },
      fetchUrl: async (url) => {
        const ctl = new AbortController();
        const out = await webFetchTool.run({ url }, { config: agent.config, signal: ctl.signal, smallLlm: agent.smallLlm } as any);
        return out.output;
      },
      skill: (name) => agent.skills.load(name),
    };
  }

  private async imageTexts(agent: Agent, images: PastedImage[]): Promise<{ texts: ImageText[]; notices: string[] }> {
    const ide = ideConfig(agent.config);
    const texts: ImageText[] = [];
    const notices: string[] = [];
    for (const img of images) {
      const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(img.dataUrl);
      if (!m) continue;
      if (ide.visionProfile && agent.config.profiles[ide.visionProfile]) {
        try {
          const c = new LLMClient({ ...clientProfile(agent.config, ide.visionProfile), vision: true });
          // R4: admitted in the chat agent's scope like every agent call (refused when a limit is exhausted)
          const r = await admittedComplete(c, { messages: [{ role: 'user', content: [{ type: 'text', text: describePrompt() }, { type: 'image_url', image_url: { url: img.dataUrl } }] }], maxTokens: 1200, noStream: true }, { agent, config: agent.config, kind: 'vision', role: 'vision' });
          if (r.text.trim()) {
            texts.push({ name: img.name, via: 'description', text: r.text });
            continue;
          }
        } catch (e) {
          notices.push(`vision profile failed for ${img.name}: ${(e as Error).message}`);
        }
      }
      if (ide.ocr) {
        try {
          const dir = path.join(agent.workspace, '.tugline', 'tmp');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `paste-${Date.now()}.${m[1].split('/')[1] === 'jpeg' ? 'jpg' : m[1].split('/')[1]}`);
          fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
          try {
            const r = await execCommand({ argv: ['tesseract', path.basename(file), 'stdout'], cwd: dir, timeoutMs: 30_000, env: scrubbedEnv(agent.config.shell.scrubEnv), wrap: commandWrapperFor(agent.config) });
            if (r.exitCode === 0 && r.output.trim()) texts.push({ name: img.name, via: 'ocr', text: r.output.replace(/^(Estimating resolution|Detected \d+ diacritics|Tesseract Open Source).*$/gm, '') });
            else notices.push(`OCR found no text in ${img.name}${r.exitCode === 127 ? ' (tesseract is not installed)' : ''}`);
          } finally {
            fs.rmSync(file, { force: true });
          }
        } catch (e) {
          notices.push(`OCR failed for ${img.name}: ${(e as Error).message}`);
        }
      }
    }
    return { texts, notices };
  }

  /** Build the final prompt for a message: mentions, editor context, attached snippets, review notes, images. */
  async buildPrompt(chat: ChatState, agent: Agent, text: string, opts: { includeFile?: boolean; images?: PastedImage[] }): Promise<string | ContentPart[]> {
    const m = await resolveMentions(text, this.mentionEnv(agent));
    for (const s of m.skipped) this.post({ type: 'notice', chatId: chat.id, level: 'warn', message: `${s.source} not attached: ${s.reason}` });
    let prompt = m.text;
    const ed = vscode.window.activeTextEditor;
    if (opts.includeFile && ed && ed.document.uri.scheme === 'file') {
      const rel = path.relative(agent.workspace, ed.document.uri.fsPath);
      const sel = ed.selection.isEmpty ? '' : `\nSelected lines ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}:\n\`\`\`\n${ed.document.getText(ed.selection)}\n\`\`\``;
      prompt += `\n\n${attachmentBlock('ide_context', {}, `The user has ${rel} open in the editor (cursor at line ${ed.selection.active.line + 1}).${sel}`)}`;
    }
    if (chat.queuedContext.length) {
      for (const source of [...new Set(chat.queuedContext.map((c) => c.source))])
        prompt += `\n\n${attachmentBlock(
          'attached_context',
          { source },
          chat.queuedContext
            .filter((c) => c.source === source)
            .map((c) => c.text)
            .join('\n\n'),
        )}`;
      chat.queuedContext = [];
    }
    const notes = this.review.drainNotes();
    if (notes.length) prompt += `\n\n${attachmentBlock('ide_context', {}, notes.join('\n'))}`;
    if (opts.images?.length) {
      const vision = !!agent.llm.profile.vision;
      const t = vision ? { texts: [], notices: [] } : await this.imageTexts(agent, opts.images);
      const built = buildUserMessage(prompt, opts.images, { vision, imageTexts: t.texts });
      for (const n of [...t.notices, ...built.notices]) this.post({ type: 'notice', chatId: chat.id, level: 'warn', message: n });
      return built.content;
    }
    return prompt;
  }

  /** Run a slash command for a chat; its output is shown as a notice in that chat. */
  async runSlash(chat: ChatState, agent: Agent, text: string): Promise<{ handled: boolean; prompt?: string }> {
    return dispatchSlash(text, {
      agent,
      write: (t) => this.post({ type: 'notice', chatId: chat.id, level: 'cmd', message: t }),
      ask: async (question, options) =>
        options?.length ? ((await vscode.window.showQuickPick(options, { title: question, ignoreFocusOut: true })) ?? '') : ((await vscode.window.showInputBox({ title: question, ignoreFocusOut: true })) ?? ''),
      newChat: () => void this.newChat(),
      setModel: (choice) => this.setModel(chat, { choice }),
    });
  }

  /** Send a message in a chat. While the agent works the message is queued (B7). */
  async send(chat: ChatState, text: string, opts: { includeFile?: boolean; images?: PastedImage[]; uid?: string } = {}): Promise<void> {
    const agent = await this.getAgent(chat);
    if (!agent) return;
    // S0.6: "/command args" goes through the core slash-command registry (as in the CLI).
    if (text.trim().startsWith('/') && !opts.images?.length) {
      const r = await this.runSlash(chat, agent, text);
      if (r.handled) {
        if (r.prompt) return this.send(chat, r.prompt, { ...opts, uid: opts.uid });
        return;
      }
    }
    const uid = opts.uid ?? newUid();
    // v1.2 N45: prompt decorators (IDE context of open editors and the selection, when enabled)
    for (const d of this.promptDecorators) text = d(text);
    const content = await this.buildPrompt(chat, agent, text, opts);
    if (chat.title === 'New chat') {
      chat.title = titleFromPrompt(text);
      this.postChats();
    }
    chat.uiQueue.push({ uid, text: contentToText(content) });
    if (chat.busy || agent.isRunning || agent.queued > 0) {
      agent.enqueue(content);
      this.sessionHook?.(chat.id, { type: 'queued', count: agent.queued });
      this.post({ type: 'queued', chatId: chat.id, uid, position: agent.queued });
      return;
    }
    chat.busy = true;
    this.post({ type: 'running', chatId: chat.id, running: true });
    this.postChats();
    try {
      await agent.run(content);
      await agent.idle();
    } catch (e) {
      this.post({ type: 'error', chatId: chat.id, message: (e as Error).message });
    } finally {
      chat.busy = false;
      chat.uiQueue = [];
      this.post({ type: 'running', chatId: chat.id, running: false });
      this.postChats();
      this.postMeter(chat);
    }
  }

  /** Programmatic prompt (tests and other extensions). Resolves when the chat is idle. */
  async sendPrompt(text: string, opts: { chatId?: string; images?: PastedImage[] } = {}): Promise<string> {
    const chat = this.chats.get(opts.chatId ?? this.activeId) ?? this.active;
    const uid = newUid();
    this.post({ type: 'userMessage', chatId: chat.id, text, uid });
    await this.send(chat, text, { includeFile: false, images: opts.images, uid });
    return uid;
  }

  /** Steer the running agent (B7): injected at the next tool boundary. Idle: sent as a normal message. */
  async steer(chat: ChatState, text: string): Promise<void> {
    if (!chat.agent || !chat.busy) return this.send(chat, text);
    chat.agent.steer(text);
  }

  /**
   * Edit and resubmit an earlier message (B7 AC3): the conversation is cut back
   * to before that message (core truncateTo) and, if asked, the files are
   * restored from the checkpoint taken at the start of that run (C1).
   */
  async editResubmit(chat: ChatState, uid: string, text: string, restoreFiles = false): Promise<{ truncatedTo: number; restored?: string[] } | undefined> {
    const info = chat.uidIndex.get(uid);
    const agent = chat.agent;
    if (!info || !agent) {
      this.post({ type: 'error', chatId: chat.id, message: 'That message can no longer be edited (the conversation was compacted or reloaded).' });
      return undefined;
    }
    if (chat.busy || agent.isRunning) {
      agent.abort();
      this.cancelPending(chat.id);
      await agent.idle();
      while (chat.busy) await new Promise((r) => setTimeout(r, 20));
    }
    let restored: string[] | undefined;
    if (restoreFiles) {
      const m = checkpointsFor(agent.config, agent.workspace);
      const cp = (await m.list(1000)).find((c) => c.kind === 'turn' && c.sessionId === agent.sessionId && (c.runId === info.runId || c.messageIndex === info.index) && c.turn === 1);
      if (cp) {
        const r = await m.restore(cp.id, { files: true, agent });
        restored = [...r.restored, ...r.removed];
        this.post({ type: 'notice', chatId: chat.id, level: 'info', message: `Files restored to checkpoint ${cp.id.slice(0, 8)} (${restored.length} file(s)).` });
      } else this.post({ type: 'notice', chatId: chat.id, level: 'warn', message: 'No checkpoint found for that message; files were not restored.' });
    }
    agent.truncateTo(info.index);
    for (const [u, i] of [...chat.uidIndex]) if (i.index >= info.index) chat.uidIndex.delete(u);
    this.post({ type: 'truncated', chatId: chat.id, uid });
    const nu = newUid();
    this.post({ type: 'userMessage', chatId: chat.id, text, uid: nu });
    await this.send(chat, text, { uid: nu });
    return { truncatedTo: info.index, restored };
  }

  // ------------------------------------------------------------ side views

  async postPending(): Promise<void> {
    const files = await this.review.list();
    this.post({ type: 'pending', files: files.map((f) => ({ ...f, rel: vscode.workspace.asRelativePath(vscode.Uri.parse(f.uri)) })) });
  }

  async postCheckpoints(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) return;
    const agent = this.active.agent;
    const cfg = agent?.config ?? (await this.buildConfig(ws));
    const m = checkpointsFor(cfg, ws);
    let list: any[] = [];
    try {
      list = await m.list(200);
    } catch (e) {
      this.post({ type: 'checkpoints', list: [], error: (e as Error).message });
      return;
    }
    this.post({ type: 'checkpoints', sessionId: agent?.sessionId, disabled: m.disabledReason, list: list.map((c) => ({ ...c, label: c.label.replace(/\s*<(repo_map|attached_context)\b[\s\S]*$/, ''), mine: !!agent && c.sessionId === agent.sessionId })) });
  }

  async checkpointAction(action: string, id: string, scope: 'files' | 'chat' | 'both' = 'files'): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) return;
    const agent = this.active.agent;
    const cfg = agent?.config ?? (await this.buildConfig(ws));
    const m = checkpointsFor(cfg, ws);
    if (action === 'diff') {
      const d = await m.diff(id);
      const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: d.patch || d.files.map((f) => `${f.status} ${f.path}`).join('\n') || '(no changes since this checkpoint)' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    if (action === 'restore') {
      if (this.active.busy) {
        this.post({ type: 'error', chatId: this.activeId, message: 'Stop the agent before restoring a checkpoint.' });
        return;
      }
      const r = await m.restore(id, { files: scope !== 'chat', conversation: scope !== 'files', agent });
      const msg = `Restored ${r.checkpoint.label.replace(/\s*<(repo_map|attached_context)\b[\s\S]*$/, '')}: ${r.restored.length} file(s) restored, ${r.removed.length} removed${r.conversationLength !== undefined ? `, conversation cut to ${r.conversationLength} message(s)` : ''}${r.conversationSkipped ? ` (conversation not restored: ${r.conversationSkipped})` : ''}.${r.preRestoreId ? ` Undo with checkpoint ${r.preRestoreId.slice(0, 8)}.` : ''}`;
      this.post({ type: 'notice', chatId: this.activeId, level: 'info', message: msg });
      if (r.conversationLength !== undefined) this.post({ type: 'notice', chatId: this.activeId, level: 'info', message: '(earlier messages above this point are no longer in the agent\'s context)' });
      await this.postCheckpoints();
    }
  }

  async postManage(registry?: any[]): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) return;
    const cfg = this.active.agent?.config ?? (await this.buildConfig(ws));
    const status = this.active.agent?.mcp?.status() ?? [];
    const sources = ((cfg as any).__mcpSources ?? {}) as Record<string, string>;
    const servers = Object.entries(cfg.mcpServers).map(([name, s]) => {
      const st = status.find((x) => x.name === name);
      return { name, source: sources[name] ?? 'project', transport: s.url ? 'http' : 'stdio', target: s.url ?? [s.command, ...(s.args ?? [])].join(' '), disabled: !!s.disabled, trusted: !!s.trusted, status: s.disabled ? 'disabled' : (st?.status ?? 'not started'), tools: st?.tools ?? 0, error: st?.error, warnings: st?.warnings ?? [] };
    });
    const all = new SkillManager(defaultSkillDirs(ws, path.join(this.ctx.extensionPath, 'resources', 'skills'), cfg.skills.dirs)).list();
    const disabled = new Set(cfg.skills.disabled);
    const skills = all.map((s) => ({ name: s.name, description: s.description, source: s.source, file: s.file, enabled: !disabled.has(s.name) }));
    this.post({ type: 'manage', servers, skills, registry, trusted: cfg.trust?.workspaceTrusted ?? false });
  }

  private async rebuildActive(): Promise<void> {
    const c = this.active;
    if (c.busy) {
      this.post({ type: 'notice', chatId: c.id, level: 'info', message: 'Changes apply after the current run.' });
      return;
    }
    c.agentKey = '';
    await this.getAgent(c);
  }

  async manageAction(m: any): Promise<void> {
    const ws = this.workspaceRoot();
    const home = (this.active.agent?.config ?? (await this.buildConfig(ws ?? process.cwd()))).homeDir;
    const userFile = configFile('user', home);
    const sources = ((this.active.agent?.config as any)?.__mcpSources ?? {}) as Record<string, 'user' | 'project'>;
    switch (m.action) {
      case 'toggleServer':
        setMcpToggle(userFile, mcpToggleKey(m.name, sources[m.name] ?? 'project', ws), { disabled: !m.enabled });
        await this.rebuildActive();
        break;
      case 'trustServer':
        setMcpToggle(userFile, mcpToggleKey(m.name, sources[m.name] ?? 'project', ws), { trusted: !!m.trusted });
        await this.rebuildActive();
        break;
      case 'removeServer':
        removeMcpServer(userFile, m.name);
        await this.rebuildActive();
        break;
      case 'addServer':
        addMcpServer(userFile, m.name || localServerName(m.registryName ?? 'server'), m.config);
        await this.rebuildActive();
        break;
      case 'searchRegistry': {
        let registry: any[] = [];
        try {
          const r = await fetch(`${MCP_REGISTRY_URL}?search=${encodeURIComponent(m.query ?? '')}&limit=20`, { signal: AbortSignal.timeout(8000) });
          registry = r.ok ? parseRegistry(await r.json()) : [];
          if (!r.ok) this.post({ type: 'notice', chatId: this.activeId, level: 'warn', message: `MCP registry: HTTP ${r.status}` });
        } catch (e) {
          this.post({ type: 'notice', chatId: this.activeId, level: 'warn', message: `MCP registry unreachable: ${(e as Error).message}` });
        }
        await this.postManage(registry);
        return;
      }
      case 'oauth': {
        // G3: browser login (loopback redirect, PKCE, state); tokens go to <homeDir>/mcp-oauth (0600).
        const servers = this.active.agent?.config.mcpServers ?? (await this.buildConfig(ws ?? process.cwd())).mcpServers;
        try {
          const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Tugline: log in to ${m.name} in your browser…`, cancellable: false }, () =>
            loginMcpServer(m.name, servers, sources[m.name], { homeDir: home, userFile, openUrl: async (u) => void (await vscode.env.openExternal(vscode.Uri.parse(u.href))), log: (t) => this.log.appendLine(`[mcp ${m.name}] ${t}`), timeoutMs: m.timeoutMs }),
          );
          this.post({ type: 'notice', chatId: this.activeId, level: 'info', message: r.message });
          await this.rebuildActive();
        } catch (e) {
          this.post({ type: 'notice', chatId: this.activeId, level: 'warn', message: `MCP login to ${m.name} failed: ${(e as Error).message}` });
        }
        break;
      }
      case 'logout':
        this.post({ type: 'notice', chatId: this.activeId, level: 'info', message: logoutMcpServer(m.name, home) });
        await this.rebuildActive();
        break;
      case 'toggleSkill':
        setSkillEnabled(userFile, m.name, !!m.enabled);
        await this.rebuildActive();
        break;
      case 'openSkill':
        if (m.file && fs.existsSync(m.file)) await vscode.window.showTextDocument(vscode.Uri.file(m.file));
        return;
      case 'createSkill': {
        const what = await vscode.window.showInputBox({ title: 'New skill', prompt: 'What should the skill teach the agent?', ignoreFocusOut: true });
        if (what) await this.sendPrompt(`/skill-creator Create a project skill in .tugline/skills/ for: ${what}`);
        return;
      }
    }
    await this.postManage();
  }

  async postSettings(): Promise<void> {
    const ws = this.workspaceRoot();
    const home = (this.active.agent?.config ?? (await this.buildConfig(ws ?? process.cwd()))).homeDir;
    const read = (scope: ConfigScope) => {
      try {
        const f = configFile(scope, home, ws);
        return { file: f, data: readConfigFile(f), exists: fs.existsSync(f) };
      } catch (e) {
        return { file: '', data: {}, exists: false, error: (e as Error).message };
      }
    };
    const rules = (scope: ConfigScope) => {
      try {
        const f = rulesFile(scope, home, ws);
        return { file: f, text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, 20000) : '' };
      } catch {
        return { file: '', text: '' };
      }
    };
    const cfg = this.active.agent?.config;
    this.post({ type: 'settings', user: read('user'), project: read('project'), rules: { user: rules('user'), project: rules('project') }, trusted: cfg?.trust?.workspaceTrusted ?? false, hasWorkspace: !!ws });
  }

  async settingsAction(m: any): Promise<void> {
    const ws = this.workspaceRoot();
    const home = (this.active.agent?.config ?? (await this.buildConfig(ws ?? process.cwd()))).homeDir;
    const scope: ConfigScope = m.scope === 'project' ? 'project' : 'user';
    const file = configFile(scope, home, ws);
    switch (m.action) {
      case 'protectedPaths':
        setProtectedPaths(file, m.value);
        break;
      case 'rules':
        setPermissionRules(file, { allow: m.allow, deny: m.deny });
        break;
      case 'mode':
        setPermissionMode(file, m.value);
        break;
      case 'hooks':
        setHooks(file, m.event, m.hooks);
        break;
      case 'rulesFile': {
        const f = rulesFile(scope, home, ws);
        if (!fs.existsSync(f)) fs.writeFileSync(f, '# Rules for the agent\n\n');
        await vscode.window.showTextDocument(vscode.Uri.file(f));
        return;
      }
      case 'vscodeSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'tugline');
        return;
      case 'openFile':
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, '{}\n');
        }
        await vscode.window.showTextDocument(vscode.Uri.file(file));
        return;
    }
    this.post({ type: 'notice', chatId: this.activeId, level: 'info', message: `Saved ${scope} config (${file}).${scope === 'project' ? ' Project config applies in full only when you trust this workspace; until then only deny rules and protected paths take effect.' : ''}` });
    for (const c of this.chats.values()) if (!c.busy) c.agentKey = '';
    await this.postSettings();
  }

  async mentionItems(q: string): Promise<{ label: string; insert: string; detail?: string }[]> {
    const items = SPECIAL_ITEMS.filter((i) => i.label.slice(1).startsWith(q.toLowerCase()) || !q);
    const skillQ = q.startsWith('skill:') ? q.slice(6) : undefined;
    if (skillQ !== undefined) {
      return (this.active.agent?.skills.list() ?? []).filter((s) => s.name.startsWith(skillQ)).map((s) => ({ label: `@skill:${s.name}`, insert: `@skill:${s.name} `, detail: s.description.slice(0, 80) }));
    }
    if (q.startsWith('url:') || q.startsWith('git:') || q.startsWith('problems:')) return [];
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/.venv/**,**/__pycache__/**}', 3000);
    const files = uris.map((u) => vscode.workspace.asRelativePath(u, false));
    const folders = [...new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/') + '/')))];
    const ranked = rankFiles(q, [...folders, ...files], 25).map((f) => ({ label: `@${f}`, insert: `@${f} `, detail: f.endsWith('/') ? 'folder' : 'file' }));
    return [...items.map((i) => ({ label: i.label, insert: i.insert, detail: i.detail })), ...ranked].slice(0, 30);
  }

  // ------------------------------------------------------------ messages from the webview

  async onMessage(m: any): Promise<void> {
    const chat = (m.chatId && this.chats.get(m.chatId)) || this.active;
    switch (m.type) {
      case 'ready':
        this.postChats();
        this.sendStatus();
        this.postMeter(chat);
        void this.postPending();
        // first run: an unreachable endpoint or a model that isn't installed shows the clickable onboarding card
        void this.refreshModels().then(() => this.checkSetup()).catch((e) => this.log.appendLine(`[onboarding] ${(e as Error).message}`));
        return;
      case 'send':
        await this.send(chat, String(m.text ?? ''), { includeFile: !!m.includeFile, images: m.images, uid: m.uid });
        return;
      case 'steer':
        await this.steer(chat, String(m.text ?? ''));
        return;
      case 'editResubmit':
        await this.editResubmit(chat, m.uid, String(m.text ?? ''), !!m.restoreFiles);
        return;
      case 'stop':
        this.stop(chat.id);
        return;
      case 'newChat':
        this.newChat();
        return;
      case 'switchChat':
        this.switchChat(m.chatId);
        return;
      case 'closeChat':
        await this.closeChat(m.chatId);
        return;
      case 'setMode':
        // N43: the picker offers exactly the core's modes; yolo is loud
        if (!isPermissionMode(m.mode)) return void vscode.window.showErrorMessage(`Tugline: ${invalidModeMessage(m.mode)}`);
        if (m.mode === 'yolo') void vscode.window.showWarningMessage(`Tugline: ${YOLO_WARNING}`);
        if (chat.agent) chat.agent.setMode(m.mode);
        await vscode.workspace.getConfiguration('tugline').update('permissionMode', m.mode, vscode.ConfigurationTarget.Global).then(undefined, () => {});
        this.sendStatus();
        this.updateSandboxStatus();
        return;
      case 'setModel':
      case 'setEffort':
        await this.setModel(chat, m.type === 'setModel' ? { choice: m.value || undefined } : { effort: m.effort as Effort });
        return;
      case 'voice':
        await vscode.commands.executeCommand('tugline.voice.toggle');
        return;
      case 'composerValue':
        this.lastComposerValue = String(m.value ?? '');
        return;
      case 'permissionReply':
        this.pending.get(m.id)?.resolve({ decision: m.decision, feedback: m.feedback });
        this.pending.delete(m.id);
        return;
      case 'askReply':
        this.pending.get(m.id)?.resolve(m.answer);
        this.pending.delete(m.id);
        return;
      case 'planReply':
        this.pending.get(m.id)?.resolve(m.ok);
        this.pending.delete(m.id);
        return;
      case 'openFile': {
        const ws = this.workspaceRoot();
        const p = path.isAbsolute(m.path) ? m.path : path.join(ws ?? '', m.path);
        if (fs.existsSync(p)) await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true });
        return;
      }
      case 'onboard':
        await this.onboardAction(m);
        return;
      case 'configure':
        await vscode.commands.executeCommand('tugline.configure');
        return;
      case 'testConnection':
        await this.testConnection();
        return;
      case 'mentionQuery':
        this.post({ type: 'mentionItems', reqId: m.reqId, items: m.kind === 'slash' ? slashItems(chat.agent, String(m.q ?? '')) : await this.mentionItems(String(m.q ?? '')) });
        return;
      case 'review':
        if (m.action === 'keep') await this.review.keep(m.uri);
        else if (m.action === 'undo') await this.review.undo(m.uri);
        else if (m.action === 'diff') await this.review.openDiff(m.uri);
        else if (m.action === 'keepAll') await this.review.keepAll();
        else if (m.action === 'undoAll') await this.review.undoAll();
        else if (m.action === 'openAll') await this.review.openAll();
        else if (m.action === 'undoHunk' || m.action === 'keepHunk') await (m.action === 'undoHunk' ? this.review.undo(m.uri, m.hunk) : this.review.keep(m.uri, m.hunk));
        await this.postPending();
        return;
      case 'checkpoints':
        if (m.action === 'list') await this.postCheckpoints();
        else await this.checkpointAction(m.action, m.id, m.scope);
        return;
      case 'manage':
        if (m.action === 'load') await this.postManage();
        else await this.manageAction(m);
        return;
      case 'settings':
        if (m.action === 'load') await this.postSettings();
        else await this.settingsAction(m);
        return;
      case 'emergencyStop':
        await vscode.commands.executeCommand('tugline.emergencyStop');
        return;
    }
  }

  /** B8: switch model / effort for a chat; the next request uses it. */
  async setModel(chat: ChatState, sel: ModelSelection): Promise<void> {
    chat.selection = { ...chat.selection, ...sel };
    const agent = chat.agent ?? (await this.getAgent(chat));
    if (!agent || !chat.originals || !chat.baseProfile) return;
    try {
      const name = applySelection(agent.config, chat.originals, chat.baseProfile, chat.selection);
      agent.setProfile(name);
    } catch (e) {
      this.post({ type: 'error', chatId: chat.id, message: (e as Error).message });
    }
    this.updateStatus();
    this.sendStatus();
  }
}

export type { ChatState as Chat };
export { listSessions };

/** Close the diff tabs showing `modified` on their right side (an answered proposal). */
function closeDiffTabs(modified: vscode.Uri): void {
  try {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === modified.toString());
    if (tabs.length) void vscode.window.tabGroups.close(tabs, true).then(undefined, () => undefined);
  } catch {
    /* older VS Code: the tab stays */
  }
}
