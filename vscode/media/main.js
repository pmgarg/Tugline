// Tugline chat webview. Vanilla JS, no framework; talks to the extension via postMessage.
// Views: Chat (several chats as tabs), Checkpoints, MCP & Skills, Settings.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ic = (name) => `<i class="codicon codicon-${name}" aria-hidden="true"></i>`;
  app.innerHTML = `
    <header class="top">
      <div class="tabs" id="tabs" role="tablist" aria-label="Chats"></div>
      <div class="tools">
        <nav class="views" aria-label="Views">
          <button class="ib on" data-view="chat" title="Chat" aria-label="Chat">${ic('comment-discussion')}</button>
          <button class="ib" data-view="checkpoints" title="Checkpoints: rewind files or the chat" aria-label="Checkpoints">${ic('history')}</button>
          <button class="ib" data-view="manage" title="MCP servers and skills" aria-label="MCP servers and skills">${ic('extensions')}</button>
          <button class="ib" data-view="settings" title="Settings" aria-label="Settings">${ic('settings-gear')}</button>
        </nav>
        <button class="ib estop" id="estop" title="Emergency stop (Ctrl+Alt+Shift+Esc): stop every agent and all automation" aria-label="Emergency stop">${ic('debug-stop')}</button>
      </div>
    </header>
    <section id="view-chat" class="view">
      <div id="logs"></div>
      <div id="dock">
        <div id="todos" class="todos hidden"></div>
        <div id="pending" class="pending hidden"></div>
      </div>
      <footer class="composer">
        <div id="atts" class="atts hidden"></div>
        <div id="mention" class="mention hidden" role="listbox"></div>
        <div id="ctx" class="ctx hidden"></div>
        <div class="box">
          <textarea id="input" rows="2" placeholder="Ask the agent… @ files, / commands" title="Enter to send, Shift+Enter for a new line, @ to mention files, / for commands and skills; paste or drop images" aria-label="Message the agent"></textarea>
          <div class="bar">
            <div class="chips">
            <span class="chipw"><select id="mode" class="chip" title="Permission mode. Ask first: ask before every edit and command. Accept edits: edit without asking, commands still ask. Plan: read-only until you approve a plan. Auto: a safety classifier approves routine steps. YOLO: no prompts and no classifier (deny rules, protected files and the sandbox still apply)." aria-label="Permission mode">
              <option value="ask">Ask first</option>
              <option value="acceptEdits">Accept edits</option>
              <option value="plan">Plan</option>
              <option value="auto">Auto</option>
              <option value="yolo">YOLO</option>
            </select></span>
            <span class="chipw"><select id="model" class="chip" title="Model for this chat" aria-label="Model"></select></span>
            <span class="chipw"><select id="effort" class="chip" title="Reasoning effort" aria-label="Reasoning effort">
              <option value="default">Effort: auto</option><option value="off">Effort: off</option><option value="low">Effort: low</option><option value="medium">Effort: medium</option><option value="high">Effort: high</option>
            </select></span>
            </div>
            <div class="acts">
            <button id="mic" class="ib" title="Voice input (push to talk; needs tugline.voice.enabled and a local transcriber)" aria-label="Voice input">${ic('mic')}</button>
            <button id="steer" class="ib hidden" title="Steer: send now; the agent reads it at its next step" aria-label="Steer">${ic('debug-step-into')}</button>
            <button id="stop" class="ib hidden" title="Stop the agent" aria-label="Stop">${ic('debug-stop')}</button>
            <button id="send" class="send" title="Send (Enter)" aria-label="Send">${ic('send')}</button>
            </div>
          </div>
        </div>
        <div class="under">
          <label class="chk" title="Attach the file open in the editor (and your selection) to the message"><input type="checkbox" id="incfile" checked> Current file</label>
          <span class="spacer"></span>
          <div class="meter" id="meter" title="Context window"><svg viewBox="0 0 20 20" class="ring" aria-hidden="true"><circle cx="10" cy="10" r="8" class="track"></circle><circle cx="10" cy="10" r="8" class="fill" id="meterFill"></circle></svg><span id="meterLabel"></span></div>
          <span id="usage" class="usage"></span>
        </div>
      </footer>
    </section>
    <section id="view-checkpoints" class="view hidden"><div class="pad"><div class="vhead"><h2>Checkpoints</h2><span class="spacer"></span><button class="ib" id="cpRefresh" title="Refresh" aria-label="Refresh">${ic('refresh')}</button></div><div class="row opts"><label class="chk"><input type="checkbox" id="cpMine" checked> This chat only</label><label class="chk"><input type="checkbox" id="cpAll"> Show turns without file changes</label></div><div id="cpList" class="list"></div></div></section>
    <section id="view-manage" class="view hidden"><div class="pad" id="manage"></div></section>
    <section id="view-settings" class="view hidden"><div class="pad" id="settings"></div></section>`;

  const $ = (id) => document.getElementById(id);
  const input = $('input');
  $('mic').onclick = () => vscode.postMessage({ type: 'voice' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const saved = vscode.getState() || {};
  const state = { epoch: saved.epoch, html: saved.html || {}, mode: saved.mode || 'ask', view: 'chat' };
  let active = '';
  let chats = [];
  const per = new Map(); // chatId → {el, streamEl, streamText, reasoningEl, toolEls, running, todos}
  let images = [];
  let cpData = null;

  function chatState(id) {
    if (!per.has(id)) {
      const el = document.createElement('main');
      el.className = 'log hidden';
      el.dataset.chat = id;
      el.innerHTML = emptyHtml();
      if (state.html[id]) el.innerHTML = state.html[id];
      $('logs').appendChild(el);
      per.set(id, { el, streamEl: null, streamText: '', reasoningEl: null, toolEls: new Map(), running: false, todos: [] });
    }
    return per.get(id);
  }
  const cur = () => chatState(active);

  // An empty chat invites a first task: three starters fill the composer (they never send on their own).
  function emptyHtml() {
    const starters = [
      ['beaker', 'Fix the failing tests', 'Run the tests, find why they fail and fix the code. Do not change the tests.'],
      ['book', 'Explain the current file', 'Explain what the current file does, how it fits into the project, and anything risky in it.'],
      ['list-ordered', 'Plan a change first', 'Make a plan for this change before editing anything: '],
    ];
    return `<div class="empty"><h2>What should we work on?</h2>
      <p class="lede">The agent reads your code, edits files, runs commands in a sandbox and checks its work with your project's tests.</p>
      <div class="starters">${starters.map(([i, t, prompt]) => `<button class="starter" data-prompt="${esc(prompt)}">${ic(i)}<span>${esc(t)}</span></button>`).join('')}</div>
      <p class="hint">Type <kbd>@</kbd> to add files, problems or terminal output, and <kbd>/</kbd> for commands. Select code and press <kbd>Ctrl+Alt+K</kbd> to edit it inline.</p>
      <p class="hint"><a href="#" data-act="cfg">Configure endpoint</a> <span class="sep"></span> <a href="#" data-act="test">Test connection</a></p></div>`;
  }

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const html = {};
      for (const [id, p] of per) html[id] = p.el.innerHTML.slice(-300000);
      vscode.setState({ epoch: state.epoch, html, mode: state.mode });
    }, 300);
  }

  // Minimal, safe markdown. Everything is escaped first; inline code is swapped out for
  // placeholders before any other substitution so model text can never land inside an attribute.
  function md(src) {
    const parts = String(src).split(/```/);
    let html = '';
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        const nl = p.indexOf('\n');
        const lang = nl > 0 ? p.slice(0, nl).trim() : '';
        const code = nl > 0 ? p.slice(nl + 1) : p;
        html += `<pre class="code"><div class="lang">${esc(lang)}</div><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      } else {
        const codes = [];
        let t = String(p).replace(/`([^`\n]+)`/g, (m, c) => {
          codes.push(c);
          return `\u0000${codes.length - 1}\u0000`;
        });
        t = esc(t);
        t = t.replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/^## (.*)$/gm, '<h3>$1</h3>').replace(/^# (.*)$/gm, '<h3>$1</h3>');
        t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
        t = t.replace(/\[([^\]\u0000]+)\]\((https?:\/\/[^)\s"'<>\u0000]+)\)/g, '<a href="$2">$1</a>');
        // GFM tables (models answer with them often): a header row, a |---| separator, then body rows
        t = t.replace(/(^|\n)(\|[^\n]*\|)[ \t]*\n\|[ \t:|-]*-[ \t:|-]*\|[ \t]*(?:\n|$)((?:\|[^\n]*\|[ \t]*(?:\n|$))*)/g, (m, pre, head, body) => {
          const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
          const rows = body.split('\n').filter((l) => l.trim());
          return `${pre}<div class="tbl"><table><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
        });
        t = t.replace(/^(\s*)[-*] (.*)$/gm, '$1• $2');
        t = t.replace(/\n/g, '<br>').replace(/(<\/h[34]>|<\/div>)<br>/g, '$1');
        t = t.replace(/\u0000(\d+)\u0000/g, (m, n) => {
          const c = esc(codes[Number(n)]);
          return `<code class="inline" data-path="${c}">${c}</code>`;
        });
        html += t;
      }
    });
    return html;
  }

  function add(chatId, cls, html) {
    const p = chatState(chatId);
    p.el.querySelector('.empty')?.remove();
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = html;
    p.el.appendChild(d);
    if (chatId === active) p.el.scrollTop = p.el.scrollHeight;
    save();
    return d;
  }

  function endStream(p) {
    p.streamEl = null;
    p.streamText = '';
    p.reasoningEl = null;
  }

  // ------------------------------------------------------------ chats

  function renderTabs() {
    $('tabs').innerHTML = chats
      .map((c) => `<span class="tab ${c.id === active ? 'on' : ''} ${c.running ? 'busy' : ''}" role="tab" aria-selected="${c.id === active}" data-id="${esc(c.id)}" title="${esc(c.title)}">${c.running ? '<span class="dot" aria-label="running"></span>' : ''}<span class="tt">${esc(c.title)}</span><span class="x" data-close="${esc(c.id)}" title="Close chat" aria-label="Close chat">${ic('close')}</span></span>`)
      .join('');
  }

  function showChat(id) {
    active = id;
    for (const [cid, p] of per) p.el.classList.toggle('hidden', cid !== id);
    chatState(id).el.classList.remove('hidden');
    setRunning(chatState(id).running);
    renderTodos(chatState(id).todos);
    renderTabs();
  }

  $('tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) {
      vscode.postMessage({ type: 'closeChat', chatId: close.dataset.close });
      per.get(close.dataset.close)?.el.remove();
      per.delete(close.dataset.close);
      return;
    }
    const tab = e.target.closest('.tab');
    if (tab) vscode.postMessage({ type: 'switchChat', chatId: tab.dataset.id });
  });
  $('estop').onclick = () => vscode.postMessage({ type: 'emergencyStop' });

  // ------------------------------------------------------------ views

  function showView(v) {
    state.view = v;
    document.querySelectorAll('nav.views button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    for (const s of ['chat', 'checkpoints', 'manage', 'settings']) $('view-' + s).classList.toggle('hidden', s !== v);
    if (v === 'checkpoints') vscode.postMessage({ type: 'checkpoints', action: 'list' });
    if (v === 'manage') vscode.postMessage({ type: 'manage', action: 'load' });
    if (v === 'settings') vscode.postMessage({ type: 'settings', action: 'load' });
  }
  document.querySelectorAll('nav.views button[data-view]').forEach((b) => (b.onclick = () => showView(b.dataset.view)));

  // ------------------------------------------------------------ composer

  function setRunning(r) {
    $('stop').classList.toggle('hidden', !r);
    $('steer').classList.toggle('hidden', !r);
    $('send').innerHTML = ic(r ? 'list-unordered' : 'send');
    $('send').title = r ? 'Queue: runs after the current task (Enter)' : 'Send (Enter)';
    $('send').setAttribute('aria-label', r ? 'Queue message' : 'Send');
    app.classList.toggle('running', r);
  }

  let uidSeq = 0;
  function send() {
    const text = input.value.trim();
    if (!text && !images.length) return;
    const uid = 'w' + Date.now().toString(36) + (uidSeq++).toString(36);
    const d = add(active, 'user', userHtml(text, images));
    d.dataset.uid = uid;
    d.dataset.text = text;
    input.value = '';
    input.style.height = 'auto';
    closeMention();
    const imgs = images;
    images = [];
    renderAtts();
    endStream(cur());
    vscode.postMessage({ type: 'send', chatId: active, text, includeFile: $('incfile').checked, images: imgs, uid });
  }

  function userHtml(text, imgs) {
    const thumbs = (imgs || []).map((i) => `<img class="thumb" src="${esc(i.dataUrl)}" alt="${esc(i.name)}">`).join('');
    return `<div class="utext">${md(text)}</div>${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}<span class="edit hidden" title="Edit and resubmit" role="button" aria-label="Edit and resubmit">${ic('edit')}</span>`;
  }

  $('send').onclick = send;
  $('stop').onclick = () => vscode.postMessage({ type: 'stop', chatId: active });
  $('steer').onclick = () => {
    const text = input.value.trim();
    if (!text) return;
    add(active, 'steer', `${ic('debug-step-into')}<span>Steer: ${esc(text)}</span>`);
    input.value = '';
    vscode.postMessage({ type: 'steer', chatId: active, text });
  };
  $('mode').value = state.mode;
  app.dataset.mode = state.mode;
  $('mode').onchange = () => {
    state.mode = $('mode').value;
    app.dataset.mode = state.mode;
    vscode.postMessage({ type: 'setMode', chatId: active, mode: $('mode').value });
  };
  $('model').onchange = () => vscode.postMessage({ type: 'setModel', chatId: active, value: $('model').value });
  $('effort').onchange = () => vscode.postMessage({ type: 'setEffort', chatId: active, effort: $('effort').value });

  input.addEventListener('keydown', (e) => {
    if (mention.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % Math.max(1, mention.items.length);
        renderMention();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && mention.items.length) {
        e.preventDefault();
        pickMention(mention.items[mention.sel]);
        return;
      }
      if (e.key === 'Escape') {
        closeMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // @-mentions (B4): popup fed by the extension (files, folders, providers).
  const mention = { open: false, items: [], sel: 0, start: 0, req: 0 };
  function mentionToken() {
    const before = input.value.slice(0, input.selectionStart);
    // "/" at the very start: slash commands (core registry, built-ins, skills)
    const sl = /^\/([^\s/]*)$/.exec(before);
    if (sl) return { q: sl[1], start: 0, kind: 'slash' };
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    return m ? { q: m[2], start: before.length - m[2].length - 1, kind: 'mention' } : undefined;
  }
  // pickers are as wide as their current choice (a native select is as wide as its longest option)
  const shortModel = (id) => String(id || '').split('/').pop();
  const measure = document.createElement('canvas').getContext('2d');
  function fitChip(sel) {
    const o = sel.options[sel.selectedIndex];
    if (!o) return;
    const cs = getComputedStyle(sel);
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    sel.style.width = `${Math.ceil(measure.measureText(o.text).width) + 28}px`;
  }
  const fitChips = () => ['mode', 'model', 'effort'].forEach((id) => fitChip($(id)));
  ['mode', 'model', 'effort'].forEach((id) => $(id).addEventListener('change', () => fitChip($(id))));
  window.addEventListener('load', fitChips);
  document.fonts?.ready?.then(fitChips);

  // the composer grows with its text (up to 40% of the panel, then it scrolls)
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  };
  input.addEventListener('input', autosize);
  input.addEventListener('input', () => {
    const t = mentionToken();
    if (!t) return closeMention();
    mention.start = t.start;
    mention.req++;
    vscode.postMessage({ type: 'mentionQuery', q: t.q, kind: t.kind, reqId: mention.req });
  });
  function renderMention() {
    const el = $('mention');
    if (!mention.open || !mention.items.length) return el.classList.add('hidden');
    el.classList.remove('hidden');
    el.innerHTML = mention.items.map((it, i) => `<div class="mi ${i === mention.sel ? 'on' : ''}" data-i="${i}"><span>${esc(it.label)}</span><span class="hint">${esc(it.detail || '')}</span></div>`).join('');
  }
  function closeMention() {
    mention.open = false;
    $('mention').classList.add('hidden');
  }
  function pickMention(it) {
    const end = input.selectionStart;
    input.value = input.value.slice(0, mention.start) + it.insert + input.value.slice(end);
    const pos = mention.start + it.insert.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    closeMention();
  }
  $('mention').addEventListener('mousedown', (e) => {
    const mi = e.target.closest('.mi');
    if (mi) {
      e.preventDefault();
      pickMention(mention.items[Number(mi.dataset.i)]);
    }
  });

  // Images (B5): paste and drop png/jpg/webp ≤ 5 MB.
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  function addImageFile(f) {
    if (!IMAGE_TYPES.includes(f.type)) return add(active, 'notice warn', `${esc(f.name || 'image')}: only png, jpg and webp images can be attached.`);
    if (f.size > 5 * 1024 * 1024) return add(active, 'notice warn', `${esc(f.name || 'image')}: images must be 5 MB or less.`);
    const r = new FileReader();
    r.onload = () => {
      images.push({ name: f.name || `pasted-${images.length + 1}.${f.type.split('/')[1]}`, dataUrl: String(r.result) });
      renderAtts();
    };
    r.readAsDataURL(f);
  }
  function renderAtts() {
    const el = $('atts');
    el.classList.toggle('hidden', !images.length);
    el.innerHTML = images.map((i, k) => `<span class="att"><img src="${esc(i.dataUrl)}" alt=""><span>${esc(i.name)}</span><span class="x" data-k="${k}">×</span></span>`).join('');
  }
  $('atts').addEventListener('click', (e) => {
    const x = e.target.closest('.x');
    if (x) {
      images.splice(Number(x.dataset.k), 1);
      renderAtts();
    }
  });
  input.addEventListener('paste', (e) => {
    for (const it of e.clipboardData?.items || []) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        addImageFile(it.getAsFile());
      }
    }
  });
  app.addEventListener('dragover', (e) => e.preventDefault());
  app.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addImageFile);
  });

  // Log clicks: open files, expand tools, edit-and-resubmit (B7).
  $('logs').addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-act="cfg"]')) return (e.preventDefault(), vscode.postMessage({ type: 'configure' }));
    if (t.closest('[data-act="test"]')) return (e.preventDefault(), vscode.postMessage({ type: 'testConnection' }));
    if (t.matches('code.inline') && /[./]/.test(t.dataset.path || '')) vscode.postMessage({ type: 'openFile', path: t.dataset.path.replace(/:\d+.*$/, '') });
    const th = t.closest('.tool .head');
    if (th) th.parentElement.classList.toggle('open');
    const st = t.closest('.starter');
    if (st) {
      input.value = st.dataset.prompt;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (t.closest('.msg.user .edit')) startEdit(t.closest('.msg.user'));
  });

  $('logs').addEventListener('keydown', (e) => {
    const th = e.target.closest && e.target.closest('.tool .head');
    if (th && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      th.parentElement.classList.toggle('open');
    }
  });

  function startEdit(el) {
    if (el.querySelector('.editbox')) return;
    const box = document.createElement('div');
    box.className = 'editbox';
    box.innerHTML = `<textarea rows="3"></textarea><div class="row"><label class="chk"><input type="checkbox" class="restore"> also restore files to before this message (checkpoint)</label><span class="spacer"></span><button class="secondary cancel">Cancel</button><button class="ok">Resubmit</button></div>`;
    box.querySelector('textarea').value = el.dataset.text || '';
    el.appendChild(box);
    box.querySelector('.cancel').onclick = () => box.remove();
    box.querySelector('.ok').onclick = () => {
      const text = box.querySelector('textarea').value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'editResubmit', chatId: active, uid: el.dataset.uid, text, restoreFiles: box.querySelector('.restore').checked });
      box.remove();
    };
  }

  let todosOpen = true;
  function renderTodos(todos) {
    const el = $('todos');
    if (!todos || !todos.length) return el.classList.add('hidden');
    el.classList.remove('hidden');
    const done = todos.filter((t) => t.status === 'completed').length;
    const now = todos.find((t) => t.status === 'in_progress');
    el.innerHTML = `<details ${todosOpen ? 'open' : ''}><summary><span class="ttl">Tasks</span><span class="prog"><span></span></span><span class="cnt">${done} of ${todos.length}</span>${now && !todosOpen ? `<span class="nowt">${esc(now.content)}</span>` : ''}</summary>` +
      todos.map((t) => `<div class="todo st-${t.status}">${ic(t.status === 'completed' ? 'pass-filled' : t.status === 'in_progress' ? 'circle-filled' : 'circle-large-outline')}<span>${esc(t.content)}</span></div>`).join('') + '</details>';
    el.querySelector('.prog span').style.width = `${Math.round((done / todos.length) * 100)}%`; // CSSOM, not a style attribute (CSP)
    el.querySelector('details').ontoggle = (e) => (todosOpen = e.target.open);
  }

  // Tool calls are one-line rows on the work trail: icon, verb, target; click to see the output.
  const TOOL_ICONS = [[/^read_file|^notebook_read/, 'file'], [/^(list_dir|glob)$/, 'folder-opened'], [/^(grep|web_search|tool_search)$/, 'search'], [/^(edit_file|multi_edit|notebook_edit)$/, 'edit'], [/^write_file$/, 'new-file'], [/^apply_patch$/, 'diff'], [/^bash$/, 'terminal'], [/^web_fetch$/, 'globe'], [/^todo_write$/, 'checklist'], [/^(task|task_result)$/, 'hubot'], [/^load_skill$/, 'mortar-board'], [/^ask_user$/, 'question'], [/^screenshot|^desktop_/, 'device-desktop'], [/^browser_/, 'browser'], [/^code_/, 'symbol-method'], [/^team_|^workflow_/, 'organization'], [/^mcp__/, 'plug'], [/^exit_plan_mode$/, 'list-ordered']];
  function toolHead(name, title) {
    const icon = (TOOL_ICONS.find(([r]) => r.test(name)) || [, 'tools'])[1];
    const t = String(title || name);
    const sp = t.indexOf(' ');
    const verb = sp > 0 ? t.slice(0, sp) : t;
    const rest = sp > 0 ? t.slice(sp + 1) : '';
    const mono = /[./_\-=]/.test(rest) || name === 'bash';
    return `<div class="head" role="button" tabindex="0" title="${esc(t)}">${ic(icon)}<span class="verb">${esc(verb)}</span>${rest ? `<span class="target${mono ? ' mono' : ''}">${esc(rest)}</span>` : ''}<span class="st"></span><span class="chev">${ic('chevron-right')}</span></div><pre class="out"></pre>`;
  }
  function lineDelta(before, after) {
    const a = before ? before.split('\n') : [];
    const b = after.split('\n');
    let s0 = 0;
    while (s0 < a.length && s0 < b.length && a[s0] === b[s0]) s0++;
    let ea = a.length - 1, eb = b.length - 1;
    while (ea >= s0 && eb >= s0 && a[ea] === b[eb]) { ea--; eb--; }
    return { add: Math.max(0, eb - s0 + 1), rem: Math.max(0, ea - s0 + 1) };
  }

  function runStats(st) {
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const secs = st.durationMs / 1000;
    const time = secs >= 60 ? `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s` : `${secs.toFixed(1)} s`;
    return `${n(st.toolCalls, 'tool call', 'tool calls')}, ${n(st.filesChanged.length, 'file changed', 'files changed')}, ${time}${st.costUsd ? `, $${st.costUsd.toFixed(st.costUsd < 0.01 ? 4 : 2)}` : ''}`;
  }

  function permissionCard(msg) {
    const r = msg.request;
    let diff = '';
    if (r.diff) {
      const a = r.diff.before.split('\n');
      const b = r.diff.after.split('\n');
      let s = 0;
      while (s < a.length && s < b.length && a[s] === b[s]) s++;
      let ea = a.length - 1, eb = b.length - 1;
      while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
      const lines = [];
      for (let i = s; i <= ea && lines.length < 60; i++) lines.push(`<div class="del">- ${esc(a[i])}</div>`);
      for (let i = s; i <= eb && lines.length < 120; i++) lines.push(`<div class="ins">+ ${esc(b[i])}</div>`);
      diff = `<div class="diff">${lines.join('')}</div><div class="hint">The full diff is open in the editor.</div>`;
    }
    const d = add(msg.chatId, 'perm', `<div class="ptitle">${ic('shield')}<span>${esc(r.title)}</span></div><div class="psub">Needs your approval${r.reason ? `: ${esc(r.reason)}` : ''}</div>${r.detail && !r.diff ? `<pre class="code"><code>${esc(r.detail)}</code></pre>` : ''}${diff}
      <div class="row acts"><button data-d="allow">Allow</button><button class="secondary" data-d="always" title="${esc(r.suggestedRule ? `Adds the rule ${r.suggestedRule}` : 'Allow this from now on')}">Always allow</button><button class="ghost" data-d="deny">Deny</button></div>
      <input class="fb" placeholder="Or tell the agent what to do instead" aria-label="Instructions instead">`);
    d.dataset.pid = msg.id;
    d.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      const decision = b.dataset.d;
      vscode.postMessage({ type: 'permissionReply', id: msg.id, decision, feedback: d.querySelector('.fb').value || undefined });
      d.querySelector('.fb')?.remove();
      d.classList.add('answered', decision === 'deny' ? 'denied' : 'allowed');
      d.querySelector('.row').innerHTML = `<span class="ans">${ic(decision === 'deny' ? 'circle-slash' : 'check')}${decision === 'deny' ? 'Denied' : decision === 'always' ? 'Always allowed' : 'Allowed'}</span>`;
    }));
  }

  // ------------------------------------------------------------ onboarding card (WS9): mouse-only setup

  const host = (u) => { try { return new URL(u).host; } catch { return u; } };
  function onboardingCard(cid, v) {
    document.querySelectorAll('.msg.onboard').forEach((e) => e.remove());
    if (!v) return;
    let title, body = '';
    if (v.state === 'unreachable') {
      title = `Can't reach ${esc(v.baseUrl)}`;
      body += v.error ? `<div class="hint">${esc(v.error)}</div>` : '';
      body += v.servers.length
        ? `<div class="obh">Local servers found — click one:</div><div class="obl">${v.servers.map((s) => `<button data-ob="useServer" data-url="${esc(s.baseUrl)}" title="${esc(s.baseUrl)}">${esc(s.label)} · ${esc(host(s.baseUrl))}${s.models ? ` · ${s.models.length} model${s.models.length === 1 ? '' : 's'}` : ''}</button>`).join('')}</div>`
        : `<div class="hint">No local server answered on :11434 (Ollama), :1234 (LM Studio) or :8080 (llama.cpp). Start one, then click Retry.</div>`;
    } else {
      title = v.state === 'missingModel' ? `Model <b>${esc(v.model)}</b> isn't installed on ${esc(host(v.baseUrl))}` : v.state === 'noModel' ? 'Pick a model' : `Pick a model on ${esc(host(v.baseUrl))}`;
      body += v.models.length
        ? `<div class="obh">${v.ollama ? 'Tool-capable coder models first' : 'Coder models first'} — click one to use it:</div><div class="obl">${v.models.map((mo) => {
            const tags = [mo.tools === true ? 'tools' : mo.tools === false ? 'no tools' : '', mo.coder ? 'coder' : '', mo.vision ? 'vision' : '', mo.thinking ? 'thinking' : ''].filter(Boolean);
            return `<button class="${mo.tools === false ? 'secondary ' : ''}obm" data-ob="pickModel" data-model="${esc(mo.id)}">${esc(mo.id)}${mo.id === v.model ? ' (current)' : ''}${tags.map((t) => ` <span class="badge">${t}</span>`).join('')}</button>`;
          }).join('')}</div>`
        : `<div class="hint">No chat model is installed${v.ollama ? ' in Ollama. Pull one in a terminal, e.g. <code class="inline">ollama pull qwen2.5-coder:7b</code>, then click Retry' : ''}.</div>`;
      if (v.ollama) body += `<div class="hint">The context window is read from Ollama automatically.</div>`;
    }
    const d = add(cid, 'perm onboard', `<div class="ptitle">${ic('plug')}<span>${title}</span></div>${body}<div class="row"><button class="secondary" data-ob="retry">Retry</button><button class="secondary" data-ob="configure">Other endpoint…</button><span class="spacer"></span><button class="secondary" data-ob="dismiss">Dismiss</button></div><div class="obs hint"></div>`);
    d.dataset.state = v.state;
  }
  // delegated, so the card's buttons work however it was (re)rendered
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('.msg.onboard button[data-ob]');
    if (!b) return;
    const card = b.closest('.msg.onboard');
    const action = b.dataset.ob;
    if (action === 'configure') vscode.postMessage({ type: 'configure' });
    else vscode.postMessage({ type: 'onboard', action, baseUrl: b.dataset.url, model: b.dataset.model });
    if (action === 'pickModel' || action === 'useServer') {
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      card.querySelector('.obs').textContent = action === 'pickModel' ? `Using ${b.dataset.model}… testing the connection` : `Connecting to ${b.dataset.url}…`;
    }
  });

  // ------------------------------------------------------------ pending changes (B2)

  let pendingOpen = true;
  function renderPending(files) {
    const el = $('pending');
    if (!files.length) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    const add_ = files.reduce((n, f) => n + f.added, 0);
    const rem = files.reduce((n, f) => n + f.removed, 0);
    el.innerHTML = `<div class="head"><span class="toggle" role="button" tabindex="0">${ic(pendingOpen ? 'chevron-down' : 'chevron-right')}${files.length === 1 ? '1 file changed' : `${files.length} files changed`} <span class="add">+${add_}</span> <span class="rem">−${rem}</span></span><span class="spacer"></span><button class="secondary" data-a="openAll">Review</button><button class="secondary" data-a="undoAll">Undo all</button><button data-a="keepAll">Keep all</button></div>` +
      (pendingOpen ? files.map((f) => `<div class="pf" data-uri="${esc(f.uri)}">${ic(f.kind === 'inline' ? 'edit' : f.created ? 'new-file' : 'file')}<a href="#" class="name" data-a="diff" title="${esc(f.path)}">${esc(f.rel)}</a>${f.created ? '<span class="hint">new</span>' : ''}<span class="add">+${f.added}</span><span class="rem">−${f.removed}</span><span class="spacer"></span><button class="ib" data-a="undo" title="Undo this file's changes" aria-label="Undo">${ic('discard')}</button><button class="ib" data-a="keep" title="Keep this file's changes" aria-label="Keep">${ic('check')}</button></div>`).join('') : '');
  }
  $('pending').addEventListener('click', (e) => {
    if (e.target.closest('.toggle')) {
      pendingOpen = !pendingOpen;
      return vscode.postMessage({ type: 'review', action: 'list' });
    }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    e.preventDefault();
    vscode.postMessage({ type: 'review', action: a.dataset.a, uri: a.closest('.pf')?.dataset.uri });
  });

  // ------------------------------------------------------------ checkpoints (C1 timeline)

  function renderCheckpoints() {
    const el = $('cpList');
    if (!cpData) return (el.innerHTML = '<p class="hint">Loading…</p>');
    if (cpData.error) return (el.innerHTML = `<p class="hint">${esc(cpData.error)}</p>`);
    if (cpData.disabled) return (el.innerHTML = `<p class="hint">${esc(cpData.disabled)}</p>`);
    const mine = $('cpMine').checked;
    const all = $('cpAll').checked;
    const list = cpData.list.filter((c) => (!mine || c.mine) && (all || c.files > 0 || c.kind !== 'turn'));
    const hidden = cpData.list.filter((c) => (!mine || c.mine)).length - list.length;
    if (!list.length) return (el.innerHTML = `<p class="hint">${hidden ? `No checkpoint changed files yet (${hidden} turn${hidden === 1 ? '' : 's'} hidden).` : 'No checkpoints yet. One is taken before every turn and every shell command.'}</p>`);
    el.innerHTML = list
      .map((c) => `<div class="cp ${esc(c.kind)}" data-id="${esc(c.id)}"><div class="cph">${ic(c.kind === 'pre-restore' ? 'discard' : c.kind === 'turn' ? 'comment' : 'terminal')}<b>${esc(c.label)}</b><span class="spacer"></span><span class="time">${new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div class="hint">${c.files === 1 ? '1 file saved' : `${c.files} files saved`}</div><div class="acts"><a href="#" data-a="diff">Compare with now</a><a href="#" data-a="files">Restore files</a>${c.mine && c.messageIndex !== undefined ? '<a href="#" data-a="both">Restore files and chat</a>' : ''}</div></div>`)
      .join('') + (hidden ? `<p class="hint">${hidden} turn${hidden === 1 ? '' : 's'} without file changes hidden.</p>` : '');
  }
  $('cpMine').onchange = renderCheckpoints;
  $('cpAll').onchange = renderCheckpoints;
  $('cpRefresh').onclick = () => vscode.postMessage({ type: 'checkpoints', action: 'list' });
  $('cpList').addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    e.preventDefault();
    const id = a.closest('.cp').dataset.id;
    if (a.dataset.a === 'diff') vscode.postMessage({ type: 'checkpoints', action: 'diff', id });
    else vscode.postMessage({ type: 'checkpoints', action: 'restore', id, scope: a.dataset.a });
  });

  // ------------------------------------------------------------ MCP & skills (B11)

  function renderManage(m) {
    const el = $('manage');
    const servers = m.servers
      .map((s) => `<div class="card" data-name="${esc(s.name)}"><div class="row"><b>${esc(s.name)}</b><span class="badge ${esc(s.status)}">${esc(s.status)}${s.status === 'connected' ? ` · ${s.tools} tools` : ''}</span><span class="hint">${esc(s.source)} · ${esc(s.transport)}</span><span class="spacer"></span>
        <label class="chk"><input type="checkbox" data-a="toggleServer" ${s.disabled ? '' : 'checked'}> enabled</label>
        <label class="chk" title="Trusted servers' tools run without asking"><input type="checkbox" data-a="trustServer" ${s.trusted ? 'checked' : ''}> trusted</label></div>
        <div class="hint mono">${esc(s.target)}</div>${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}${(s.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
        <div class="row acts">${s.transport === 'http' ? '<a href="#" data-a="oauth">Log in (OAuth)</a><a href="#" data-a="logout">Log out</a>' : ''}${s.source === 'user' ? '<a href="#" data-a="removeServer">Remove</a>' : ''}</div></div>`)
      .join('') || '<p class="hint">No MCP servers configured.</p>';
    const reg = m.registry
      ? m.registry.map((r, i) => `<div class="card"><div class="row"><b>${esc(r.name)}</b><span class="hint">${esc(r.version || '')}</span><span class="spacer"></span>${r.config ? `<button class="secondary" data-reg="${i}">Add</button>` : '<span class="hint">no install info</span>'}</div><div class="hint">${esc(r.description)}</div></div>`).join('') || '<p class="hint">No results.</p>'
      : '';
    const skills = m.skills
      .map((s) => `<div class="card" data-skill="${esc(s.name)}" data-file="${esc(s.file)}"><div class="row"><b>${esc(s.name)}</b><span class="hint">${esc(s.source)}</span><span class="spacer"></span><label class="chk"><input type="checkbox" data-a="toggleSkill" ${s.enabled ? 'checked' : ''}> enabled</label><a href="#" data-a="openSkill">Open</a></div><div class="hint">${esc(s.description)}</div></div>`)
      .join('');
    el.innerHTML = `<h3>MCP servers</h3>${m.trusted ? '' : '<p class="hint">This workspace is not trusted: project servers (.mcp.json, .tugline/config.json) do not start.</p>'}${servers}
      <div class="row"><input id="regq" placeholder="search the MCP registry"><button class="secondary" id="regsearch">Search</button></div><div id="reg">${reg}</div>
      <details><summary>Add a server by hand</summary><div class="row"><input id="addname" placeholder="name"><input id="addcmd" placeholder="command (stdio) or https:// URL" class="grow"><button id="addsrv">Add</button></div></details>
      <h3>Skills</h3>${skills}<div class="row"><button class="secondary" id="newskill">New skill…</button></div>`;
    el.querySelector('#regsearch').onclick = () => vscode.postMessage({ type: 'manage', action: 'searchRegistry', query: el.querySelector('#regq').value });
    el.querySelector('#addsrv').onclick = () => {
      const name = el.querySelector('#addname').value.trim();
      const cmd = el.querySelector('#addcmd').value.trim();
      if (!name || !cmd) return;
      const config = /^https?:\/\//.test(cmd) ? { url: cmd } : { command: cmd.split(/\s+/)[0], args: cmd.split(/\s+/).slice(1) };
      vscode.postMessage({ type: 'manage', action: 'addServer', name, config });
    };
    el.querySelector('#newskill').onclick = () => vscode.postMessage({ type: 'manage', action: 'createSkill' });
    el.querySelectorAll('[data-reg]').forEach((b) => (b.onclick = () => {
      const r = m.registry[Number(b.dataset.reg)];
      vscode.postMessage({ type: 'manage', action: 'addServer', registryName: r.name, config: r.config });
    }));
  }
  $('manage').addEventListener('change', (e) => {
    const a = e.target.dataset.a;
    if (a === 'toggleServer') vscode.postMessage({ type: 'manage', action: a, name: e.target.closest('[data-name]').dataset.name, enabled: e.target.checked });
    if (a === 'trustServer') vscode.postMessage({ type: 'manage', action: a, name: e.target.closest('[data-name]').dataset.name, trusted: e.target.checked });
    if (a === 'toggleSkill') vscode.postMessage({ type: 'manage', action: a, name: e.target.closest('[data-skill]').dataset.skill, enabled: e.target.checked });
  });
  $('manage').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-a]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.a === 'openSkill') vscode.postMessage({ type: 'manage', action: 'openSkill', file: a.closest('[data-file]').dataset.file });
    else vscode.postMessage({ type: 'manage', action: a.dataset.a, name: a.closest('[data-name]')?.dataset.name });
  });

  // ------------------------------------------------------------ settings (B12)

  let settingsScope = 'user';
  let settingsData = null;
  function renderSettings() {
    const s = settingsData;
    const el = $('settings');
    if (!s) return;
    const sc = s[settingsScope];
    const d = sc.data || {};
    const perms = d.permissions || {};
    const hooks = d.hooks || {};
    el.innerHTML = `<div class="row"><b>Settings</b><span class="spacer"></span><select id="scope"><option value="user">User (~/.tugline)</option><option value="project" ${s.hasWorkspace ? '' : 'disabled'}>Project (.tugline)</option></select></div>
      ${settingsScope === 'project' ? `<p class="caveat">${s.trusted ? 'This workspace is trusted: its project config applies in full.' : '⚠ This workspace is not trusted. From project config only deny rules, protected paths and disabled skills take effect; allow rules, modes, hooks and MCP servers are ignored until you trust it.'}</p>` : ''}
      <p class="hint mono">${esc(sc.file || sc.error || '')}</p>
      <label>Default permission mode <select id="pmode"><option value="">(unchanged)</option>${['ask', 'acceptEdits', 'plan', 'auto', 'yolo'].map((m) => `<option ${d.permissionMode === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Protected paths (one glob per line; the agent may never write these)<textarea id="pp" rows="4">${esc((perms.protectedPaths || []).join('\n'))}</textarea></label>
      <div class="row"><button id="savepp">Save protected paths</button></div>
      <label>Allow rules (e.g. <code>bash(npm test)</code>, <code>edit(src/**)</code>)<textarea id="allow" rows="3">${esc((perms.allow || []).join('\n'))}</textarea></label>
      <label>Deny rules<textarea id="deny" rows="3">${esc((perms.deny || []).join('\n'))}</textarea></label>
      <div class="row"><button id="saverules">Save rules</button></div>
      <label>Hooks <select id="hookev">${['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompact', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification'].map((h) => `<option>${h}</option>`).join('')}</select></label>
      <textarea id="hooks" rows="4" class="mono"></textarea>
      <div class="row"><button id="savehooks">Save hooks</button><span class="hint">JSON list: [{"matcher":"bash","command":"./check.sh"}]. Project hooks also need approval (/hooks approve).</span></div>
      <div class="row"><button class="secondary" id="rulesfile">Edit ${settingsScope === 'user' ? '~/.tugline/AGENTS.md' : 'AGENTS.md'} (rules)</button><button class="secondary" id="openfile">Open config file</button><button class="secondary" id="vss">VS Code settings…</button></div>`;
    el.querySelector('#scope').value = settingsScope;
    const hookText = () => JSON.stringify(hooks[el.querySelector('#hookev').value] || [], null, 2);
    el.querySelector('#hooks').value = hookText();
    el.querySelector('#hookev').onchange = () => (el.querySelector('#hooks').value = hookText());
    el.querySelector('#scope').onchange = (e) => { settingsScope = e.target.value; renderSettings(); };
    const lines = (id) => el.querySelector(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    const post = (m) => vscode.postMessage({ type: 'settings', scope: settingsScope, ...m });
    el.querySelector('#pmode').onchange = (e) => e.target.value && post({ action: 'mode', value: e.target.value });
    el.querySelector('#savepp').onclick = () => post({ action: 'protectedPaths', value: lines('#pp') });
    el.querySelector('#saverules').onclick = () => post({ action: 'rules', allow: lines('#allow'), deny: lines('#deny') });
    el.querySelector('#savehooks').onclick = () => {
      try {
        post({ action: 'hooks', event: el.querySelector('#hookev').value, hooks: JSON.parse(el.querySelector('#hooks').value || '[]') });
      } catch (err) {
        add(active, 'error', `Hooks: invalid JSON (${esc(err.message)})`);
      }
    };
    el.querySelector('#rulesfile').onclick = () => post({ action: 'rulesFile' });
    el.querySelector('#openfile').onclick = () => post({ action: 'openFile' });
    el.querySelector('#vss').onclick = () => post({ action: 'vscodeSettings' });
  }

  // ------------------------------------------------------------ messages from the extension

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    const cid = m.chatId || active;
    switch (m.type) {
      case 'focusComposer':
        // v1.2 N45: tugline.focusChat (Cline focusChatInput)
        input.focus();
        break;
      case 'chats': {
        chats = m.list;
        if (state.epoch !== m.epoch) {
          // a new extension session: chats from before a window reload are in History, not here
          state.epoch = m.epoch;
          state.html = {};
          for (const [, p] of per) p.el.remove();
          per.clear();
        }
        for (const c of chats) chatState(c.id);
        for (const id of [...per.keys()]) if (!chats.some((c) => c.id === id)) { per.get(id).el.remove(); per.delete(id); }
        showChat(m.active);
        save();
        break;
      }
      case 'status': {
        if (m.chatId !== active) break;
        const sel = $('model');
        const groups = { profiles: [], models: [] };
        for (const it of m.picker || []) (groups[it.group] || groups.models).push(it);
        sel.innerHTML = `<option value="" title="${esc(m.model)} (from settings)">${esc(shortModel(m.model))}</option>` + (groups.profiles.length ? `<optgroup label="Profiles">${groups.profiles.map((i) => `<option value="${esc(i.value)}">${esc(i.label)}</option>`).join('')}</optgroup>` : '') + (groups.models.length ? `<optgroup label="Endpoint models">${groups.models.map((i) => `<option value="${esc(i.value)}">${esc(i.label)}</option>`).join('')}</optgroup>` : '');
        sel.value = m.choice || '';
        sel.title = `${m.model} @ ${m.baseUrl}`;
        $('effort').value = m.effort || 'default';
        setTimeout(fitChips, 0);
        if (m.mode) {
          $('mode').value = m.mode;
          app.dataset.mode = m.mode;
        }
        chatState(m.chatId).running = !!m.running;
        setRunning(!!m.running);
        break;
      }
      case 'running':
        chatState(cid).running = m.running;
        if (cid === active) setRunning(m.running);
        if (!m.running) save();
        break;
      case 'meter': {
        if (cid !== active) break;
        const v = m.view;
        $('meterFill').style.strokeDashoffset = String(50.27 * (1 - Math.min(100, Math.max(0, v.pct)) / 100)); // r=8 → circumference 50.27
        $('meter').className = `meter ${v.level}`;
        $('meterLabel').textContent = v.window ? v.label : '';
        $('meter').title = v.title;
        $('usage').textContent = v.cost;
        break;
      }
      case 'userMessage': {
        const d = add(cid, 'user', userHtml(m.text));
        d.dataset.uid = m.uid;
        d.dataset.text = m.text;
        endStream(chatState(cid));
        break;
      }
      case 'userIndex': {
        const d = chatState(cid).el.querySelector(`.msg.user[data-uid="${CSS.escape(m.uid)}"]`);
        if (d) {
          d.classList.remove('queued');
          d.querySelector('.qbadge')?.remove();
          d.querySelector('.edit')?.classList.remove('hidden');
        }
        break;
      }
      case 'queued': {
        const d = chatState(cid).el.querySelector(`.msg.user[data-uid="${CSS.escape(m.uid)}"]`);
        if (d) {
          d.classList.add('queued');
          d.insertAdjacentHTML('afterbegin', `<span class="qbadge">${ic('clock')} Queued</span>`);
        }
        break;
      }
      case 'truncated': {
        const p = chatState(cid);
        const d = p.el.querySelector(`.msg.user[data-uid="${CSS.escape(m.uid)}"]`);
        if (d) {
          while (d.nextSibling) d.nextSibling.remove();
          d.remove();
        }
        endStream(p);
        save();
        break;
      }
      case 'history': {
        for (const h of m.messages) {
          if (h.role === 'user') add(cid, 'user resumed', `<div class="utext">${md(h.text.replace(/<(attached_context|ide_context)\b[\s\S]*?<\/\1>/g, '').trim())}</div>`);
          else add(cid, 'assistant', md(h.text));
        }
        add(cid, 'notice', 'Resumed from history. The agent has this conversation in its context.');
        break;
      }
      case 'cleared':
        chatState(cid).el.innerHTML = '';
        chatState(cid).todos = [];
        renderTodos([]);
        endStream(chatState(cid));
        save();
        break;
      case 'error':
        add(cid, 'error', `${ic('error')}<span>${esc(m.message)}</span>`);
        break;
      case 'notice':
        add(cid, `notice ${m.level || ''}`, m.level === 'cmd' ? esc(m.message) : `${ic(m.level === 'error' ? 'error' : m.level === 'warn' ? 'warning' : 'info')}<span>${esc(m.message)}</span>`);
        if (m.level === 'cmd') save();
        break;
      case 'composerInsert': {
        // N24 source mentions, N25 transcripts: insert at the cursor and report the value back to the host
        const t = String(m.text || '');
        const at = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, at);
        const sep = before && !/\s$/.test(before) ? ' ' : '';
        input.value = before + sep + t + input.value.slice(input.selectionEnd ?? at);
        input.selectionStart = input.selectionEnd = (before + sep + t).length;
        input.focus();
        vscode.postMessage({ type: 'composerValue', value: input.value });
        break;
      }
      case 'contextAdded':
        $('ctx').classList.remove('hidden');
        $('ctx').innerHTML = `${ic('pinned')}<span>${m.count === 1 ? '1 snippet' : `${m.count} snippets`} will be attached to your next message</span>`;
        break;
      case 'probe': {
        const r = m.report;
        const yn = (ok, t) => `<span class="${ok ? 'add' : 'rem'}">${ic(ok ? 'check' : 'close')}${t}</span>`;
        add(cid, 'notice probe', `${ic('plug')}<span>Connection test: ${yn(r.chatOk, 'chat')} ${yn(r.nativeTools, 'native tool calls')} ${yn(r.textTools, 'text tool calls')} in ${r.latencyMs ?? '?'} ms${r.errors.length ? '<br>' + esc(r.errors.join(' | ')) : ''}${m.ollama ? '<br>' + esc(m.ollama) : ''}</span>`);
        break;
      }
      case 'onboarding':
        onboardingCard(cid, m.view);
        break;
      case 'permission':
        permissionCard(m);
        break;
      case 'cancelPending': {
        // one card when the host names it (answered from the Agents view); every open card on a stop
        const card = m.id ? document.querySelector(`.msg.perm[data-pid="${CSS.escape(String(m.id))}"]`) : null;
        if (m.id && !card) break;
        const rows = card ? [card.querySelector('.row')] : [...document.querySelectorAll('.msg.perm .row')];
        const d = m.decision;
        rows.forEach((r) => {
          if (!r || !r.querySelector('button')) return;
          const msg = r.closest('.msg');
          msg?.querySelector('.fb')?.remove();
          msg?.classList.add('answered', d === 'deny' ? 'denied' : d ? 'allowed' : 'cancelled');
          r.innerHTML = d ? `<span class="ans">${ic(d === 'deny' ? 'circle-slash' : 'check')}${d === 'deny' ? 'Denied' : d === 'always' ? 'Always allowed' : 'Allowed'} from the Agents view</span>` : `<span class="ans">${ic('circle-slash')}Cancelled</span>`;
        });
        break;
      }
      case 'ask': {
        const d = add(cid, 'perm ask', `<div class="ptitle">${ic('question')}<span>${esc(m.question)}</span></div><div class="row">${(m.options || []).map((o) => `<button class="secondary" data-a="${esc(o)}">${esc(o)}</button>`).join('')}<input class="fb" placeholder="Or type an answer and press Enter"></div>`);
        d.dataset.pid = m.id;
        const reply = (a) => { vscode.postMessage({ type: 'askReply', id: m.id, answer: a }); d.querySelector('.row').innerHTML = `<span class="ans">${ic('reply')}${esc(a)}</span>`; };
        d.querySelectorAll('button').forEach((b) => (b.onclick = () => reply(b.dataset.a)));
        d.querySelector('.fb').addEventListener('keydown', (e) => { if (e.key === 'Enter') reply(e.target.value); });
        break;
      }
      case 'plan': {
        const d = add(cid, 'perm plan', `<div class="ptitle">${ic('list-ordered')}<span>Proposed plan</span></div><div class="plan">${md(m.plan)}</div><div class="row"><button data-ok="1">Approve & implement</button><button class="secondary" data-ok="0">Keep planning</button></div>`);
        d.dataset.pid = m.id;
        d.querySelectorAll('button').forEach((b) => (b.onclick = () => { vscode.postMessage({ type: 'planReply', id: m.id, ok: b.dataset.ok === '1' }); d.querySelector('.row').innerHTML = `<span class="ans">${ic(b.dataset.ok === '1' ? 'check' : 'edit')}${b.dataset.ok === '1' ? 'Approved' : 'Still planning'}</span>`; }));
        break;
      }
      case 'mentionItems':
        if (m.reqId !== mention.req || !mentionToken()) break;
        mention.items = m.items;
        mention.sel = 0;
        mention.open = m.items.length > 0;
        renderMention();
        break;
      case 'pending':
        renderPending(m.files);
        break;
      case 'checkpoints':
        cpData = m;
        renderCheckpoints();
        break;
      case 'manage':
        renderManage(m);
        break;
      case 'settings':
        settingsData = m;
        renderSettings();
        break;
      case 'showView':
        showView(m.view);
        break;
      case 'event':
        onEvent(cid, m.event);
        break;
    }
  });

  function onEvent(cid, e) {
    const p = chatState(cid);
    switch (e.type) {
      case 'reasoning_delta':
        if (!p.reasoningEl) p.reasoningEl = add(cid, 'reasoning', `<details><summary>${ic('lightbulb')}Thinking</summary><div class="rt"></div></details>`);
        p.reasoningEl.querySelector('.rt').textContent += e.text;
        break;
      case 'text_delta':
        if (!p.streamEl) p.streamEl = add(cid, 'assistant', '');
        p.streamText += e.text;
        p.streamEl.innerHTML = md(p.streamText);
        if (cid === active) p.el.scrollTop = p.el.scrollHeight;
        break;
      case 'assistant_message':
        endStream(p);
        save();
        break;
      case 'tool_start': {
        endStream(p);
        const d = add(cid, 'tool running', toolHead(e.name, e.title));
        p.toolEls.set(e.id, d);
        break;
      }
      case 'tool_end': {
        const d = p.toolEls.get(e.id) || add(cid, 'tool', toolHead(e.name, e.name));
        d.classList.remove('running');
        d.classList.add(e.ok ? 'ok' : 'fail');
        const st = d.querySelector('.st');
        const ch = e.meta && typeof e.meta.after === 'string' ? lineDelta(String(e.meta.before || ''), e.meta.after) : null;
        if (st) st.innerHTML = ch ? `<span class="add">+${ch.add}</span> <span class="rem">−${ch.rem}</span>` : e.ok ? '' : '<span class="rem">failed</span>';
        const out = e.output.length > 6000 ? e.output.slice(0, 3000) + '\n…\n' + e.output.slice(-2500) : e.output;
        d.querySelector('.out').textContent = out;
        if (!e.ok) d.classList.add('open');
        break;
      }
      case 'refusal':
        add(cid, 'refusal', `${ic('circle-slash')}<span><b>${esc(e.tool)}</b> was blocked: ${esc(e.reason)}</span>`);
        break;
      case 'todos':
        p.todos = e.todos;
        if (cid === active) renderTodos(e.todos);
        break;
      case 'compaction':
        add(cid, 'notice', `${ic('fold')}<span>Older messages were summarised to free context (about ${Math.round(e.beforeTokens / 1000)}k → ${Math.round(e.afterTokens / 1000)}k tokens).</span>`);
        break;
      case 'subagent':
        add(cid, `tool sub ${e.phase === 'start' ? 'running' : 'ok'}`, `<div class="head">${ic('hubot')}<span class="verb">${e.phase === 'start' ? 'Started' : 'Finished'}</span><span class="target">${esc(e.agentType)}: ${esc(e.description)}</span><span class="st"></span></div>`);
        break;
      case 'notice':
        if (e.level !== 'info') add(cid, 'notice ' + e.level, `${ic(e.level === 'error' ? 'error' : e.level === 'warn' ? 'warning' : 'info')}<span>${esc(e.message)}</span>`);
        break;
      case 'steer':
        // queued prompts are shown as user messages already; steers from other sources get a line
        break;
      case 'checkpoint':
        if (state.view === 'checkpoints') vscode.postMessage({ type: 'checkpoints', action: 'list' });
        break;
      case 'diff_pending':
        break;
      case 'approval_auto':
        add(cid, 'notice auto', `${ic(e.decision === 'allow' ? 'shield' : 'circle-slash')}<span>${e.decision === 'allow' ? 'Allowed' : esc(e.decision)} ${esc(e.tool)} automatically (${esc(e.by)}${e.reason ? `: ${esc(e.reason)}` : ''})</span>`);
        break;
      case 'run_end':
        endStream(p);
        if (e.stopReason === 'llm_unavailable') {
          // the error is already shown above (UI tour: it was printed twice); say what to do instead
          add(cid, 'notice warn', `${ic('warning')}<span>The model endpoint could not be reached. <a href="#" data-act="cfg">Configure endpoint</a> or <a href="#" data-act="test">test the connection</a>.</span>`);
        } else if (e.stopReason !== 'end_turn') add(cid, 'notice warn', `${ic('warning')}<span>Stopped (${esc(e.stopReason)})${e.finalText ? `: ${esc(e.finalText)}` : ''}</span>`);
        // v1.1 R2: whether the work was verified by a trusted check (separate from why the run stopped)
        if (e.badge) add(cid, `completion ${e.badge.cls}`, `${ic(e.badge.cls === 'ok' ? 'pass-filled' : e.badge.cls === 'fail' ? 'error' : 'circle-large-outline')}<span class="verdict" title="${esc(e.badge.title || '')}">${esc(e.badge.label)}</span><span class="why" title="${esc(e.badge.title || '')}">${md(e.badge.why || e.badge.title || '')}</span>`);
        add(cid, 'stats', runStats(e.stats));
        break;
      default:
        break; // UIs ignore event types they do not know (S0.5)
    }
  }

  vscode.postMessage({ type: 'ready' });
})();
