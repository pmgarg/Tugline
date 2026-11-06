// Runs inside the VS Code extension host (real VS Code under Xvfb, see runTest.mjs).
// With TUG_E2E_BASE_URL set, only the live "fix calc.py" scenario runs against that model.
// Otherwise every [VSC] acceptance check of SPEC B runs against a scripted mock LLM.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

// ------------------------------------------------------------ scripted mock LLM

const mock = {
  requests: [],
  transcriptions: [],
  transcript: 'make the save button blue',
  start: 0,
  script: () => ({ content: 'ok' }),
  delayMs: 0,
  /** WS9: when set, the mock also behaves like Ollama ({models, caps: {id: [...]}}) */
  ollama: null,
  set(fn, delayMs = 0) {
    this.script = fn;
    this.delayMs = delayMs;
    this.start = this.requests.length;
  },
  /** requests since the last set() */
  get recent() {
    return this.requests.slice(this.start);
  },
};
const tc = (name, args) => ({ name, args });

function mockServer() {
  const srv = http.createServer((req, res) => {
    const o = mock.ollama;
    if (o) {
      const json = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url === '/') return void res.end('Ollama is running');
      if (req.url === '/api/version') return json({ version: '0.12.6' });
      if (req.url === '/api/ps') return json({ models: [] });
      if (req.url === '/v1/models') return json({ object: 'list', data: o.models.map((id) => ({ id, object: 'model', owned_by: 'library' })) });
      if (req.url === '/api/show') {
        let b = '';
        req.on('data', (d) => (b += d));
        req.on('end', () => {
          const { model } = JSON.parse(b || '{}');
          json({ parameters: '', model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 }, capabilities: o.caps[model] || ['completion'] });
        });
        return;
      }
    }
    if (req.method === 'GET' && !req.url.endsWith('/models')) {
      res.writeHead(404);
      res.end('404 page not found');
      return;
    }
    if (req.url.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other-model' }] }));
      return;
    }
    if (req.url.endsWith('/audio/transcriptions')) {
      // N25: a whisper-style transcription endpoint (multipart body)
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        mock.transcriptions.push({ type: req.headers['content-type'], auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: mock.transcript }));
      });
      return;
    }
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      mock.requests.push(body);
      const i = mock.requests.length - 1 - mock.start;
      const r = mock.script(body, i) || { content: 'ok' };
      const calls = (r.calls || []).map((c, k) => ({ id: `c${mock.requests.length}_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // N15: /completions with a raw prompt (next-edit model) answers with text
        if (typeof body.prompt === 'string') return res.end(JSON.stringify({ choices: [{ index: 0, text: r.text ?? r.content ?? '', finish_reason: 'stop' }] }));
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: r.content || '', tool_calls: calls.length ? calls : undefined }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 40 } }));
      }, mock.delayMs);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/** A script: list of steps by request index; the last step repeats. */
const scriptedReplies = (...s) => (_b, i) => s[Math.min(i, s.length - 1)];
const lastMsg = (body) => body.messages[body.messages.length - 1];
const e2eMsgText = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ------------------------------------------------------------ scenarios

const results = [];
const SCENARIO_MS = Number(process.env.TUG_E2E_SCENARIO_MS || 240000);
const step = (m) => console.log(`[e2e]   · ${m}`);
async function scenario(name, fn) {
  // TUG_E2E_ONLY=<regex> runs a subset (development); the full suite runs without it
  if (process.env.TUG_E2E_ONLY && !new RegExp(process.env.TUG_E2E_ONLY).test(name)) return;
  const t0 = Date.now();
  let timer;
  try {
    // a hung scenario fails with a message instead of hanging the whole run
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`scenario timed out after ${SCENARIO_MS} ms${globalThis.__ohE2eState ? `; sessions: ${globalThis.__ohE2eState()}` : ''}`)), SCENARIO_MS)))]);
    clearTimeout(timer);
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`[e2e] ✔ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    clearTimeout(timer);
    results.push({ name, ok: false, error: e.stack || String(e) });
    console.log(`[e2e] ✗ ${name}: ${e.stack || e}`);
  }
}

exports.run = async function () {
  const ws = process.env.TUG_E2E_WORKSPACE;
  const home = process.env.TUG_E2E_HOME;
  const real = process.env.TUG_E2E_BASE_URL;
  const cfg = vscode.workspace.getConfiguration('tugline');
  let srv;
  if (real) {
    await cfg.update('baseUrl', real, vscode.ConfigurationTarget.Global);
    await cfg.update('model', process.env.TUG_E2E_MODEL || 'qwen3-4b', vscode.ConfigurationTarget.Global);
    await cfg.update('contextWindow', Number(process.env.TUG_E2E_CTX || 20480), vscode.ConfigurationTarget.Global);
    await cfg.update('maxOutputTokens', 2048, vscode.ConfigurationTarget.Global);
    await cfg.update('promptStyle', 'compact', vscode.ConfigurationTarget.Global);
  } else {
    srv = await mockServer();
    await cfg.update('baseUrl', `http://127.0.0.1:${srv.address().port}/v1`, vscode.ConfigurationTarget.Global);
    await cfg.update('model', 'mock-model', vscode.ConfigurationTarget.Global);
  }
  await cfg.update('permissionMode', 'yolo', vscode.ConfigurationTarget.Global);
  await cfg.update('webSearchProvider', 'none', vscode.ConfigurationTarget.Global);
  await cfg.update('protectedPaths', ['tests/**'], vscode.ConfigurationTarget.Global);
  await cfg.update('notifications', false, vscode.ConfigurationTarget.Global);
  const ext = vscode.extensions.all.find((e) => e.id.endsWith('tugline'));
  if (!ext) throw new Error('extension not found');
  const api = await ext.activate();
  // on a scenario timeout: which sessions are blocked, and on what (a pending approval is the usual cause)
  globalThis.__ohE2eState = () => { try { return JSON.stringify([...api.agents.rows.values()].map((r) => ({ title: r.title, status: r.status, blocked: r.blocked }))); } catch (e) { return String(e); } };
  const P = api.provider;
  await vscode.commands.executeCommand('workbench.view.extension.tugline');
  await vscode.commands.executeCommand('tugline.chat.focus');
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'calc.py')));
  await sleep(2500);
  const write = (rel, content) => {
    const f = path.join(ws, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
  };
  const read = (rel) => fs.readFileSync(path.join(ws, rel), 'utf8');
  const docText = (rel) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(ws, rel))?.getText();
  /** a fresh chat whose agent is built, in the given mode */
  const freshChat = async (mode = 'yolo') => {
    const chat = P.newChat();
    await P.getAgent(chat);
    chat.agent.setMode(mode);
    return chat;
  };
  const toolResults = (body) => body.messages.filter((m) => m.role === 'tool').map(e2eMsgText);

  // ---- the original end-to-end task (also the live scenario)
  await scenario('fix calc.py end to end (read, edit, run)', async () => {
    mock.set(
      scriptedReplies(
        { content: "I'll inspect calc.py first.", calls: [tc('read_file', { path: 'calc.py' })] },
        { calls: [tc('edit_file', { path: 'calc.py', old_string: '    return sum(numbers) / len(numbers)', new_string: '    if not numbers:\n        return 0\n    return sum(numbers) / len(numbers)' })] },
        { calls: [tc('bash', { command: 'python3 -c "from calc import average; print(average([]))"' })] },
        { content: 'Fixed **average()** in `calc.py`: an empty list now returns `0`. Verified by running it (prints `0`).' },
      ),
    );
    const events = [];
    const listener = (e) => e.type !== 'text_delta' && e.type !== 'reasoning_delta' && events.push(e.type + (e.name ? ':' + e.name : ''));
    P.eventListeners.push(listener);
    const t0 = Date.now();
    await P.sendPrompt('The test in tests/test_calc.py fails: average([]) should return 0. Fix calc.py and verify.');
    P.eventListeners.splice(P.eventListeners.indexOf(listener), 1);
    console.log('[e2e] events:', events.join(' '));
    console.log(`[e2e] took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    assert(events.includes('run_end'), 'agent did not finish');
    assert(events.some((e) => e.startsWith('tool_end')), 'no tools ran');
    if (!real) assert(/if not numbers/.test(read('calc.py')), 'calc.py was not fixed');
  });

  if (real) {
    await screenshot();
    srv && srv.close();
    finish();
    return;
  }

  // ---- B1: buffer host
  await scenario('B1 AC1+AC2: an agent edit keeps the user\'s unsaved text in another region; Ctrl+Z (undo) reverts only the agent edit', async () => {
    write('b1.py', 'def one():\n    return 1\n\n\ndef two():\n    return 2\n');
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'b1.py'));
    const ed = await vscode.window.showTextDocument(doc);
    await ed.edit((e) => e.insert(new vscode.Position(0, 0), '# user note, not saved\n'));
    assert(doc.isDirty, 'user text is unsaved');
    const chat = await freshChat('yolo');
    mock.set(scriptedReplies({ calls: [tc('read_file', { path: 'b1.py' })] }, { calls: [tc('edit_file', { path: 'b1.py', old_string: '    return 2', new_string: '    return 22' })] }, { content: 'done' }));
    await P.sendPrompt('change two() to return 22', { chatId: chat.id });
    const t = doc.getText();
    assert(t.includes('# user note, not saved') && t.includes('return 22'), `AC1: buffer has both edits:\n${t}`);
    assert(doc.isDirty, 'a document with unsaved user changes is not saved behind the user');
    assert(!read('b1.py').includes('user note'), 'the user text did not reach disk');
    assert(mock.recent.some((b) => toolResults(b).some((r) => /return 1/.test(r) && /user note/.test(r))), 'the agent read the buffer, unsaved text included');
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('undo');
    const u = doc.getText();
    assert(u.includes('return 2\n') && !u.includes('return 22'), `AC2: undo reverted the agent edit:\n${u}`);
    assert(u.includes('# user note, not saved'), 'AC2: the user text is still there');
    await vscode.commands.executeCommand('undo');
    assert(!doc.getText().includes('# user note'), 'the next undo step is the user\'s own edit');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await scenario('B1 AC3: a shell command after an edit sees the edited content on disk (flushForShell with autoSave off)', async () => {
    await cfg.update('autoSave', false, vscode.ConfigurationTarget.Global);
    try {
      write('b3.txt', 'status: old\n');
      const chat = await freshChat('yolo');
      mock.set(scriptedReplies({ calls: [tc('read_file', { path: 'b3.txt' })] }, { calls: [tc('edit_file', { path: 'b3.txt', old_string: 'status: old', new_string: 'status: new' })] }, { calls: [tc('bash', { command: 'cat b3.txt' })] }, { content: 'done' }));
      let dirtyAfterEdit;
      const l = (e) => {
        if (e.type === 'tool_end' && e.name === 'edit_file') dirtyAfterEdit = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith('b3.txt'))?.isDirty;
      };
      P.eventListeners.push(l);
      await P.sendPrompt('update the status', { chatId: chat.id });
      P.eventListeners.splice(P.eventListeners.indexOf(l), 1);
      assert(dirtyAfterEdit === true, 'with autoSave off the edit stays in the buffer');
      const out = toolResults(mock.recent[mock.recent.length - 1]).pop();
      assert(/status: new/.test(out), `the shell saw the edit: ${out}`);
      assert(chat.host.lastFlushed.some((p) => p.endsWith('b3.txt')), 'flushForShell saved it');
    } finally {
      await cfg.update('autoSave', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  await scenario('A6 AC3 (host side): IDE diagnostics published after an edit reach the tool result', async () => {
    write('cfg.json', '{\n  "a": 1,\n  "b": 2\n}\n');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, 'cfg.json')));
    await sleep(1500);
    const chat = await freshChat('yolo');
    mock.set(scriptedReplies({ calls: [tc('read_file', { path: 'cfg.json' })] }, { calls: [tc('edit_file', { path: 'cfg.json', old_string: '"b": 2', new_string: '"b": 2,,' })] }, { content: 'done' }));
    await P.sendPrompt('edit cfg', { chatId: chat.id });
    const res = toolResults(mock.recent[2]).pop();
    assert(/New problems after this edit/.test(res) && /\[json\]/.test(res), `diagnostics in the edit result:\n${res}`);
  });

  // ---- B2: write-then-review
  await scenario('B2 AC1+AC2+AC3: Changes list shows 2 files with counts; Undo of hunk #2 of 3 reverts only it; Keep all clears pending', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    write('r1.txt', lines);
    write('r2.txt', 'alpha\nbeta\n');
    const chat = await freshChat('acceptEdits');
    mock.set(
      scriptedReplies(
        { calls: [tc('read_file', { path: 'r1.txt' }), tc('read_file', { path: 'r2.txt' })] },
        { calls: [tc('multi_edit', { path: 'r1.txt', edits: [{ old_string: 'line 2\n', new_string: 'LINE 2\n' }, { old_string: 'line 15\n', new_string: 'LINE 15\nextra\n' }, { old_string: 'line 28\n', new_string: '' }] })] },
        { calls: [tc('edit_file', { path: 'r2.txt', old_string: 'beta', new_string: 'BETA' })] },
        { content: 'done' },
      ),
    );
    await P.sendPrompt('edit both files', { chatId: chat.id });
    const files = await api.review.list();
    const f1 = files.find((f) => f.path.endsWith('r1.txt'));
    const f2 = files.find((f) => f.path.endsWith('r2.txt'));
    assert(f1 && f2, `AC1: both files pending: ${JSON.stringify(files)}`);
    assert(f1.hunks === 3 && f1.added === 3 && f1.removed === 3, `r1 counts ${JSON.stringify(f1)}`);
    assert(f2.added === 1 && f2.removed === 1, `r2 counts ${JSON.stringify(f2)}`);
    await P.postPending();
    const posted = [...P.posted].reverse().find((m) => m.type === 'pending');
    assert(posted && posted.files.length >= 2 && posted.files.some((f) => f.rel === 'r1.txt' && f.added === 3), 'AC1: the panel got the Changes list');
    const ev = mock.recent.length && chat.agent.journalFile && fs.readFileSync(chat.agent.journalFile, 'utf8');
    assert(/"diff_pending"/.test(ev), 'diff_pending events are journaled');
    // CodeLens Keep | Undo above each hunk
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', vscode.Uri.file(path.join(ws, 'r1.txt')));
    assert(lenses.filter((l) => l.command && l.command.title === 'Undo').length === 3, 'one Undo CodeLens per hunk');
    // AC2: undo hunk #2 only
    const hs = await api.review.hunks(f1.uri);
    await vscode.commands.executeCommand('tugline.review.undoHunk', f1.uri, hs[1]);
    const now = read('r1.txt');
    assert(now.includes('LINE 2\n') && !now.includes('LINE 15') && now.includes('line 15\nline 16') && !now.includes('extra') && !now.includes('line 28\n'), `AC2: only hunk #2 reverted:\n${now}`);
    assert((await api.review.hunks(f1.uri)).length === 2, 'two hunks left');
    // AC3: keep all
    await vscode.commands.executeCommand('tugline.review.keepAll');
    assert((await api.review.list()).length === 0, 'AC3: pending cleared');
    assert(read('r2.txt') === 'alpha\nBETA\n', 'keep keeps the content');
  });

  // ---- B3: inline edit
  await scenario('B3 AC1+AC3: inline edit replaces the selection; Reject restores it exactly; an accepted edit is one undo step', async () => {
    const original = 'import math\n\n\ndef area(x):\n    """Square area."""\n    return x * x\n\n\nprint(area(2))\n';
    write('inl.py', original);
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'inl.py'));
    const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(3, 0, 6, 0);
    let promptOk = true;
    mock.set((body) => {
      const u = e2eMsgText(lastMsg(body));
      if (!(/<selection>\ndef area\(x\):/.test(u) && /<instruction>\nrename x to y/.test(u)) || (body.tools && body.tools.length)) promptOk = false;
      return { content: 'Here is the code:\n<replacement>\ndef area(y):\n    """Square area."""\n    return y * y\n</replacement>' };
    });
    const r = await api.inlineEdit({ instruction: 'rename x to y' });
    assert(r.applied, `applied: ${JSON.stringify(r)}`);
    assert(promptOk, 'inline prompt has the selection and instruction, and no tools');
    assert(doc.getText() === original.replace('def area(x):', 'def area(y):').replace('return x * x', 'return y * y'), `AC1: replaced:\n${doc.getText()}`);
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    assert(lenses.some((l) => l.command && l.command.title === 'Accept') && lenses.some((l) => l.command && l.command.title === 'Reject'), 'Accept | Reject CodeLens');
    await vscode.commands.executeCommand('tugline.inlineReject');
    assert(doc.getText() === original, 'AC1: Reject restores the original exactly');
    assert(!api.review.has(doc.uri), 'no pending inline edit after reject');
    // accept, then a single undo reverts the whole inline edit
    ed.selection = new vscode.Selection(3, 0, 6, 0);
    const r2 = await api.inlineEdit({ instruction: 'rename x to y' });
    assert(r2.applied, 'second inline edit applied');
    await vscode.commands.executeCommand('tugline.inlineAccept');
    assert(!api.review.has(doc.uri) && doc.getText().includes('def area(y):'), 'accepted');
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('undo');
    assert(doc.getText() === original, `AC3: one undo reverts the accepted inline edit:\n${doc.getText()}`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  // ---- B4: @problems
  await scenario('B4 AC2: @problems attaches the diagnostics of a file with a known error', async () => {
    write('broken.json', '{\n  "name": "x",\n  "version": 1,,\n}\n');
    const uri = vscode.Uri.file(path.join(ws, 'broken.json'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const diags = await waitFor(() => (vscode.languages.getDiagnostics(uri).length ? vscode.languages.getDiagnostics(uri) : undefined), 20000, 'JSON diagnostics');
    const chat = await freshChat('yolo');
    mock.set(scriptedReplies({ content: 'There is a double comma on line 3.' }));
    await P.sendPrompt('what is wrong with it? @problems:broken.json', { chatId: chat.id });
    const u = e2eMsgText(mock.recent[0].messages.filter((m) => m.role === 'user').pop());
    assert(/<attached_context source="@problems:broken.json" kind="problems"(?: id="[0-9a-f]{16}")?>/.test(u), `attached block:\n${u}`);
    assert(u.includes(`broken.json:${diags[0].range.start.line + 1}:`) && u.includes(diags[0].message), `the known error is attached:\n${u}`);
  });

  // ---- B6: multiple chats
  await scenario('B6 AC1+AC2: two chats run independent agents (two session journals); resume restores the messages', async () => {
    const a = await freshChat('yolo');
    const b = await freshChat('yolo');
    mock.set((body) => ({ content: `answer to: ${e2eMsgText(lastMsg(body)).slice(0, 30)}` }));
    await Promise.all([P.sendPrompt('first chat says ZEBRA', { chatId: a.id }), P.sendPrompt('second chat says KOALA', { chatId: b.id })]);
    assert(a.agent !== b.agent && a.agent.sessionId !== b.agent.sessionId, 'two agents');
    const ja = fs.readFileSync(a.agent.journalFile, 'utf8');
    const jb = fs.readFileSync(b.agent.journalFile, 'utf8');
    assert(ja.includes('ZEBRA') && !ja.includes('KOALA') && jb.includes('KOALA') && !jb.includes('ZEBRA'), 'separate journals');
    assert(!a.agent.messages.some((m) => e2eMsgText(m).includes('KOALA')), 'separate histories');
    // the History view lists both; resume one
    const items = api.history.sessions();
    const sa = items.find((s) => s.id === a.agent.sessionId);
    assert(sa && /ZEBRA/.test(sa.title), `history lists the chat: ${JSON.stringify(items.map((s) => s.title))}`);
    api.history.setFilter('answer to: second');
    assert(api.history.sessions().some((s) => s.id === b.agent.sessionId), 'search finds a chat by its answer');
    api.history.setFilter('');
    const resumed = P.resumeSession({ ...sa, id: sa.id });
    assert(resumed === a, 'an open chat is switched to, not duplicated');
    await P.closeChat(a.id);
    const r = P.resumeSession(sa);
    await P.getAgent(r);
    assert(r.agent.messages.some((m) => m.role === 'user' && e2eMsgText(m).includes('ZEBRA')) && r.agent.messages.some((m) => m.role === 'assistant' && e2eMsgText(m).includes('answer to')), 'AC2: resumed messages');
    assert(P.posted.some((m) => m.type === 'history' && m.chatId === r.id && m.messages.length >= 2), 'the transcript was sent to the webview');
  });

  // ---- B7: queue, steer, edit and resubmit
  await scenario('B7 AC1+AC3: a message sent while running is queued and runs after the current run; edit-and-resubmit truncates the history', async () => {
    const chat = await freshChat('yolo');
    mock.set((body) => {
      const last = lastMsg(body);
      if (last.role === 'user' && e2eMsgText(last).startsWith('FIRST')) return { calls: [tc('bash', { command: 'sleep 1; echo slept' })] };
      return { content: `reply to ${e2eMsgText(body.messages.filter((m) => m.role === 'user').pop()).slice(0, 12)}` };
    });
    const firstDone = P.onMessage({ type: 'send', chatId: chat.id, text: 'FIRST task', uid: 'uFirst' });
    await waitFor(() => chat.busy && chat.agent.isRunning, 5000, 'first run');
    await P.onMessage({ type: 'send', chatId: chat.id, text: 'SECOND task', uid: 'uSecond' });
    assert(P.posted.some((m) => m.type === 'queued' && m.uid === 'uSecond'), 'the second message was queued');
    assert(chat.agent.queued === 1, 'one prompt in the agent queue');
    await firstDone;
    const users = chat.agent.messages.filter((m) => m.role === 'user').map(e2eMsgText);
    assert(users[0].startsWith('FIRST') && users[1].startsWith('SECOND'), `AC1: order ${JSON.stringify(users)}`);
    const firstEnd = mock.recent.findIndex((b) => lastMsg(b).role === 'tool');
    const secondStart = mock.recent.findIndex((b) => e2eMsgText(lastMsg(b)).startsWith('SECOND'));
    assert(secondStart > firstEnd, 'the queued prompt ran after the first run');
    assert(chat.uidIndex.has('uFirst') && chat.uidIndex.has('uSecond'), 'both messages are editable');
    // AC3: edit the first message
    const r = await P.editResubmit(chat, 'uFirst', 'EDITED task');
    assert(r && r.truncatedTo === 1, `truncated to the first user message: ${JSON.stringify(r)}`);
    const after = chat.agent.messages.map((m) => `${m.role}:${e2eMsgText(m).slice(0, 14)}`);
    assert(chat.agent.messages[1].role === 'user' && e2eMsgText(chat.agent.messages[1]).startsWith('EDITED'), `history restarts at the edit: ${after}`);
    assert(!chat.agent.messages.some((m) => /FIRST|SECOND|slept/.test(e2eMsgText(m))), `nothing after the edit point survives: ${after}`);
    assert(P.posted.some((m) => m.type === 'truncated' && m.uid === 'uFirst'), 'the webview was told to drop the old messages');
  });

  await scenario('B7: steer reaches the running agent at the next tool boundary', async () => {
    const chat = await freshChat('yolo');
    let sawSteer = false;
    mock.set((body) => {
      if (body.messages.some((m) => m.role === 'user' && e2eMsgText(m).includes('[user steer] use python instead'))) sawSteer = true;
      const tools = body.messages.filter((m) => m.role === 'tool').length;
      return tools === 0 ? { calls: [tc('bash', { command: 'sleep 1' })] } : { content: 'ok' };
    });
    const done = P.onMessage({ type: 'send', chatId: chat.id, text: 'do it', uid: 'uS' });
    await waitFor(() => chat.agent && chat.agent.isRunning, 5000, 'run');
    await sleep(200);
    await P.onMessage({ type: 'steer', chatId: chat.id, text: 'use python instead' });
    await done;
    assert(sawSteer, 'the steer was in the next request of the same run');
  });

  // ---- B8 via the webview protocol
  await scenario('B8: the model picker changes the next request\'s model; effort low sends the mapped field', async () => {
    const chat = await freshChat('yolo');
    mock.set(scriptedReplies({ content: 'ok' }));
    await P.onMessage({ type: 'setModel', chatId: chat.id, value: 'model:qwen3-coder-next' });
    await P.onMessage({ type: 'setEffort', chatId: chat.id, effort: 'low' });
    await P.sendPrompt('hi', { chatId: chat.id });
    const b = mock.recent[0];
    assert(b.model === 'qwen3-coder-next', `model ${b.model}`);
    assert(b.chat_template_kwargs && b.chat_template_kwargs.enable_thinking === true, `effort field ${JSON.stringify(b.chat_template_kwargs)}`);
    const st = [...P.posted].reverse().find((m) => m.type === 'status' && m.chatId === chat.id);
    assert(st && st.choice === 'model:qwen3-coder-next' && st.picker.some((i) => i.value === 'model:other-model'), 'picker lists endpoint models and the choice');
    assert([...P.posted].some((m) => m.type === 'meter' && m.chatId === chat.id && m.view.window > 0), 'meter posted');
  });

  // ---- B10: visible terminal
  await scenario('B10 AC1: `echo hi` runs in the visible Tugline terminal and returns hi + exit code 0', async () => {
    await cfg.update('visibleTerminal', true, vscode.ConfigurationTarget.Global);
    // review fix 1: the terminal's interactive bash sources ~/.bashrc; a key exported there must not reach agent commands
    const rcMarker = path.join(home, '.rc-was-sourced');
    fs.writeFileSync(path.join(home, '.bashrc'), `export TUG_FAKE_RC_SECRET=sk-from-bashrc-0123456789\ntouch '${rcMarker}'\n`);
    try {
      const chat = await freshChat('yolo');
      // review B10: no fixed delay. A first command creates the terminal; wait for ITS shell-integration event (it can
      // take longer than the runner's own wait on a loaded machine, and then that first command ran hidden), then assert.
      mock.set(scriptedReplies({ calls: [tc('bash', { command: 'true' })] }, { content: 'done' }));
      await P.sendPrompt('warm up', { chatId: chat.id });
      // Some environments (GitHub's Ubuntu runners) bring shell integration up without command detection: the
      // terminal accepts a command line and never starts it. The runner cancels it after its start timeout and runs
      // commands hidden from then on. Check that fallback here, and say the visible path was not testable.
      if (chat.runner && chat.runner.last && /did not start the command/.test(chat.runner.last.result.output)) {
        mock.set(scriptedReplies({ calls: [tc('bash', { command: 'echo hi' })] }, { content: 'done' }));
        await P.sendPrompt('say hi', { chatId: chat.id });
        const fb = toolResults(mock.recent[1]).pop();
        assert(/^\$ echo hi\nhi\n\[exit code 0,/.test(fb), `hidden fallback after the cancelled start: ${JSON.stringify(fb)}`);
        console.log('[e2e] note: B10: this environment\'s terminal does not report command starts; the cancel-and-fall-back path was checked instead of the visible terminal');
        return;
      }
      const ohTerm = () => vscode.window.terminals.find((t) => t.name.startsWith('Tugline') && t.exitStatus === undefined);
      await waitFor(() => ohTerm(), 60000, 'the Tugline terminal');
      if (!ohTerm().shellIntegration)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => (sub.dispose(), reject(new Error('no shell-integration event for the Tugline terminal in 120 s'))), 120000);
          const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
            if (e.terminal !== ohTerm()) return;
            clearTimeout(timer);
            sub.dispose();
            resolve();
          });
          if (ohTerm().shellIntegration) (clearTimeout(timer), sub.dispose(), resolve());
        });
      mock.set(scriptedReplies({ calls: [tc('bash', { command: 'echo hi' })] }, { content: 'done' }));
      await P.sendPrompt('say hi', { chatId: chat.id });
      const out = toolResults(mock.recent[1]).pop();
      assert(/^\$ echo hi\nhi\n\[exit code 0,/.test(out), `tool result: ${JSON.stringify(out)}`);
      assert(chat.runner && chat.runner.last, 'ran through the visible terminal (not the hidden fallback)');
      assert(/echo hi/.test(chat.runner.last.commandLine) && chat.runner.last.result.exitCode === 0, JSON.stringify(chat.runner.last));
      assert(vscode.window.terminals.some((t) => t.name.startsWith('Tugline')), 'the terminal is visible');
      mock.set(scriptedReplies({ calls: [tc('bash', { command: 'echo "rc:[${TUG_FAKE_RC_SECRET:-}]"' })] }, { content: 'done' }));
      await P.sendPrompt('show env', { chatId: chat.id });
      const envOut = toolResults(mock.recent[1]).pop();
      assert(fs.existsSync(rcMarker), 'the terminal shell did source ~/.bashrc (so the check below is meaningful)');
      assert(/rc:\[\]\n\[exit code 0/.test(envOut) && !/sk-from-bashrc/.test(envOut), `rc-exported secret reached the command: ${envOut}`);
      assert(/^\/usr\/bin\/env -i /.test(chat.runner.last.commandLine.replace(/^cd \S+ && /, '')), 'runs through env -i');
      // failing command: exit code comes back too
      mock.set(scriptedReplies({ calls: [tc('bash', { command: 'echo bad >&2; exit 3' })] }, { content: 'done' }));
      await P.sendPrompt('fail', { chatId: chat.id });
      const out2 = toolResults(mock.recent[1]).pop();
      assert(/bad\n\[exit code 3,/.test(out2), `exit code: ${out2}`);
    } finally {
      await cfg.update('visibleTerminal', undefined, vscode.ConfigurationTarget.Global);
      fs.rmSync(path.join(home, '.bashrc'), { force: true });
    }
  });

  // ---- B11: MCP manager
  await scenario('B11 AC1: toggling an MCP server writes the user config and reconnects', async () => {
    const fixture = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'mcp-server.mjs');
    const userFile = path.join(home, '.tugline', 'config.json');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    const prior = fs.existsSync(userFile) ? JSON.parse(fs.readFileSync(userFile, 'utf8')) : {};
    fs.writeFileSync(userFile, JSON.stringify({ ...prior, mcpServers: { calc: { command: 'node', args: [fixture] } } }, null, 2));
    const chat = P.newChat();
    await P.getAgent(chat);
    const st = () => (chat.agent.mcp ? chat.agent.mcp.status() : []).find((s) => s.name === 'calc');
    assert(st() && st().status === 'connected', `connected first: ${JSON.stringify(st())}`);
    const before = chat.agent;
    await P.onMessage({ type: 'manage', action: 'toggleServer', name: 'calc', enabled: false });
    const j = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    assert(j.ide && j.ide.mcp && j.ide.mcp.calc && j.ide.mcp.calc.disabled === true, `user config: ${JSON.stringify(j)}`);
    assert(j.mcpServers.calc.command === 'node', 'the server definition is kept');
    assert(chat.agent !== before && st().status === 'disabled', `reconnected without it: ${JSON.stringify(st())}`);
    const m = [...P.posted].reverse().find((x) => x.type === 'manage');
    assert(m && m.servers.some((s) => s.name === 'calc' && s.disabled && s.source === 'user'), 'the manager view shows it disabled');
    assert(m.skills.some((s) => s.name === 'skill-creator' && s.source === 'bundled' && s.description.length > 10), 'B11 AC2: skills with source and description');
    await P.onMessage({ type: 'manage', action: 'toggleServer', name: 'calc', enabled: true });
    assert(st() && st().status === 'connected', 're-enabled and reconnected');
    fs.writeFileSync(userFile, JSON.stringify(prior));
  });

  await scenario('B12: the settings view writes protected paths to the project config with the trust caveat', async () => {
    await P.onMessage({ type: 'settings', action: 'protectedPaths', scope: 'project', value: ['secrets/**'] });
    const j = JSON.parse(read('.tugline/config.json'));
    assert(JSON.stringify(j.permissions.protectedPaths) === '["secrets/**"]', JSON.stringify(j));
    assert(P.posted.some((m) => m.type === 'notice' && /trust this workspace/.test(m.message)), 'trust caveat shown');
    fs.rmSync(path.join(ws, '.tugline', 'config.json'));
  });

  await scenario('Settings: browser.enabled and the approver map onto the agent config (off by default)', async () => {
    let chat = P.newChat();
    await P.getAgent(chat);
    assert(!(chat.agent.config.browser && chat.agent.config.browser.enabled) && !(chat.agent.config.approver && chat.agent.config.approver.enabled), 'off by default');
    assert(!chat.agent.toolList.some((t) => t.name.startsWith('browser_')) && !chat.agent.deferredToolNames().some((n) => n.startsWith('browser_')), 'no browser tools by default');
    await cfg.update('browser.enabled', true, vscode.ConfigurationTarget.Global);
    await cfg.update('approver.enabled', true, vscode.ConfigurationTarget.Global);
    try {
      chat = P.newChat();
      await P.getAgent(chat);
      assert(chat.agent.config.browser.enabled === true && chat.agent.config.approver.enabled === true, 'mapped');
      assert([...chat.agent.toolList.map((t) => t.name), ...chat.agent.deferredToolNames()].includes('browser_open'), 'browser tools offered');
    } finally {
      await cfg.update('browser.enabled', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('approver.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // ---- B14
  await scenario('B14 AC2: autocomplete is not registered by default; enabling the setting registers it', async () => {
    assert(api.autocomplete.registered === false, 'off by default');
    await cfg.update('autocomplete.enabled', true, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.autocomplete.registered, 3000, 'registration');
    await cfg.update('autocomplete.enabled', undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => !api.autocomplete.registered, 3000, 'unregistration');
  });

  // ---- F7 emergency stop
  await scenario('F7: the Emergency Stop command aborts a running agent and trips the automation kill switch', async () => {
    const chat = await freshChat('yolo');
    mock.set(scriptedReplies({ calls: [tc('bash', { command: 'sleep 30' })] }, { content: 'never' }));
    let end;
    const l = (e, id) => id === chat.id && e.type === 'run_end' && (end = e);
    P.eventListeners.push(l);
    const done = P.sendPrompt('long task', { chatId: chat.id });
    await waitFor(() => chat.agent.isRunning && mock.recent.length >= 1, 5000, 'running');
    await sleep(300);
    const t0 = Date.now();
    await vscode.commands.executeCommand('tugline.emergencyStop');
    await done;
    P.eventListeners.splice(P.eventListeners.indexOf(l), 1);
    assert(end && end.stopReason === 'aborted', `stopped: ${end && end.stopReason}`);
    assert(Date.now() - t0 < 5000, 'stopped promptly');
    assert(api.stops === 1, 'command ran');
    assert(api.automationKilled(), 'browser/desktop automation kill switch is on');
    const kb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).contributes.keybindings.find((k) => k.command === 'tugline.emergencyStop');
    assert(kb && kb.key === 'ctrl+alt+shift+escape', 'keybinding');
    await vscode.commands.executeCommand('tugline.resumeAutomation');
    assert(!api.automationKilled(), 'resumed');
  });

  // ---- E7 replay viewer
  await scenario('E7: the replay viewer opens the `tug replay --html` report of a recorded run', async () => {
    const dir = path.join(ws, '.tugline', 'runs', 'sess-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session: 'sess-1', surface: 'browser', goal: 'buy <b>milk</b>', startedAt: new Date().toISOString(), versions: {} }));
    fs.writeFileSync(path.join(dir, 'trajectory.jsonl'), JSON.stringify({ seq: 1, turn: 1, ts: new Date().toISOString(), tool: 'browser_open', path: 'L2b', args: { url: 'http://127.0.0.1/shop' }, outcome: 'confirmed' }) + '\n');
    const panel = await vscode.commands.executeCommand('tugline.openReplay', dir);
    assert(panel && /Replay: sess-1/.test(panel.title), 'panel opened');
    const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
    assert(/browser_open/.test(html) && !/<b>milk<\/b>/.test(html), 'report written, page content escaped');
    assert(/default-src 'none'/.test(panel.webview.html) && !panel.webview.options.enableScripts, 'no scripts in the viewer');
    panel.dispose();
  });

  await scenario('S0.6: /usage (C7) and /rewind (C1) typed in the chat run through the core registry, not the model', async () => {
    write('sl.txt', 'one\n');
    const chat = await freshChat('yolo');
    mock.set(scriptedReplies({ calls: [tc('read_file', { path: 'sl.txt' })] }, { calls: [tc('write_file', { path: 'sl.txt', content: 'two\n' })] }, { content: 'done' }));
    await P.sendPrompt('change sl.txt', { chatId: chat.id });
    assert(read('sl.txt') === 'two\n', 'edited');
    const before = mock.requests.length;
    await P.onMessage({ type: 'send', chatId: chat.id, text: '/usage', uid: 'uUsage' });
    const notes = () => P.posted.filter((m) => m.type === 'notice' && m.chatId === chat.id && m.level === 'cmd').map((m) => m.message);
    assert(notes().some((t) => /Usage since/.test(t) && /mock-model/.test(t)), `usage report: ${notes().join(' | ')}`);
    P.switchChat(chat.id);
    await P.postCheckpoints();
    const turns = [...P.posted].reverse().find((m) => m.type === 'checkpoints').list.filter((c) => c.mine && c.kind === 'turn');
    const first = turns[turns.length - 1];
    await P.onMessage({ type: 'send', chatId: chat.id, text: `/rewind ${first.id} files`, uid: 'uRew' });
    assert(notes().some((t) => /rewound to/.test(t)), `rewind output: ${notes().join(' | ')}`);
    assert(read('sl.txt') === 'one\n', 'the file was restored by /rewind');
    await P.onMessage({ type: 'send', chatId: chat.id, text: '/help', uid: 'uHelp' });
    assert(notes().some((t) => /\/rewind/.test(t) && /\/usage/.test(t) && /\/clear/.test(t)), 'help lists registered commands');
    assert(mock.requests.length === before, 'no slash command reached the model');
    await P.onMessage({ type: 'mentionQuery', kind: 'slash', q: 'rew', reqId: 991 });
    const items = [...P.posted].reverse().find((m) => m.type === 'mentionItems' && m.reqId === 991);
    assert(items && items.items.some((i) => i.insert.trim() === '/rewind'), 'composer / autocomplete offers registered commands');
  });

  // ---- WS9 clickable onboarding against a mock Ollama whose installed models don't include the configured one
  await scenario('WS9 AC2+AC3: the onboarding card appears for a missing model (sorted buttons, no embedding models); clicking a model sets tugline.model and re-tests', async () => {
    // (cfg is a snapshot from before the suite pointed baseUrl at the mock, so don't read it back)
    const mockUrl = `http://127.0.0.1:${srv.address().port}/v1`;
    mock.set(() => ({ content: 'OK' }));
    mock.ollama = {
      models: ['bge-m3:latest', 'llama3.2:3b', 'llava:7b', 'nomic-embed-text:latest', 'qwen2.5-coder:7b'],
      caps: { 'llama3.2:3b': ['completion', 'tools'], 'llava:7b': ['completion', 'vision'], 'qwen2.5-coder:7b': ['completion', 'tools', 'insert'], 'nomic-embed-text:latest': ['embedding'], 'bge-m3:latest': ['embedding'] },
    };
    try {
      await cfg.update('model', 'qwen3-coder:30b', vscode.ConfigurationTarget.Global);
      const mark = P.posted.length;
      await P.testConnection();
      const card = P.posted.slice(mark).find((x) => x.type === 'onboarding' && x.view);
      assert(card, 'an onboarding card was posted to the webview');
      assert(card.view.state === 'missingModel' && card.view.model === 'qwen3-coder:30b', `state: ${JSON.stringify(card.view).slice(0, 300)}`);
      const ids = card.view.models.map((x) => x.id);
      assert(JSON.stringify(ids) === JSON.stringify(['qwen2.5-coder:7b', 'llama3.2:3b', 'llava:7b']), `sorted, embeddings excluded: ${ids}`);
      assert(!P.posted.slice(mark).some((x) => x.type === 'probe'), 'no probe against a model that is not installed');
      // a click on a model button (the webview posts this message)
      const mark2 = P.posted.length;
      await P.onMessage({ type: 'onboard', action: 'pickModel', model: 'qwen2.5-coder:7b' });
      assert(cfg.inspect('model').globalValue === 'qwen2.5-coder:7b', `tugline.model set globally: ${JSON.stringify(cfg.inspect('model'))}`);
      const probe = await waitFor(() => P.posted.slice(mark2).find((x) => x.type === 'probe'), 15000, 're-test after the click');
      assert(probe.report.chatOk, 'the connection test ran against the picked model');
      assert(/Ollama runs qwen2\.5-coder:7b/.test(probe.ollama || ''), `Ollama summary: ${probe.ollama}`);
      assert(P.lastOnboarding === null, 'the card is cleared');
      // unreachable endpoint: only answering local servers are offered; a click switches baseUrl and lists its models
      P.onboardingCandidates = [{ kind: 'ollama', label: 'Ollama', baseUrl: mockUrl }, { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:9/v1' }];
      await cfg.update('baseUrl', 'http://127.0.0.1:9/v1', vscode.ConfigurationTarget.Global);
      const down = await P.checkSetup();
      assert(down && down.state === 'unreachable' && down.servers.length === 1 && down.servers[0].baseUrl === mockUrl, `servers: ${JSON.stringify(down)} (mock ${mockUrl})`);
      await P.onMessage({ type: 'onboard', action: 'useServer', baseUrl: mockUrl });
      assert(cfg.inspect('baseUrl').globalValue === mockUrl, 'baseUrl set by the server button');
      assert(P.lastOnboarding && P.lastOnboarding.state === 'pickModel' && P.lastOnboarding.models[0].id === 'qwen2.5-coder:7b', 'the server\'s models are listed as buttons');
    } finally {
      mock.ollama = null;
      P.onboardingCandidates = [];
      await cfg.update('baseUrl', mockUrl, vscode.ConfigurationTarget.Global);
      await cfg.update('model', 'mock-model', vscode.ConfigurationTarget.Global);
      P.lastOnboarding = undefined;
    }
  });

  // ---- WS12: /doc from the editor (Generate Docs for Selection) and the wiki panel
  await scenario('WS12 N17/N8: Generate Docs for Selection inserts a native docstring (only doc bytes change); Open Wiki shows the wiki with citation links', async () => {
    const src = 'def area(w, h):\n    return w * h\n';
    const f = write('wsdoc.py', src);
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(f));
    ed.selection = new vscode.Selection(new vscode.Position(1, 4), new vscode.Position(1, 4));
    mock.set(() => ({ content: 'Compute the area of a rectangle.\n\nArgs:\n    w: the width.\n    h: the height.' }));
    await vscode.commands.executeCommand('tugline.generateDocs');
    const doc = await waitFor(() => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === f && d.getText().includes('Compute the area')), 15000, 'docstring inserted');
    const inserted = '    """Compute the area of a rectangle.\n\n    Args:\n        w: the width.\n        h: the height.\n    """\n';
    assert(doc.getText() === 'def area(w, h):\n' + inserted + '    return w * h\n', `only the docstring was added: ${JSON.stringify(doc.getText())}`);
    assert(/<untrusted_source path="wsdoc\.py">/.test(e2eMsgText(lastMsg(mock.recent[0]))), 'the source went to the model wrapped as untrusted');
    // the wiki panel
    const wdir = path.join(ws, '.tugline', 'wiki');
    fs.mkdirSync(path.join(wdir, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(wdir, 'index.md'), '# Fixture wiki\n\n- [Calc](modules/calc.md)\n- Average divides by the count ([calc.py:3@abc1234](../../calc.py#L3)).\n');
    fs.writeFileSync(path.join(wdir, 'modules', 'calc.md'), '# Calc\n\nSee [index](../index.md).\n');
    fs.writeFileSync(path.join(wdir, 'nav.json'), JSON.stringify([{ title: 'Overview', path: 'index.md' }, { title: 'Calc', path: 'modules/calc.md' }]));
    const panel = await vscode.commands.executeCommand('tugline.openWiki');
    assert(panel && panel.webview, 'a wiki panel was opened');
    const html = panel.webview.html;
    assert(/Fixture wiki/.test(html) && /href="#src:calc\.py#L3"/.test(html) && /href="#wiki:modules\/calc\.md"/.test(html), `wiki html: ${html.slice(0, 400)}`);
    panel.dispose();
  });

  // ---- C1 checkpoint timeline (last: it rewinds files)
  await scenario('C1 (VS Code): the checkpoint timeline lists checkpoints and restores files', async () => {
    write('cp.txt', 'v1\n');
    const chat = await freshChat('yolo');
    mock.set(scriptedReplies({ calls: [tc('read_file', { path: 'cp.txt' })] }, { calls: [tc('write_file', { path: 'cp.txt', content: 'v2\n' })] }, { content: 'done' }));
    await P.sendPrompt('bump cp.txt', { chatId: chat.id });
    assert(read('cp.txt') === 'v2\n', 'edited');
    P.switchChat(chat.id);
    await P.postCheckpoints();
    const m = [...P.posted].reverse().find((x) => x.type === 'checkpoints');
    const mine = m.list.filter((c) => c.mine && c.kind === 'turn');
    assert(mine.length >= 2, `turn checkpoints of this chat: ${JSON.stringify(m.list.slice(0, 4))}`);
    const first = mine[mine.length - 1];
    await P.onMessage({ type: 'checkpoints', action: 'restore', id: first.id, scope: 'both' });
    assert(read('cp.txt') === 'v1\n', 'files restored');
    assert(chat.agent.messages.length === first.messageIndex, `conversation cut to ${first.messageIndex}: ${chat.agent.messages.length}`);
  });

  // ---- v1.1 N30: the sandbox state in the status bar
  await scenario('N30 (VS Code): the status bar shows the sandbox summary, in warning style when unsandboxed in auto mode', async () => {
    const chat = await freshChat('yolo');
    P.switchChat(chat.id);
    const b = P.lastSandbox;
    assert(b && /^sandbox: /.test(b.summary) && b.tooltip.includes(b.summary), `badge: ${JSON.stringify(b)}`);
    const unsandboxed = /UNSANDBOXED/.test(b.summary);
    assert(unsandboxed ? b.level === 'warn' : b.level === 'ok' || b.level === 'error', `level ${b.level} for "${b.summary}"`);
    step(`${b.level}: ${b.summary}`);
    await P.onMessage({ type: 'setMode', chatId: chat.id, mode: 'ask' });
    assert(unsandboxed ? P.lastSandbox.level === 'info' : P.lastSandbox.level === b.level, `ask mode: ${P.lastSandbox.level}`);
    await P.onMessage({ type: 'setMode', chatId: chat.id, mode: 'yolo' });
  });

  // ---- v1.1 N14: diff-line comments on agent hunks go back to that agent as one steer
  await scenario('N14 AC1+AC2: two comments on two hunks are sent as one steer with both paths and lines; the comments clear after sending', async () => {
    await api.review.keepAll();
    write('c1.txt', Array.from({ length: 12 }, (_, i) => `c1 line ${i + 1}`).join('\n') + '\n');
    write('c2.txt', 'alpha\nbeta\ngamma\n');
    const chat = await freshChat('acceptEdits');
    mock.set(
      scriptedReplies(
        { calls: [tc('read_file', { path: 'c1.txt' }), tc('read_file', { path: 'c2.txt' })] },
        { calls: [tc('edit_file', { path: 'c1.txt', old_string: 'c1 line 3\n', new_string: 'C1 LINE 3\n' })] },
        { calls: [tc('edit_file', { path: 'c2.txt', old_string: 'gamma', new_string: 'GAMMA' })] },
        { content: 'done' },
      ),
    );
    await P.sendPrompt('edit both', { chatId: chat.id });
    const u1 = vscode.Uri.file(path.join(ws, 'c1.txt'));
    const u2 = vscode.Uri.file(path.join(ws, 'c2.txt'));
    assert(api.review.has(u1) && api.review.has(u2), 'both files have pending agent hunks');
    // the commenting ranges are the hunks' lines
    const d1 = await vscode.workspace.openTextDocument(u1);
    const ranges = await api.comments.controller.commentingRangeProvider.provideCommentingRanges(d1, new vscode.CancellationTokenSource().token);
    assert(ranges.length === 1 && ranges[0].start.line === 2, `comment ranges on the hunk: ${JSON.stringify(ranges)}`);
    // the agent is busy with a long command while the user reviews
    let steerBody;
    mock.set((body) => {
      const steer = body.messages.find((m) => m.role === 'user' && e2eMsgText(m).includes('[user steer]') && e2eMsgText(m).includes('<review_comment'));
      if (steer && !steerBody) steerBody = e2eMsgText(steer);
      const tools = body.messages.filter((m) => m.role === 'tool').length;
      return tools === 0 ? { calls: [tc('bash', { command: 'sleep 1.5' })] } : { content: 'ok, will do' };
    });
    const busyRun = P.sendPrompt('keep going', { chatId: chat.id });
    await waitFor(() => chat.agent.isRunning && chat.busy, 5000, 'busy');
    api.comments.add(u1, 3, 'Keep lowercase here,\nlike the other lines.');
    api.comments.add(u2, 3, 'Why "GAMMA"? Revert <this>.');
    assert(api.comments.count === 2, `two drafts: ${api.comments.count}`);
    const sent = await vscode.commands.executeCommand('tugline.reviewComments.send');
    assert(sent === 2, `sent ${sent}`);
    assert(api.comments.count === 0, 'AC2: the comments cleared after sending');
    assert(api.comments.lastSent.length === 1 && api.comments.lastSent[0].via === 'steer', `AC1: one steer: ${JSON.stringify(api.comments.lastSent)}`);
    await busyRun;
    assert(steerBody, 'AC1: the steer reached the running agent in the same run');
    assert(steerBody.includes('path="c1.txt" line="3"') && steerBody.includes('path="c2.txt" line="3"'), `AC1: both paths and lines:\n${steerBody}`);
    assert(steerBody.includes('like the other lines.') && steerBody.includes('&quot;GAMMA&quot;? Revert &lt;this&gt;.'), 'bodies (multi-line, escaped)');
    assert(steerBody.includes('C1 LINE 3'), 'the commented code is included');
    await api.review.keepAll();
  });

  // ---- v1.1 N24: live preview with an element picker
  await scenario('N24 AC1+AC3: picking a button in the live preview attaches its ref and name (and the source mention); a non-allowed host is refused', async () => {
    const page = '<!doctype html><html><head><title>Shop</title></head><body style="margin:0"><h1 style="margin:0;font-size:20px">Cart</h1><button id="save" data-testid="save-btn" style="position:absolute;left:100px;top:80px;width:120px;height:40px;color:rgb(255, 0, 0)">Save changes</button></body></html>';
    write('web/index.html', page.replace('<body', '\n<body').replace('<button', '\n  <button'));
    const site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page);
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    try {
      const chat = await freshChat('yolo');
      P.switchChat(chat.id);
      const refused = await vscode.commands.executeCommand('tugline.preview.open', 'https://example.com/');
      assert(/example\.com is not an allowed preview host/.test(refused || ''), `AC3: refused: ${refused}`);
      const err = await vscode.commands.executeCommand('tugline.preview.open', `http://127.0.0.1:${site.address().port}/`);
      assert(!err, `opened: ${err}`);
      await waitFor(() => api.preview.lastFrame, 30000, 'first frame');
      const f = api.preview.lastFrame;
      step(`frame ${f.width}×${f.height} dpr ${f.dpr} ${f.url}; page: ${(await api.preview.driver.page.content()).slice(0, 120)}`);
      // AC3 again: the page's own navigation away to a non-allowed host is refused
      const nav = await api.preview.navigate('http://example.org/');
      assert(/not an allowed preview host/.test(nav || ''), `AC3: navigate refused: ${nav}`);
      // the webview path: Pick, then a click on the frame shown at half size (DPR-aware mapping)
      const geom = { displayedWidth: f.width / 2, displayedHeight: f.height / 2, naturalWidth: f.width, naturalHeight: f.height, dpr: f.dpr };
      await api.preview.onMessage({ type: 'picking', on: true });
      await api.preview.onMessage({ type: 'click', offsetX: 160 / 2, offsetY: 100 / 2, geom });
      const pick = api.preview.lastPick;
      assert(pick, 'AC1: picked');
      assert(/^[a-z]*\d+/.test(pick.ref || '') && pick.role === 'button' && pick.name === 'Save changes', `AC1: ref and name: ${JSON.stringify(pick)}`);
      assert(pick.selector === '#save' && pick.styles.color === 'rgb(255, 0, 0)', `selector and styles: ${pick.selector} ${JSON.stringify(pick.styles)}`);
      assert(pick.source && pick.source.path === 'web/index.html' && pick.source.line === 3, `source: ${JSON.stringify(pick.source)}`);
      const q = chat.queuedContext.find((c) => c.source === 'element');
      assert(q && q.text.includes(`ref: ${pick.ref}`) && q.text.includes('"Save changes"'), `AC1: attached to the chat: ${JSON.stringify(chat.queuedContext)}`);
      await waitFor(() => P.lastComposerValue.includes('@web/index.html:1-6'), 5000, 'source mention in the composer');
      // the next message carries it as <attached_context source="element">
      mock.set(scriptedReplies({ content: 'ok' }));
      await P.sendPrompt('make this button blue', { chatId: chat.id });
      const sent = e2eMsgText(lastMsg(mock.recent[0]));
      assert(/<attached_context source="element"(?: id="[0-9a-f]{16}")?>/.test(sent) && sent.includes(`ref: ${pick.ref}`), 'the pick reached the model');
    } finally {
      site.close();
      api.preview.dispose();
    }
  });

  // ---- v1.1 N15: next-edit suggestions (Zeta format) from a scripted mock
  await scenario('N15 AC2+AC3: a scripted next-edit suggestion renders, Tab jumps to it and applies it; off by default; a slow model is cancelled after the latency budget', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert(pkg.contributes.configuration.properties['tugline.nes.enabled'].default === false, 'AC3: off by default');
    const tab = pkg.contributes.keybindings.find((k) => k.command === 'tugline.nes.accept');
    assert(tab && tab.key === 'tab' && /tugline\.nesVisible/.test(tab.when), 'Tab is bound while a suggestion is visible');
    const f = write('nes1.ts', 'function total(items) {\n  let sum = 0;\n  for (const it of items) sum += it.price;\n  return sum;\n}\n\nconsole.log(total([]));\n');
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(f));
    await sleep(300);
    const before = api.nes.stats.requests;
    await ed.edit((b) => b.insert(new vscode.Position(6, 0), '// disabled\n'));
    await sleep(400);
    assert(api.nes.stats.requests === before && !api.nes.history.events.length, 'AC3: disabled → no request, nothing recorded');
    await ed.edit((b) => b.delete(new vscode.Range(6, 0, 7, 0)));
    await cfg.update('nes.enabled', true, vscode.ConfigurationTarget.Global);
    await cfg.update('nes.latencyMs', 3000, vscode.ConfigurationTarget.Global);
    // the model renames the remaining uses of `sum` (lines 3-4: far from the cursor on line 2? next line + 2)
    let prompt = '';
    mock.set((body) => {
      if (typeof body.prompt !== 'string') return { content: 'ok' };
      prompt = body.prompt;
      const m = /<\|editable_region_start\|>\n([\s\S]*?)<\|editable_region_end\|>/.exec(body.prompt);
      const region = m[1].replace('<|user_cursor_is_here|>', '');
      return { text: '<|editable_region_start|>\n' + region.replace('sum += it.price', 'acc += it.price').replace('return sum', 'return acc') };
    });
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    await ed.edit((b) => b.replace(new vscode.Range(1, 6, 1, 9), 'acc'));
    await waitFor(() => api.nes.visible, 10000, 'a suggestion');
    assert(/User edited "nes1.ts"/.test(prompt) && prompt.includes('-  let sum = 0;') && prompt.includes('+  let acc = 0;'), `AC1: the edit history reached the model:\n${prompt.slice(0, 600)}`);
    const shown = api.nes.visible;
    assert(shown.jump === true, `the suggestion is away from the cursor: ${JSON.stringify(shown)}`);
    const r1 = await vscode.commands.executeCommand('tugline.nes.accept');
    assert(r1 === 'jumped' && ed.selection.active.line === 2, `first Tab jumps: ${r1} line ${ed.selection.active.line}`);
    const r2 = await vscode.commands.executeCommand('tugline.nes.accept');
    assert(r2 === 'applied', `second Tab applies: ${r2}`);
    assert(ed.document.getText() === 'function total(items) {\n  let acc = 0;\n  for (const it of items) acc += it.price;\n  return acc;\n}\n\nconsole.log(total([]));\n', `AC2: applied:\n${ed.document.getText()}`);
    assert(!api.nes.visible, 'the suggestion is gone');
    await sleep(500);
    // AC3: a model slower than the budget is cancelled and shows nothing
    api.nes.dismiss();
    await cfg.update('nes.latencyMs', 150, vscode.ConfigurationTarget.Global);
    mock.set(() => ({ text: '<|editable_region_start|>\nnothing\n' }), 1200);
    const t0 = api.nes.stats.timeouts;
    await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// x\n'));
    await waitFor(() => api.nes.stats.timeouts > t0, 5000, 'a timeout');
    assert(api.nes.lastOutcome.reason === 'timeout' && api.nes.lastOutcome.ms < 1000, `cancelled after the budget: ${JSON.stringify(api.nes.lastOutcome)}`);
    assert(!api.nes.visible, 'no suggestion from the slow model');
    mock.set(scriptedReplies({ content: 'ok' }));
    await cfg.update('nes.enabled', false, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.files.save');
  });

  // ---- v1.1 N25: push-to-talk voice input through a local transcription endpoint
  await scenario('N25 AC1+AC2: a mock transcription endpoint\'s text lands in the composer; off by default; a transcriber off loopback/LAN gets a warning first', async () => {
    const wav = path.join(home, 'speech.wav');
    fs.writeFileSync(wav, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(32044, 0)]));
    const base = vscode.workspace.getConfiguration('tugline').get('baseUrl');
    P.lastComposerValue = '';
    assert((await vscode.commands.executeCommand('tugline.voice.toggle', { audioFile: wav })) === undefined && mock.transcriptions.length === 0, 'AC2: off by default: nothing recorded or sent');
    await cfg.update('voice.enabled', true, vscode.ConfigurationTarget.Global);
    await cfg.update('voice.url', `${base}/audio/transcriptions`, vscode.ConfigurationTarget.Global);
    const text = await vscode.commands.executeCommand('tugline.voice.toggle', { audioFile: wav });
    assert(text === "make the save button blue", `transcript: ${text} (${api.voice.lastError})`);
    assert(mock.transcriptions.length === 1 && /multipart\/form-data/.test(mock.transcriptions[0].type) && /filename="speech.wav"/.test(mock.transcriptions[0].body), 'multipart upload');
    assert(!mock.transcriptions[0].auth, 'no API key is sent to a URL typed for voice');
    await waitFor(() => P.lastComposerValue.includes('make the save button blue'), 5000, 'AC1: the text in the composer');
    assert(mock.recent.every((r) => !JSON.stringify(r).includes('make the save button blue')), 'nothing was sent to the model by itself');
    // AC2: a transcriber that is not local asks first; declining sends nothing
    await cfg.update('voice.url', 'http://203.0.113.9/v1/audio/transcriptions', vscode.ConfigurationTarget.Global);
    const declined = await vscode.commands.executeCommand('tugline.voice.toggle', { audioFile: wav, confirmRemote: false });
    assert(declined === undefined && /not on this machine or your local network/.test(api.voice.lastWarning || ''), `AC2: warning: ${api.voice.lastWarning}`);
    assert(mock.transcriptions.length === 1, 'declined: nothing sent');
    // the composer's mic button goes through the same command (no recorder here, or a real one we stop at once)
    await cfg.update('voice.url', `${base}/audio/transcriptions`, vscode.ConfigurationTarget.Global);
    await P.onMessage({ type: 'voice' });
    if (api.voice.recording) await vscode.commands.executeCommand('tugline.voice.toggle');
    else assert(/no audio recorder found/.test(api.voice.lastError || ''), `mic button: ${api.voice.lastError}`);
    await cfg.update('voice.enabled', false, vscode.ConfigurationTarget.Global);
    await cfg.update('voice.url', '', vscode.ConfigurationTarget.Global);
  });

  // ---- v1.1 N12: Agents view with a worktree per session (the workspace becomes a git repo from here on)
  const gitWs = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8', stdio: 'pipe' });
  const worktreeList = () => gitWs('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  const agentRow = (id) => api.agents.rows.get(id);
  await scenario('N12 AC1+AC2+AC3: two worktree sessions edit the same file without conflict; a pending approval shows "blocked" and is answered from the view; Merge applies a branch, Discard leaves `git worktree list` clean', async () => {
    await api.review.keepAll();
    if (!fs.existsSync(path.join(ws, '.git'))) {
      gitWs('init', '-q', '-b', 'main');
      gitWs('config', 'user.email', 'e2e@test');
      gitWs('config', 'user.name', 'e2e');
      fs.writeFileSync(path.join(ws, '.gitignore'), '.tugline/\n');
    }
    write('shared.txt', 'one\ntwo\nthree\n');
    gitWs('add', '-A');
    gitWs('commit', '-q', '-m', 'e2e base');
    const idA = await vscode.commands.executeCommand('tugline.agents.newWorktreeSession', { title: 'Session A', id: 'e2eA' });
    const idB = await vscode.commands.executeCommand('tugline.agents.newWorktreeSession', { title: 'Session B', id: 'e2eB' });
    assert(idA && idB && idA !== idB, `two sessions: ${idA} ${idB}`);
    step('two worktree sessions created');
    const A = P.chats.get(idA);
    const B = P.chats.get(idB);
    assert(A.worktree.branch === 'oh/e2eA' && B.worktree.branch === 'oh/e2eB', 'own branches');
    // each session writes the same file in its own worktree
    mock.set((body) => {
      const user = body.messages.filter((m) => m.role === 'user').map(e2eMsgText).join('\n');
      const who = user.includes('write A') ? 'A' : 'B';
      const tools = body.messages.filter((m) => m.role === 'tool').length;
      return tools === 0 ? { calls: [tc('read_file', { path: 'shared.txt' })] } : tools === 1 ? { calls: [tc('write_file', { path: 'shared.txt', content: `one\nedited by ${who}\nthree\n` })] } : { content: `done ${who}` };
    });
    await Promise.all([P.getAgent(A), P.getAgent(B)]);
    A.agent.setMode('yolo');
    B.agent.setMode('auto');
    assert(A.agent.workspace === A.worktree.path && B.agent.workspace === B.worktree.path, 'agents work in their worktrees');
    step('agents built; sending both prompts');
    await Promise.all([P.sendPrompt('write A', { chatId: idA }), P.sendPrompt('write B', { chatId: idB })]);
    step('both runs ended');
    assert(fs.readFileSync(path.join(A.worktree.path, 'shared.txt'), 'utf8') === 'one\nedited by A\nthree\n', `A wrote its copy: ${fs.readFileSync(path.join(A.worktree.path, 'shared.txt'), 'utf8')} | doc: ${vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(A.worktree.path, 'shared.txt'))?.getText()} | tools: ${JSON.stringify(mock.recent.map(toolResults))}`);
    assert(fs.readFileSync(path.join(B.worktree.path, 'shared.txt'), 'utf8') === 'one\nedited by B\nthree\n', 'B wrote its copy');
    assert(read('shared.txt') === 'one\ntwo\nthree\n', "AC1: the user's tree is untouched (no conflict)");
    await api.agents.refreshDiffs();
    for (const id of [idA, idB]) {
      const r = agentRow(id);
      assert(r && r.status === 'done', `AC1: ${id} status ${r && r.status}`);
      assert(r.diff && r.diff.files === 1 && r.diff.added === 1 && r.diff.removed === 1, `AC1: diff stats ${JSON.stringify(r.diff)}`);
    }
    const items = api.agents.getChildren().map((r) => api.agents.getTreeItem(r));
    assert(items.some((i) => i.label === 'Session A' && /done/.test(i.description) && /oh\/e2eA/.test(i.description)), `the view lists A: ${JSON.stringify(items.map((i) => [i.label, i.description]))}`);
    // AC2: an approval in ask mode blocks the session; it is answered from the view
    B.agent.setMode('ask');
    mock.set((body) => {
      const user = body.messages.filter((m) => m.role === 'user');
      const sinceLast = body.messages.slice(body.messages.lastIndexOf(user[user.length - 1])).filter((m) => m.role === 'tool').length;
      return sinceLast === 0 ? { calls: [tc('read_file', { path: 'shared.txt' })] } : sinceLast === 1 ? { calls: [tc('edit_file', { path: 'shared.txt', old_string: 'three', new_string: 'THREE' })] } : { content: 'edited after approval' };
    });
    const run = P.sendPrompt('change three', { chatId: idB });
    await waitFor(() => agentRow(idB) && agentRow(idB).status === 'blocked', 10000, 'blocked status');
    const blockedItem = api.agents.getTreeItem(agentRow(idB));
    assert(/blocked/.test(blockedItem.description) && /\.blocked/.test(blockedItem.contextValue), `AC2: blocked badge ${blockedItem.description}`);
    step('B is blocked; answering from the view');
    // answer every approval of the run from the view (ask mode may ask for more than the edit)
    let answeredCount = 0;
    const titles = [];
    const runDone = run.then(() => true);
    while (!(await Promise.race([runDone, sleep(100).then(() => false)]))) {
      const r = agentRow(idB);
      if (r && r.status === 'blocked') {
        titles.push(r.blocked[0].title);
        if (await vscode.commands.executeCommand('tugline.agents.answer', idB, 'allow')) answeredCount++;
      }
    }
    assert(answeredCount >= 1, 'answered from the view');
    step(`answered ${answeredCount}: ${titles.join(' | ')}`);
    assert(agentRow(idB).status === 'done', `after the answer: ${agentRow(idB).status}`);
    assert(fs.readFileSync(path.join(B.worktree.path, 'shared.txt'), 'utf8').includes('THREE'), 'the approved edit ran');
    assert([...P.posted].some((m) => m.type === 'cancelPending'), "the panel's prompt was withdrawn");
    await api.review.keepAll();
    // AC3: Merge A, Discard B
    step('merging A');
    const merged = await vscode.commands.executeCommand('tugline.agents.merge', idA, true);
    assert(/Merged oh\/e2eA/.test(merged || ''), `merge: ${merged}`);
    assert(read('shared.txt') === 'one\nedited by A\nthree\n', 'AC3: the branch was merged into the user\'s branch');
    const discarded = await vscode.commands.executeCommand('tugline.agents.discard', idB, true);
    assert(/Discarded/.test(discarded || ''), `discard: ${discarded}`);
    const wl = worktreeList();
    assert(wl.length === 1 && fs.realpathSync(wl[0]) === fs.realpathSync(ws), `AC3: git worktree list is clean: ${wl}`);
    assert(gitWs('branch', '--list', 'oh/*').trim() === '', 'no oh/* branches left');
    assert(!agentRow(idA) && !agentRow(idB) && !P.chats.has(idA) && !P.chats.has(idB), 'the sessions are gone from the view and the panel');
  });

  // ================================================================ v1.2 WS24: N45 VS Code parity+, N47 arena view, N48 board view
  const X = api.parity;
  const userTextsOf = (body) => body.messages.filter((m) => m.role === 'user').map(e2eMsgText);
  const ensureRepo = () => {
    if (!fs.existsSync(path.join(ws, '.git'))) gitWs('init', '-q', '-b', 'main');
    // always (a repo made by an earlier scenario that timed out may lack them; the host's global config may sign)
    gitWs('config', 'user.email', 'e2e@test');
    gitWs('config', 'user.name', 'e2e');
    gitWs('config', 'commit.gpgsign', 'false');
    if (!fs.existsSync(path.join(ws, '.gitignore')) || !/\.tugline/.test(read('.gitignore'))) fs.appendFileSync(path.join(ws, '.gitignore'), '.tugline/\n__pycache__/\n');
    gitWs('add', '-A');
    if (gitWs('status', '--porcelain').trim()) gitWs('commit', '-q', '-m', 'e2e checkpoint');
  };

  await scenario('N45 SAC1: the new webviews (arena, board) keep a strict CSP, nonce-only scripts and no remote content', async () => {
    ensureRepo();
    const arena = X.arena();
    const board = await X.kanban();
    for (const [name, html] of [['arena', arena.panel.webview.html], ['board', board.panel.webview.html]]) {
      const a = X.audit(html);
      assert(a.ok, `${name}: ${a.problems.join('; ')}`);
      assert(/script-src 'nonce-[A-Za-z0-9]+'/.test(html), `${name}: nonce script-src`);
    }
    // the audit itself catches violations (so a passing audit means something)
    assert(!X.audit(arena.panel.webview.html.replace(/<script nonce="[^"]+">/, '<script>')).ok, 'a script without the nonce is flagged');
    assert(!X.audit(board.panel.webview.html.replace('</body>', '<img src="https://evil.example/x.png"></body>')).ok, 'remote content is flagged');
    assert(!X.audit(board.panel.webview.html.replace(/script-src 'nonce-[^']+'/, "script-src 'unsafe-inline'")).ok, 'unsafe-inline scripts are flagged');
  });

  await scenario('N45 SAC2 + AC1 auto-approve: categories become permission rules; read-only commands run, other commands still ask, protected paths stay refused', async () => {
    await cfg.update('permissionMode', undefined, vscode.ConfigurationTarget.Global);
    try {
      await X.setAutoApprove(['safeCommands']);
      const userCfg = JSON.parse(fs.readFileSync(path.join(home, '.tugline', 'config.json'), 'utf8'));
      assert(userCfg.permissions.readOnlyCommands === true && !(userCfg.permissions.allow || []).some((r) => /\*/.test(r)) && userCfg.ide.autoApprove.includes('safeCommands'), 'written as permission config (the read-only fast path, no wildcard rule) in the user config');
      assert(X.autoApprove().includes('safeCommands'), 'read back');
      const chat = P.newChat();
      const agent = await P.getAgent(chat);
      assert(agent.policy.opts.mode === 'ask', `mode ask: ${agent.policy.opts.mode}`);
      const asked = [];
      const origPost = P.post.bind(P);
      P.post = (m) => {
        if (m.type === 'permission') {
          asked.push(m.request.detail || m.request.title);
          setTimeout(() => P.onMessage({ type: 'permissionReply', id: m.id, decision: 'deny' }), 10);
        }
        return origPost(m);
      };
      try {
        mock.set(scriptedReplies({ calls: [tc('bash', { command: 'git status --short' })] }, { calls: [tc('bash', { command: 'find . -name n45-none -exec true {} +' })] }, { calls: [tc('bash', { command: 'rm -rf build-n45' })] }, { content: 'done' }));
        await P.sendPrompt('status then clean');
        const tr = mock.recent.map(toolResults).flat();
        assert(!asked.some((a) => /git status/.test(a)), `git status ran without asking: ${asked}`);
        assert(asked.some((a) => /rm -rf build-n45/.test(a)), `rm asked: ${asked}`);
        assert(asked.some((a) => /find \. -name n45-none -exec/.test(a)), `find -exec asked (review F1): ${asked}`);
        assert(tr.some((t) => /denied/i.test(t)), 'the denial came back to the model');
        // the most permissive category still cannot write a protected path (tests/** in the E2E settings)
        await X.setAutoApprove(['allCommands', 'editWorkspace']);
        const chat2 = P.newChat();
        const a2 = await P.getAgent(chat2);
        assert(a2.policy.opts.mode === 'yolo', `mode yolo: ${a2.policy.opts.mode}`);
        mock.set(scriptedReplies({ calls: [tc('write_file', { path: 'tests/test_calc.py', content: 'pass\n' })] }, { content: 'done' }));
        const before = read('tests/test_calc.py');
        await P.sendPrompt('rewrite the test');
        assert(read('tests/test_calc.py') === before, 'protected path unchanged');
        assert(mock.recent.map(toolResults).flat().some((t) => /protected/i.test(t)), 'refused as protected');
      } finally {
        P.post = origPost;
      }
      await X.setAutoApprove([]);
      const cleared = JSON.parse(fs.readFileSync(path.join(home, '.tugline', 'config.json'), 'utf8'));
      assert(!cleared.permissions.allow.includes('Bash(git status*)') && cleared.permissions.readOnlyCommands === undefined && cleared.permissionMode === 'ask', 'unticking removes exactly what was added');
    } finally {
      await cfg.update('permissionMode', 'auto', vscode.ConfigurationTarget.Global);
    }
  });

  await scenario('N47 AC3: the arena view shows live streams side by side and applies the pick', async () => {
    ensureRepo();
    write('arena_math.py', 'def add(a, b):\n    return a - b\n');
    gitWs('add', '-A');
    gitWs('commit', '-q', '-m', 'arena fixture');
    mock.set((body) => {
      const tools = body.messages.filter((m) => m.role === 'tool').length;
      if (body.model === 'good') return tools === 0 ? { content: 'Reading the file.\n', calls: [tc('read_file', { path: 'arena_math.py' })] } : tools === 1 ? { calls: [tc('edit_file', { path: 'arena_math.py', old_string: 'return a - b', new_string: 'return a + b' })] } : { content: 'Fixed add.\n' };
      return tools === 0 ? { content: 'Writing a note.\n', calls: [tc('write_file', { path: 'NOTE.md', content: 'hm\n' })] } : { content: 'Done.\n' };
    }, 30);
    X.approve = async () => ({ decision: 'allow' });
    const arena = X.arena();
    arena.posted.length = 0;
    await arena.onMessage({ type: 'start', prompt: 'Fix add() in arena_math.py', models: 'good,other-model', agents: '', check: 'python3 -c "import arena_math; assert arena_math.add(2, 3) == 5"' });
    const r = await arena.running;
    assert(r, `arena finished: ${JSON.stringify(arena.posted.filter((m) => m.type === 'error'))}`);
    const streams = arena.posted.filter((m) => m.type === 'stream');
    assert(streams.some((m) => m.label === 'A' && /Reading the file/.test(m.text)) && streams.some((m) => m.label === 'B' && /Writing a note/.test(m.text)), 'both contestants streamed');
    assert(arena.posted.some((m) => m.type === 'status' && m.label === 'A' && /running/.test(m.text)), 'live status');
    const res = arena.posted.find((m) => m.type === 'result');
    assert(res && res.entries.find((e) => e.label === 'A').outcome === 'pass' && res.entries.find((e) => e.label === 'B').outcome === 'fail', `results: ${JSON.stringify(res)}`);
    X.approve = async () => ({ decision: 'allow' });
    await arena.onMessage({ type: 'pick', label: 'A' });
    const picked = arena.posted.find((m) => m.type === 'picked');
    assert(picked && picked.merged, `picked: ${JSON.stringify(picked)}`);
    assert(/return a \+ b/.test(read('arena_math.py')), 'the winner\'s diff was applied');
    assert(!fs.existsSync(path.join(ws, 'NOTE.md')), 'the loser was not');
    assert(gitWs('branch', '--list', 'oh/arena-*').trim() === '', 'arena branches cleaned up');
    arena.panel.dispose();
  });

  await scenario('N48 AC4: the Kanban view runs cards in worktrees, shows them by column, merges one and shows a conflict', async () => {
    ensureRepo();
    write('board.txt', 'one\ntwo\nthree\n');
    gitWs('add', '-A');
    gitWs('commit', '-q', '-m', 'board fixture');
    mock.set((body) => {
      const user = userTextsOf(body).join('\n');
      const tools = body.messages.filter((m) => m.role === 'tool').length;
      const who = /card one/.test(user) ? 'ONE' : 'TWO';
      return tools === 0 ? { calls: [tc('read_file', { path: 'board.txt' })] } : tools === 1 ? { calls: [tc('write_file', { path: 'board.txt', content: `one\n${who}\nthree\n` })] } : { content: `done ${who}` };
    });
    const board = await X.kanban();
    X.approve = async () => ({ decision: 'allow' });
    await board.onMessage({ type: 'add', prompt: 'card one: edit board.txt', title: 'card one' });
    await board.onMessage({ type: 'add', prompt: 'card two: edit board.txt', title: 'card two' });
    const cards = () => board.posted.filter((m) => m.type === 'board').at(-1).cards;
    assert(cards().filter((c) => c.state === 'backlog').length >= 2, 'two cards in Backlog');
    await board.onMessage({ type: 'start', id: 'card-one' });
    await board.onMessage({ type: 'start', id: 'card-two' });
    await waitFor(() => board.runs.size >= 2, 5000, 'runs started');
    await Promise.all([...board.runs.values()]);
    await waitFor(() => cards().filter((c) => c.id.startsWith('card-') && c.state === 'review').length >= 2, 20000, 'both cards in Review');
    const c1 = cards().find((c) => c.id === 'card-one');
    assert(c1.activity && c1.base && c1.baseSubject === 'board fixture', `card shows activity and base: ${JSON.stringify(c1)}`);
    assert(!read('board.txt').includes('ONE'), 'the user\'s tree is untouched while cards run');
    await board.onMessage({ type: 'diff', id: 'card-one' });
    assert(X.lastDocument && /\+ONE/.test(X.lastDocument.getText()), 'the diff opened in an editor');
    await board.onMessage({ type: 'merge', id: 'card-one' });
    assert(read('board.txt') === 'one\nONE\nthree\n', `card one merged: ${JSON.stringify(board.posted.filter((m) => m.type === 'notice'))} ${JSON.stringify(cards().find((c) => c.id === 'card-one'))}`);
    await board.onMessage({ type: 'merge', id: 'card-two' });
    const two = cards().find((c) => c.id === 'card-two');
    assert(two.state === 'conflict' && two.conflicts.includes('board.txt'), `card two shown as a conflict: ${JSON.stringify(two)}`);
    assert(read('board.txt') === 'one\nONE\nthree\n', 'the conflicting card was not merged');
    assert(cards().find((c) => c.id === 'card-one').state === 'merged', 'card one in Merged');
    // review F12: the card's transcript, and a command in its worktree (approved through the same UI)
    await board.onMessage({ type: 'transcript', id: 'card-two' });
    assert(board.lastTranscript && /card two: edit board\.txt/.test(board.lastTranscript.getText()) && /done TWO/.test(board.lastTranscript.getText()), `transcript: ${board.lastTranscript && board.lastTranscript.getText().slice(0, 300)}`);
    const approvals = [];
    X.approve = async (r) => (approvals.push(r.title), { decision: 'allow' });
    await board.onMessage({ type: 'exec', id: 'card-two', command: 'cat board.txt' });
    assert(board.lastExec && board.lastExec.ran && /TWO/.test(board.lastExec.output), `exec in the card's worktree: ${JSON.stringify(board.lastExec)}`);
    assert(cards().every((c) => typeof c.title === 'string'), 'board still renders');
    await board.onMessage({ type: 'discard', id: 'card-two' });
    assert(!cards().some((c) => c.id === 'card-two'), 'trashed cards leave the board');
    board.panel.dispose();
  });

  await scenario('N45 AC1 history: star a session (listed first), export it (md/html/json), size, delete all keeps favourites', async () => {
    const list = api.history.sessions();
    assert(list.length >= 2, `sessions: ${list.length}`);
    const target = list[list.length - 1];
    await vscode.commands.executeCommand('tugline.history.favorite', target);
    assert(api.history.sessions()[0].id === target.id, 'the favourite is listed first');
    const out = path.join(home, `exp-${Date.now()}.html`);
    const file = await vscode.commands.executeCommand('tugline.history.export', target, 'html', out);
    assert(file === out && /<!doctype html>/.test(fs.readFileSync(out, 'utf8')) && !/<script/i.test(fs.readFileSync(out, 'utf8')), 'exported as escaped HTML');
    const kb = await vscode.commands.executeCommand('tugline.history.size');
    assert(kb > 0, `size ${kb}`);
    const n = await vscode.commands.executeCommand('tugline.history.deleteAll', true);
    assert(n >= 1, `deleted ${n}`);
    const left = api.history.sessions();
    assert(left.length === 1 && left[0].id === target.id, `only the favourite remains: ${left.map((s) => s.id)}`);
  });

  await scenario('N45 AC1 editor commands: explain / improve code, the "Fix with Tugline" quick fix, focus chat', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'calc.py'));
    const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(0, 0, 2, 0);
    mock.set(() => ({ content: 'explained' }));
    await vscode.commands.executeCommand('tugline.explainCode');
    await waitFor(() => mock.recent.some((b) => userTextsOf(b).some((t) => /Explain this code[\s\S]*calc\.py lines 1-3[\s\S]*def average/.test(t))), 15000, 'explain prompt');
    mock.set(() => ({ content: 'improved' }));
    await vscode.commands.executeCommand('tugline.improveCode');
    await waitFor(() => mock.recent.some((b) => userTextsOf(b).some((t) => /Improve this code/.test(t))), 15000, 'improve prompt');
    const coll = vscode.languages.createDiagnosticCollection('n45');
    coll.set(doc.uri, [new vscode.Diagnostic(new vscode.Range(2, 4, 2, 10), 'division by zero when numbers is empty', vscode.DiagnosticSeverity.Error)]);
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(2, 4, 2, 10));
    const fix = (actions || []).find((a) => a.title === 'Fix with Tugline');
    assert(fix && fix.command, `quick fix offered: ${(actions || []).map((a) => a.title)}`);
    mock.set(() => ({ content: 'fixed' }));
    await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
    await waitFor(() => mock.recent.some((b) => userTextsOf(b).some((t) => /Fix this problem in calc\.py:\n- division by zero/.test(t))), 15000, 'fix prompt');
    coll.dispose();
    const mark = P.posted.length;
    await vscode.commands.executeCommand('tugline.focusChat');
    assert(P.posted.slice(mark).some((m) => m.type === 'focusComposer'), 'composer focused');
  });

  await scenario('N45 AC1 terminal: "Add Terminal Output to Chat" attaches the selected terminal output', async () => {
    const term = vscode.window.createTerminal({ name: 'n45-term' });
    term.show();
    term.sendText('echo n45-terminal-marker');
    await sleep(2500);
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    const mark = P.posted.length;
    await vscode.commands.executeCommand('tugline.addTerminalOutput');
    await waitFor(() => P.posted.slice(mark).some((m) => /n45-terminal-marker/.test(JSON.stringify(m))), 8000, 'terminal output added to the chat');
    term.dispose();
  });

  await scenario('N45 AC1 SCM: Generate Commit Message describes the diff through the model (nothing is committed)', async () => {
    ensureRepo();
    write('calc.py', read('calc.py') + '\n# touched for the commit message\n');
    const head = gitWs('rev-parse', 'HEAD').trim();
    mock.set((body) => ({ content: /<untrusted_diff>[\s\S]*touched for the commit message/.test(userTextsOf(body).join('\n')) ? 'Document calc.py\n\nExplain the module.' : 'no diff seen' }));
    const msg = await vscode.commands.executeCommand('tugline.generateCommitMessage');
    assert(msg === 'Document calc.py\n\nExplain the module.', `message: ${msg}`);
    assert(gitWs('rev-parse', 'HEAD').trim() === head, 'nothing committed');
    const gitApi = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI?.(1);
    const repo = gitApi?.repositories?.[0];
    if (repo) assert(repo.inputBox.value === msg, 'the SCM input box holds the message');
    else assert((await vscode.env.clipboard.readText()) === msg, 'copied to the clipboard without the git extension');
    gitWs('checkout', '--', 'calc.py');
  });

  await scenario('N45 AC1 notebooks: explain / improve a cell, generate a cell', async () => {
    const nbPath = path.join(ws, 'n45.ipynb');
    fs.writeFileSync(nbPath, JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(21 * 2)  # n45-cell'], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
    const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.file(nbPath));
    await vscode.window.showNotebookDocument(nb);
    mock.set(() => ({ content: 'explained cell' }));
    await vscode.commands.executeCommand('tugline.notebook.explainCell', nb.cellAt(0));
    await waitFor(() => mock.recent.some((b) => userTextsOf(b).some((t) => /Explain this notebook cell \(n45\.ipynb, cell 1\)[\s\S]*n45-cell/.test(t))), 15000, 'explain cell prompt');
    mock.set(() => ({ content: 'improved' }));
    await vscode.commands.executeCommand('tugline.notebook.improveCell', nb.cellAt(0));
    await waitFor(() => mock.recent.some((b) => userTextsOf(b).some((t) => /Improve notebook cell 1 of n45\.ipynb with notebook_edit/.test(t))), 15000, 'improve cell prompt');
    mock.set(() => ({ content: 'generated' }));
    await vscode.commands.executeCommand('tugline.notebook.generateCell', 'plot a sine wave');
    await waitFor(() => mock.recent.some((b) => userTextsOf(b).some((t) => /add a new code cell after cell 1 with notebook_edit that does: plot a sine wave/.test(t))), 15000, 'generate cell prompt');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  await scenario('N45 AC1 checkpoint compare, copy conversation, favourite models, IDE context, shared /commands (/export), walkthrough', async () => {
    // a turn that edits a file creates checkpoints; compare the newest with the current files
    const chat = await freshChat('auto');
    write('cmp.txt', 'before\n');
    mock.set(scriptedReplies({ calls: [tc('read_file', { path: 'cmp.txt' })] }, { calls: [tc('write_file', { path: 'cmp.txt', content: 'after\n' })] }, { content: 'changed' }));
    await P.sendPrompt('change cmp.txt');
    step('checkpoints listed');
    const cps = await checkpointList();
    const cp = cps.find((c) => /turn 1: change cmp\.txt/.test(c.label));
    step(`checkpoint ${cp && cp.id}`);
    assert(cp, 'the turn checkpoint of that run');
    const list = await vscode.commands.executeCommand('tugline.checkpoints.compare', cp.id);
    assert(list && list.files.some((f) => f.path === 'cmp.txt'), `compare: ${JSON.stringify(list && list.files)}`);
    assert(X.lastDocument.languageId === 'diff' && /cmp\.txt/.test(X.lastDocument.getText()), 'shown as a diff document');
    step('compared');
    const md = await vscode.commands.executeCommand('tugline.copyConversation');
    step('copied');
    assert(/## User\n\nchange cmp\.txt/.test(md) && (await vscode.env.clipboard.readText()) === md, 'conversation copied as Markdown');
    // star the last endpoint model the picker lists (earlier scenarios decide which endpoint that is)
    P.sendStatus();
    const st0 = [...P.posted].reverse().find((m) => m.type === 'status');
    const fav = [...st0.picker].reverse().find((i) => i.value.startsWith('model:'));
    assert(fav && st0.picker[0].value !== fav.value, `a model that is not first already: ${JSON.stringify(st0.picker)}`);
    await vscode.commands.executeCommand('tugline.toggleFavoriteModel', fav.value);
    P.sendStatus();
    const st = [...P.posted].reverse().find((m) => m.type === 'status');
    assert(st.picker[0].value === fav.value && /^★/.test(st.picker[0].label), `favourite first: ${JSON.stringify(st.picker.slice(0, 3))}`);
    await vscode.commands.executeCommand('tugline.toggleFavoriteModel', fav.value);
    // IDE context (opt-in): the active file, cursor and selection go with the prompt
    await cfg.update('ideContext', true, vscode.ConfigurationTarget.Global);
    try {
      const doc = await vscode.workspace.openTextDocument(path.join(ws, 'calc.py'));
      const ed = await vscode.window.showTextDocument(doc);
      ed.selection = new vscode.Selection(1, 0, 2, 0);
      mock.set(() => ({ content: 'seen' }));
      await P.sendPrompt('what is selected?');
      const sent = userTextsOf(mock.recent.at(-1)).join('\n');
      assert(/<attached_context source="ide" kind="editor">[\s\S]*active: calc\.py line \d+[\s\S]*selection \(lines 2-3\):\n\s+"""Mean of a list/.test(sent), `IDE context: ${mock.recent.length} request(s); last user texts: ${JSON.stringify(userTextsOf(mock.recent.at(-1)).map((t) => t.slice(0, 80) + ' … ' + t.slice(-300)))}`);
    } finally {
      await cfg.update('ideContext', undefined, vscode.ConfigurationTarget.Global);
    }
    mock.set(() => ({ content: 'unused' }));
    const before = mock.requests.length;
    await P.sendPrompt('/export md n45-export.md');
    assert(fs.existsSync(path.join(ws, 'n45-export.md')) && mock.requests.length === before, '/export ran through the shared registry, not the model');
    void chat;
    const wt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).contributes.walkthroughs;
    assert(wt && wt[0].steps.length >= 4 && wt[0].steps.every((s) => fs.existsSync(path.join(__dirname, '..', s.media.markdown))), 'walkthrough contributed with its media');
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'tugline.tugline#tugline.start', false);
  });

  await scenario('N46 RF11: the code_* tools use the editor\'s language features in VS Code (definition, references, hover, call hierarchy through the providers)', async () => {
    write('nav/a.n46nav', 'call target_fn here\n');
    write('nav/b.n46nav', 'line one\nline two\nline three\nline four\n  target_fn is defined here\n');
    const bUri = vscode.Uri.file(path.join(ws, 'nav/b.n46nav'));
    const sel = { pattern: '**/*.n46nav' };
    const regs = [
      vscode.languages.registerDefinitionProvider(sel, { provideDefinition: () => new vscode.Location(bUri, new vscode.Position(4, 2)) }),
      vscode.languages.registerReferenceProvider(sel, { provideReferences: (doc) => [new vscode.Location(doc.uri, new vscode.Position(0, 5)), new vscode.Location(bUri, new vscode.Position(4, 2))] }),
      vscode.languages.registerHoverProvider(sel, { provideHover: () => new vscode.Hover(new vscode.MarkdownString('**target_fn**: from the n46 test provider')) }),
      vscode.languages.registerCallHierarchyProvider(sel, {
        prepareCallHierarchy: (doc, p) => new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'target_fn', '', bUri, new vscode.Range(4, 2, 4, 11), new vscode.Range(4, 2, 4, 11)),
        provideCallHierarchyIncomingCalls: () => [new vscode.CallHierarchyIncomingCall(new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'caller_fn', '', vscode.Uri.file(path.join(ws, 'nav/a.n46nav')), new vscode.Range(0, 0, 0, 4), new vscode.Range(0, 0, 0, 4)), [new vscode.Range(0, 5, 0, 14)])],
        provideCallHierarchyOutgoingCalls: () => [],
      }),
    ];
    try {
      const chat = await freshChat('auto');
      mock.set(scriptedReplies(
        { calls: [tc('code_definition', { path: 'nav/a.n46nav', line: 1, symbol: 'target_fn' })] },
        { calls: [tc('code_references', { path: 'nav/a.n46nav', line: 1, symbol: 'target_fn' })] },
        { calls: [tc('code_hover', { path: 'nav/a.n46nav', line: 1, symbol: 'target_fn' })] },
        { calls: [tc('code_calls', { path: 'nav/a.n46nav', line: 1, symbol: 'target_fn', direction: 'incoming' })] },
        { content: 'navigated' },
      ));
      await P.sendPrompt('where is target_fn', { chatId: chat.id });
      const tr = mock.recent.map(toolResults).flat();
      const all = tr.join('\n---\n');
      assert(tr.some((t) => /vscode language features/.test(t) && /nav\/b\.n46nav:5/.test(t)), `definition via the editor's provider (${mock.recent.length} requests; last: ${JSON.stringify(mock.recent.at(-1)?.messages?.slice(-3)).slice(0, 1500)}):\n${all}`);
      assert(tr.some((t) => /nav\/a\.n46nav:1/.test(t) && /nav\/b\.n46nav:5/.test(t) && /References|reference/i.test(t)), `references via the provider:\n${all}`);
      assert(tr.some((t) => /from the n46 test provider/.test(t)), `hover via the provider:\n${all}`);
      assert(tr.some((t) => /caller_fn/.test(t)), `incoming calls via the call hierarchy provider:\n${all}`);
    } finally {
      for (const r of regs) r.dispose();
    }
  });

  async function checkpointList() {
    const mark = P.posted.length;
    await P.onMessage({ type: 'checkpoints', action: 'list' });
    await waitFor(() => P.posted.slice(mark).some((m) => m.type === 'checkpoints'), 15000, 'checkpoints');
    return P.posted.slice(mark).find((m) => m.type === 'checkpoints').list;
  }

  await screenshot();
  srv && srv.close();
  finish();

  async function screenshot() {
    await sleep(1500);
    try {
      const shot = process.env.TUG_E2E_SHOT || '/tmp/oh-vscode-e2e.png';
      execFileSync('import', ['-window', 'root', shot]);
      console.log('[e2e] screenshot', shot);
    } catch (e) {
      console.log('[e2e] screenshot failed', e.message);
    }
  }
  function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`[e2e] ${results.length - failed.length}/${results.length} scenarios passed`);
    if (failed.length) throw new Error(`E2E failures:\n${failed.map((f) => `- ${f.name}\n${f.error}`).join('\n')}`);
  }
};
