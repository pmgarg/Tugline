// UI tour: drives the real extension (VS Code under Xvfb, scripted mock model) through every panel and saves a
// screenshot of each to TUG_TOUR_DIR, for a visual review. Not a pass/fail test: a step that fails is logged and the
// tour moves on. Run: cd vscode && npm run build && xvfb-run -a -s "-screen 0 1600x1000x24" node test/uiTour.mjs
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const OUT = process.env.TUG_TOUR_DIR || '/tmp/oh-ui-tour';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tc = (name, args) => ({ name, args });
const mock = { script: () => ({ content: 'ok' }), delayMs: 0, start: 0, n: 0, ollama: null, set(fn, d = 0) { this.script = fn; this.delayMs = d; this.start = this.n; } };

function mockServer() {
  const srv = http.createServer((req, res) => {
    const json = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const o = mock.ollama;
    if (o) {
      if (req.url === '/') return void res.end('Ollama is running');
      if (req.url === '/api/version') return json({ version: '0.12.6' });
      if (req.url === '/api/ps') return json({ models: [] });
      if (req.url === '/v1/models') return json({ object: 'list', data: o.models.map((id) => ({ id, object: 'model' })) });
      if (req.url === '/api/show') {
        let b = '';
        req.on('data', (d) => (b += d));
        req.on('end', () => json({ parameters: '', model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 }, capabilities: o.caps[JSON.parse(b || '{}').model] || ['completion'] }));
        return;
      }
    }
    if (req.url.endsWith('/models')) return json({ data: [{ id: 'qwen/qwen3.8-27b' }, { id: 'qwen/qwen3.8-9b' }, { id: 'other-model' }] });
    if (req.method === 'GET') { res.writeHead(404); return void res.end(); }
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const i = mock.n++ - mock.start;
      const r = mock.script(body, i) || { content: 'ok' };
      const calls = (r.calls || []).map((c, k) => ({ id: `c${mock.n}_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      setTimeout(() => {
        if (typeof body.prompt === 'string') return json({ choices: [{ index: 0, text: r.text ?? '', finish_reason: 'stop' }] });
        json({ choices: [{ index: 0, message: { role: 'assistant', content: r.content || '', tool_calls: calls.length ? calls : undefined }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1800, completion_tokens: 120 } });
      }, mock.delayMs);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const steps = (...s) => (_b, i) => s[Math.min(i, s.length - 1)];
const toolCount = (body) => body.messages.filter((m) => m.role === 'tool').length;

exports.run = async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const ws = process.env.TUG_E2E_WORKSPACE;
  const log = [];
  const shot = async (name, wait = 1500) => {
    await sleep(wait);
    try {
      execFileSync('import', ['-window', 'root', path.join(OUT, `${name}.png`)]);
      log.push(`shot ${name}`);
    } catch (e) {
      log.push(`shot ${name} FAILED ${e.message}`);
    }
  };
  const stepRun = async (name, fn) => {
    await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
    try {
      await Promise.race([fn(), sleep(90000).then(() => { throw new Error('timed out'); })]);
    } catch (e) {
      log.push(`step ${name} FAILED ${e.stack || e}`);
      console.log(`[tour] ${name} failed: ${e.message}`);
    }
  };
  const cmd = (c, ...a) => vscode.commands.executeCommand(c, ...a);
  const closeQuick = () => cmd('workbench.action.closeQuickOpen');
  const git = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8', stdio: 'pipe' });
  const write = (rel, c) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), c); };

  const srv = await mockServer();
  const mockUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  const cfg = vscode.workspace.getConfiguration('tugline');
  await cfg.update('baseUrl', mockUrl, vscode.ConfigurationTarget.Global);
  await cfg.update('model', 'qwen/qwen3.8-27b', vscode.ConfigurationTarget.Global);
  await cfg.update('permissionMode', 'ask', vscode.ConfigurationTarget.Global);
  await cfg.update('webSearchProvider', 'none', vscode.ConfigurationTarget.Global);
  await cfg.update('notifications', false, vscode.ConfigurationTarget.Global);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'tour@test');
  git('config', 'user.name', 'tour');
  git('config', 'commit.gpgsign', 'false');
  write('README.md', '# Sample project\n\nA small calculator used in the UI tour.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  const ext = vscode.extensions.all.find((e) => e.id.endsWith('tugline'));
  const api = await ext.activate();
  const P = api.provider;
  const X = api.parity;
  await cmd('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
  await cmd('workbench.view.extension.tugline');
  await cmd('tugline.chat.focus');
  if (process.env.TUG_TOUR_MARKETING) for (let i = 0; i < 6; i++) await cmd('workbench.action.decreaseViewWidth').then(undefined, () => undefined);
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'calc.py')));
  await shot('01-first-open', 3000);

  // onboarding: the configured model is not installed on a local (Ollama-like) server
  await stepRun('onboarding', async () => {
    mock.ollama = { models: ['qwen2.5-coder:7b', 'llama3.2:3b', 'nomic-embed-text:latest'], caps: { 'qwen2.5-coder:7b': ['completion', 'tools'], 'llama3.2:3b': ['completion', 'tools'], 'nomic-embed-text:latest': ['embedding'] } };
    await cfg.update('model', 'qwen3-coder:30b', vscode.ConfigurationTarget.Global);
    await P.testConnection();
    await shot('02-onboarding-missing-model');
    mock.ollama = null;
    P.lastOnboarding = undefined;
    await cfg.update('model', 'qwen/qwen3.8-27b', vscode.ConfigurationTarget.Global);
    await P.testConnection();
    await shot('03-connection-ok');
  });

  // a realistic run in "ask" mode: plan (todos), read, an edit that needs approval, a command, a final answer
  await stepRun('chat run with approval', async () => {
    P.newChat();
    mock.set(steps(
      { content: "I'll look at the failing test and the function first.", calls: [tc('todo_write', { todos: [{ content: 'Read calc.py and the test', status: 'in_progress' }, { content: 'Handle the empty list', status: 'pending' }, { content: 'Run the test', status: 'pending' }] }), tc('read_file', { path: 'calc.py' }), tc('read_file', { path: 'tests/test_calc.py' })] },
      { content: '`average([])` divides by zero. I\'ll return 0 for an empty list.', calls: [tc('edit_file', { path: 'calc.py', old_string: '    return sum(numbers) / len(numbers)', new_string: '    if not numbers:\n        return 0\n    return sum(numbers) / len(numbers)' })] },
      { calls: [tc('todo_write', { todos: [{ content: 'Read calc.py and the test', status: 'completed' }, { content: 'Handle the empty list', status: 'completed' }, { content: 'Run the test', status: 'in_progress' }] }), tc('bash', { command: 'python3 -c "from calc import average; print(average([]), average([2, 4]))"' })] },
      { content: '### Fixed\n\n`average()` in `calc.py` now returns **0** for an empty list instead of raising `ZeroDivisionError`.\n\n| Input | Before | After |\n|---|---|---|\n| `[]` | error | `0` |\n| `[2, 4]` | `3.0` | `3.0` |\n\nVerified by running both cases.' },
    ), 400);
    const done = P.sendPrompt('The test in tests/test_calc.py fails: average([]) should return 0. Fix calc.py and verify.');
    // answer each approval after a screenshot of the first two
    let shots = 0;
    const seen = new Set();
    for (let t = 0; t < 600; t++) {
      const perm = P.posted.filter((m) => m.type === 'permission' && !seen.has(m.id));
      for (const p of perm) {
        seen.add(p.id);
        if (shots < 2) await shot(shots++ === 0 ? '04-approval-edit' : '05-approval-command');
        P.answerPending(p.id, { decision: 'allow' });
      }
      const settled = await Promise.race([done.then(() => true), sleep(100).then(() => false)]);
      if (settled) break;
    }
    await shot('06-chat-after-run');
    await cmd('workbench.action.closeAllEditors');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'calc.py')));
    await shot('07-editor-pending-change-keep-undo');
    await cmd('tugline.review.openAll');
    await shot('08-review-all-changes', 2500);
    await cmd('workbench.action.closeAllEditors');
  });

  await stepRun('side tabs', async () => {
    for (const [v, n] of [['checkpoints', '09-tab-checkpoints'], ['manage', '10-tab-mcp-skills'], ['settings', '11-tab-settings']]) {
      await cmd('tugline.showView', v);
      await shot(n);
    }
    await cmd('tugline.chat.focus');
    for (let i = 0; i < 8; i++) await cmd('workbench.action.decreaseViewWidth').then(undefined, () => undefined);
    await cmd('tugline.showView', 'chat');
    await shot('12-chat-narrow-sidebar');
    for (let i = 0; i < 20; i++) await cmd('workbench.action.increaseViewWidth').then(undefined, () => undefined);
    await shot('13-chat-wide-sidebar');
    await cmd('tugline.showView', 'settings');
    await shot('13b-settings-wide-sidebar');
    await cmd('tugline.showView', 'chat');
  });

  await stepRun('quick picks', async () => {
    const pick = async (c, n, ...a) => {
      void cmd(c, ...a).then(undefined, () => undefined);
      await shot(n, 2000);
      await closeQuick();
      await sleep(400);
    };
    await pick('tugline.configure', '14-configure-endpoint');
    await pick('tugline.autoApprove', '15-auto-approve');
    await pick('workbench.action.quickOpen', '16-command-palette', '>Tugline: ');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'calc.py')));
    const ed = vscode.window.activeTextEditor;
    ed.selection = new vscode.Selection(0, 0, 2, 0);
    await pick('tugline.inlineEdit', '17-inline-edit-prompt');
  });

  await stepRun('agents and history trees', async () => {
    await cmd('tugline.agents.focus');
    await cmd('tugline.history.focus');
    await cmd('tugline.agents.focus');
    await shot('18-agents-and-history');
  });

  await stepRun('error state', async () => {
    const chat = P.newChat();
    await cfg.update('baseUrl', 'http://127.0.0.1:9/v1', vscode.ConfigurationTarget.Global);
    await P.sendPrompt('hello', { chatId: chat.id }).catch(() => undefined);
    await shot('19-error-endpoint-down');
    await cfg.update('baseUrl', mockUrl, vscode.ConfigurationTarget.Global);
  });

  await stepRun('arena', async () => {
    write('arena_math.py', 'def add(a, b):\n    return a - b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'arena fixture');
    mock.set((body) => {
      const t = toolCount(body);
      if (body.model === 'qwen/qwen3.8-27b') return t === 0 ? { content: 'Reading the file.\n', calls: [tc('read_file', { path: 'arena_math.py' })] } : t === 1 ? { calls: [tc('edit_file', { path: 'arena_math.py', old_string: 'return a - b', new_string: 'return a + b' })] } : { content: 'Fixed add().\n' };
      return t === 0 ? { content: 'Writing a note.\n', calls: [tc('write_file', { path: 'NOTE.md', content: 'hm\n' })] } : { content: 'Done.\n' };
    }, 60);
    X.approve = async () => ({ decision: 'allow' });
    const arena = X.arena();
    await shot('20-arena-start');
    await arena.onMessage({ type: 'start', prompt: 'Fix add() in arena_math.py', models: 'qwen/qwen3.8-27b,qwen/qwen3.8-9b', agents: '', check: 'python3 -c "import arena_math; assert arena_math.add(2, 3) == 5"' });
    await arena.running;
    await shot('21-arena-results');
    arena.panel.dispose();
  });

  await stepRun('kanban', async () => {
    write('board.txt', 'one\ntwo\nthree\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'board fixture');
    mock.set((body) => {
      const user = body.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const t = toolCount(body);
      const who = /card one/.test(user) ? 'ONE' : 'TWO';
      return t === 0 ? { calls: [tc('read_file', { path: 'board.txt' })] } : t === 1 ? { calls: [tc('write_file', { path: 'board.txt', content: `one\n${who}\nthree\n` })] } : { content: `done ${who}` };
    });
    const board = await X.kanban();
    X.approve = async () => ({ decision: 'allow' });
    await shot('22-board-empty');
    await board.onMessage({ type: 'add', prompt: 'card one: edit board.txt', title: 'Update line two (one)' });
    await board.onMessage({ type: 'add', prompt: 'card two: edit board.txt', title: 'Update line two (two)' });
    await board.onMessage({ type: 'add', prompt: 'card three: later', title: 'Write the changelog' });
    await shot('23-board-cards');
    const ids = board.posted.filter((m) => m.type === 'board').at(-1).cards.filter((c) => /line two/.test(c.title)).map((c) => c.id);
    log.push(`board cards: ${ids.join(', ')}`);
    await board.onMessage({ type: 'start', id: ids[0] });
    await board.onMessage({ type: 'start', id: ids[1] });
    await sleep(1000);
    await Promise.all([...board.runs.values()]);
    await shot('24-board-review');
    await board.onMessage({ type: 'merge', id: ids[0] });
    await board.onMessage({ type: 'merge', id: ids[1] });
    await shot('24b-board-merged-and-conflict');
    board.panel?.dispose?.();
  });

  await stepRun('wiki', async () => {
    void cmd('tugline.openWiki');
    await shot('25-wiki', 4000);
    await cmd('workbench.action.closeAllEditors');
  });

  await stepRun('preview', async () => {
    const site = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>Demo</title><body style="font-family:sans-serif;padding:24px"><h1>Demo app</h1><button id="save">Save</button> <button id="cancel">Cancel</button></body>'); });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    void cmd('tugline.preview.open', `http://127.0.0.1:${site.address().port}/`);
    await shot('26-preview', 5000);
    await cmd('workbench.action.closeAllEditors');
    site.close();
  });

  await stepRun('walkthrough', async () => {
    await cmd('workbench.action.openWalkthrough', 'tugline.tugline#tugline.start', false);
    await shot('27-walkthrough', 2500);
    await cmd('workbench.action.closeAllEditors');
  });

  await stepRun('emergency stop', async () => {
    await cmd('tugline.emergencyStop');
    await shot('28-emergency-stop');
    await cmd('tugline.resumeAutomation');
  });

  await stepRun('light theme', async () => {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
    const chat = [...P.chats.values()][0];
    if (chat) await P.onMessage({ type: 'switchChat', id: chat.id });
    await cmd('tugline.showView', 'chat');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'calc.py')));
    await shot('29-light-theme-chat', 2500);
    await cmd('tugline.showView', 'settings');
    await shot('30-light-theme-settings');
  });

  fs.writeFileSync(path.join(OUT, 'tour.log'), log.join('\n') + '\n');
  // the webview HTML of the chat panel, for checking text the screenshots crop
  try { fs.writeFileSync(path.join(OUT, 'posted.json'), JSON.stringify(P.posted.filter((m) => /error|notice|refusal/.test(m.type) || /refusal|notice/.test(m.event?.type || '')).map((m) => ({ type: m.type, chat: m.chatId, msg: m.message || m.event?.message || m.event?.reason || m.event }))), null, 1); } catch (e) { log.push('dump failed ' + e.message); }
  srv.close();
  console.log('[tour] done:', log.length, 'entries');
};
