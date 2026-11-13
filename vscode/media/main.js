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
        <button class="ib" id="newchat" title="New chat" aria-label="New chat">${ic('add')}</button>
        <nav class="views" aria-label="Views">
          <button class="ib on" data-view="chat" title="Chat" aria-label="Chat">${ic('comment-discussion')}</button>
          <button class="ib" data-view="checkpoints" title="Checkpoints: rewind files or the chat" aria-label="Checkpoints">${ic('history')}</button>
          <button class="ib" data-view="manage" title="MCP servers and skills" aria-label="MCP servers and skills">${ic('extensions')}</button>
          <button class="ib" data-view="settings" title="Settings: model, API key and rules" aria-label="Settings">${ic('settings-gear')}</button>
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
        <div id="mention" class="mention hidden" role="listbox"></div>
        <div id="ctx" class="ctx hidden"></div>
        <div class="box">
          <div id="atts" class="atts hidden"></div>
          <textarea id="input" rows="2" placeholder="Ask anything, @ to add files, / for commands" title="Enter to send, Shift+Enter for a new line, @ to mention files, / for commands and skills; paste or drop images" aria-label="Message the agent"></textarea>
          <div class="bar">
            <div class="chips">
              <button class="chip" id="addctx" title="Add context: files, problems, terminal output, a URL (@)" aria-label="Add context">${ic('mention')}</button>
              <button class="chip" id="modeBtn" data-menu="mode" aria-haspopup="menu" title="Permission mode: how much the agent may do without asking"><span class="mdot"></span><span class="lbl">Ask first</span>${ic('chevron-down')}</button>
              <button class="chip" id="modelBtn" data-menu="model" aria-haspopup="menu" title="Model for this chat"><span class="lglyph none" aria-hidden="true"><i></i><b></b><i></i></span><span class="lbl"></span>${ic('chevron-down')}</button>
              <button class="chip" id="effortBtn" data-menu="effort" aria-haspopup="menu" title="Reasoning effort (for models that think)">${ic('lightbulb')}<span class="lbl">Auto</span>${ic('chevron-down')}</button>
            </div>
            <div class="acts">
              <button id="mic" class="ib hidden" title="Voice input (push to talk; needs tugline.voice.enabled and a local transcriber)" aria-label="Voice input">${ic('mic')}</button>
              <button id="steer" class="ib hidden" title="Steer: send now; the agent reads it at its next step" aria-label="Steer">${ic('debug-step-into')}</button>
              <button id="stop" class="ib hidden" title="Stop the agent" aria-label="Stop">${ic('debug-stop')}</button>
              <button id="send" class="send" title="Send (Enter)" aria-label="Send">${ic('arrow-up')}</button>
            </div>
          </div>
        </div>
        <div class="under">
          <label class="toggle" title="Attach the file open in the editor (and your selection) to the message"><input type="checkbox" id="incfile" checked><span class="sw"></span>Current file</label>
          <span class="spacer"></span>
          <span id="usage" class="usage"></span>
          <div class="meter" id="meter" title="Context window"><svg viewBox="0 0 20 20" class="ring" aria-hidden="true"><circle cx="10" cy="10" r="8" class="track"></circle><circle cx="10" cy="10" r="8" class="fill" id="meterFill"></circle></svg><span id="meterLabel"></span></div>
        </div>
      </footer>
      <div id="menu" class="menu hidden" role="menu"></div>
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
  let pastes = []; // big pasted text (a log, a stack trace): a chip in the composer, sent with the message
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

  // An empty chat opens on the line to the model (the brand's mark, live): what the agent runs on, and whether it
  // answers. Three starters fill the composer (they never send on their own).
  function emptyHtml() {
    const starters = [
      ['beaker', 'Fix the failing tests', 'Run the tests, find why they fail and fix the code. Do not change the tests.'],
      ['book', 'Explain the current file', 'Explain what the current file does, how it fits into the project, and anything risky in it.'],
      ['list-ordered', 'Plan a change first', 'Make a plan for this change before editing anything: '],
    ];
    return `<div class="empty"><div class="hero"><div class="heroline none" aria-hidden="true"><span class="hend">${ic('code')}</span><span class="rope"><i></i></span><span class="hend far">${ic('server-environment')}</span></div>
      <div class="herocap"><span class="hmodel">No model yet</span><span class="hhost"></span><a href="#" data-act="cfg" class="hchange">Change</a></div></div>
      <h2>What should we work on?</h2>
      <p class="lede">Tugline reads your code, edits files, runs commands in a sandbox and checks its work with your project's tests.</p>
      <div class="starters">${starters.map(([i, t, prompt]) => `<button class="starter" data-prompt="${esc(prompt)}">${ic(i)}<span>${esc(t)}</span></button>`).join('')}</div>
      <p class="hint">Type <kbd>@</kbd> to add files, problems or terminal output, and <kbd>/</kbd> for commands. Select code and press <kbd>Ctrl+Alt+K</kbd> to edit it inline.</p></div>`;
  }
  /** The welcome screen's line: the active connection's model and server, and how its last test went. */
  function renderHero() {
    const act = (picker.connections || []).find((c) => c.active);
    const t = act?.lastTest;
    const st = !act && !picker.model ? 'none' : !t ? 'idle' : !t.ok ? 'fail' : t.tools === 'text' ? 'warn' : 'ok';
    const words = { none: 'Add a connection to start', idle: 'Not tested yet', fail: "Didn't answer the last test", warn: 'Works, with the text tool protocol', ok: 'Connected' };
    document.querySelectorAll('.empty .hero').forEach((h) => {
      h.querySelector('.heroline').className = `heroline ${st}`;
      h.querySelector('.hmodel').textContent = act ? shortModel(act.model) : shortModel(picker.model) || 'No model yet';
      h.querySelector('.hhost').textContent = act ? `${act.name === act.host ? '' : act.name + ', '}${act.host}. ${words[st]}` : words[st];
      const a = h.querySelector('.hchange');
      a.dataset.act = act || picker.model ? 'cfg' : 'add';
      a.textContent = act || picker.model ? 'Change' : 'Add a connection';
    });
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
        html += `<pre class="code"><div class="cbar"><span class="lang">${esc(lang)}</span><button class="ib copy" data-copy title="Copy" aria-label="Copy code">${ic('copy')}</button></div><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
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
    if (v === 'settings') {
      settingsSkeleton();
      vscode.postMessage({ type: 'settings', action: 'load' });
      vscode.postMessage({ type: 'conn', action: 'load' });
    }
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
    const typed = input.value.trim();
    if (!typed && !images.length && !pastes.length) return;
    const text = [typed, ...pastes.map((p) => p.text)].filter(Boolean).join('\n\n');
    const uid = 'w' + Date.now().toString(36) + (uidSeq++).toString(36);
    const d = add(active, 'user', userHtml(typed, images, pastes));
    d.dataset.uid = uid;
    d.dataset.text = text;
    input.value = '';
    input.style.height = 'auto';
    closeMention();
    const imgs = images;
    images = [];
    pastes = [];
    renderAtts();
    endStream(cur());
    vscode.postMessage({ type: 'send', chatId: active, text, includeFile: $('incfile').checked, images: imgs, uid });
  }

  const LONG_LINES = 25;
  const LONG_CHARS = 1500;
  const isLong = (t) => t.length > LONG_CHARS || t.split('\n').length > LONG_LINES;
  const lineCount = (t) => t.split('\n').length;
  /** A long text in the transcript: the first lines, and a button that shows the rest. */
  function longBlock(t, label) {
    const n = lineCount(t);
    return `<div class="longtext"><div class="lthead">${ic('note')}<span>${esc(label || 'Message')} · ${n.toLocaleString()} line${n === 1 ? '' : 's'}</span></div><pre class="lt">${esc(t.length > 200000 ? t.slice(0, 100000) + '\n…\n' + t.slice(-50000) : t)}</pre><button class="linkbtn more" data-more>Show all</button></div>`;
  }
  function userHtml(text, imgs, pasted) {
    const thumbs = (imgs || []).map((i) => `<img class="thumb" src="${esc(i.dataUrl)}" alt="${esc(i.name)}">`).join('');
    const body = text ? (isLong(text) ? longBlock(text) : `<div class="utext">${md(text)}</div>`) : '';
    const blocks = (pasted || []).map((p) => longBlock(p.text, 'Pasted text')).join('');
    return `${body}${blocks}${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}<span class="edit hidden" title="Edit and resubmit" role="button" aria-label="Edit and resubmit">${ic('edit')}</span>`;
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
  // ------------------------------------------------------------ composer menus (mode, model, effort)
  // In-panel menus, not native selects: they look like the rest of the panel and never leave it.
  const MODES = [
    { value: 'ask', label: 'Ask first', icon: 'shield', desc: 'Approve every edit and command' },
    { value: 'acceptEdits', label: 'Accept edits', icon: 'edit', desc: 'Edits apply without asking; commands still ask' },
    { value: 'plan', label: 'Plan', icon: 'list-ordered', desc: 'Read-only until you approve a plan' },
    { value: 'auto', label: 'Auto', icon: 'wand', desc: 'A safety classifier approves routine steps' },
    { value: 'yolo', label: 'YOLO', icon: 'warning', desc: 'No prompts (deny rules, protected files and the sandbox still apply)' },
  ];
  const EFFORTS = [
    { value: 'default', label: 'Auto', desc: "The model's default" },
    { value: 'off', label: 'Off', desc: 'No thinking: fastest' },
    { value: 'low', label: 'Low', desc: 'A little thinking' },
    { value: 'medium', label: 'Medium', desc: 'More thinking' },
    { value: 'high', label: 'High', desc: 'Most thinking: slowest' },
  ];
  const shortModel = (id) => String(id || '').split('/').pop();
  const picker = { model: '', baseUrl: '', choice: '', items: [], effort: 'default', connections: [] };
  function setModeLabel(m) {
    const mo = MODES.find((x) => x.value === m) || MODES[0];
    $('modeBtn').querySelector('.lbl').textContent = mo.label;
    app.dataset.mode = mo.value;
  }
  function setModelLabel() {
    const cur = picker.items.find((i) => i.value === picker.choice);
    $('modelBtn').querySelector('.lbl').textContent = cur ? cur.label : shortModel(picker.model) || 'Choose a model';
    const act = picker.connections.find((c) => c.active);
    const t = act?.lastTest;
    $('modelBtn').querySelector('.lglyph').className = `lglyph ${!t ? 'idle' : !t.ok ? 'fail' : t.tools === 'text' ? 'warn' : 'ok'}`;
    $('modelBtn').title = `Model for this chat: ${picker.model || 'none'}${act ? `, on ${act.name}` : picker.baseUrl ? ` at ${picker.baseUrl}` : ''}. Click to switch the model or the connection.`;
  }
  function setEffortLabel() {
    const e = EFFORTS.find((x) => x.value === picker.effort) || EFFORTS[0];
    // only an icon until an effort is chosen (keeps the chips on one row in a narrow sidebar)
    $('effortBtn').querySelector('.lbl').textContent = e.value === 'default' ? '' : e.label;
    $('effortBtn').classList.toggle('set', e.value !== 'default');
    $('effortBtn').title = `Reasoning effort: ${e.label} (for models that think)`;
  }
  setModeLabel(state.mode);
  setEffortLabel();

  const menu = { el: $('menu'), kind: '', anchor: null, sel: 0, items: [], filter: '' };
  function menuItems(kind) {
    if (kind === 'mode') return MODES.map((m) => ({ ...m, on: m.value === state.mode }));
    if (kind === 'effort') return EFFORTS.map((e) => ({ ...e, on: e.value === picker.effort }));
    const f = menu.filter.toLowerCase();
    const act = picker.connections.find((c) => c.active);
    const here = `Models on ${act ? act.name : 'this server'}`;
    const conns = picker.connections.map((c) => ({ kind: 'conn', value: c.id, label: c.name, desc: `${c.model} on ${c.host}`, provider: c.provider, lastTest: c.lastTest, group: 'Connections', on: c.active }));
    const info = (id) => (picker.items.find((i) => i.value === `model:${id}`) || {}).info;
    const base = [{ value: '', label: shortModel(picker.model) || 'Default model', full: picker.model, desc: "The connection's model", info: info(picker.model), group: here, on: !picker.choice }];
    const models = picker.items.filter((i) => i.group !== 'profiles' && i.value !== `model:${picker.model}`).map((i) => ({ value: i.value, label: i.label, info: i.info, group: here, on: i.value === picker.choice }));
    const profiles = picker.items.filter((i) => i.group === 'profiles').map((i) => ({ value: i.value, label: i.label, desc: 'From your config file', group: 'Config profiles', on: i.value === picker.choice }));
    return [...conns, ...base, ...models, ...profiles].filter((i) => !f || i.label.toLowerCase().includes(f) || String(i.desc || '').toLowerCase().includes(f) || String(i.full || i.value).toLowerCase().includes(f));
  }
  function renderMenu() {
    const kind = menu.kind;
    menu.items = menuItems(kind);
    let group = '';
    const rows = menu.items.map((it, i) => {
      const g = it.group && it.group !== group ? `<div class="mg">${esc((group = it.group))}</div>` : '';
      const lead = it.kind === 'conn' ? mark(it.provider) : it.icon ? ic(it.icon) : '';
      const tail = it.kind === 'conn' ? testDot(it.lastTest) : it.info ? `<span class="mbadges">${it.info.contextWindow ? `<span class="badge">${tok(it.info.contextWindow)}</span>` : ''}${it.info.tools === false ? '<span class="badge warn">no tools</span>' : ''}</span>` : '';
      return `${g}<div class="mi ${it.kind === 'conn' ? 'conn' : ''} ${i === menu.sel ? 'cur' : ''} ${it.on ? 'on' : ''}" role="menuitemradio" aria-checked="${!!it.on}" data-i="${i}" data-value="${esc(it.value)}">${lead}<span class="mt"><span class="ml">${esc(it.label)}</span>${it.desc ? `<span class="md">${esc(it.desc)}</span>` : ''}</span>${tail}${it.on ? ic('check') : ''}</div>`;
    });
    const search = kind === 'model' ? `<div class="msearch">${ic('search')}<input id="menuFilter" placeholder="Search models and connections" value="${esc(menu.filter)}" aria-label="Search models and connections"></div>` : '';
    const foot = kind === 'model' ? `<div class="mfoot"><a href="#" data-act="addconn">${ic('add')}Add a connection</a><a href="#" data-act="settings">${ic('settings-gear')}Manage</a></div>` : '';
    menu.el.innerHTML = `${search}<div class="mlist">${rows.join('') || '<div class="hint mempty">No model matches.</div>'}</div>${foot}`;
    const fi = $('menuFilter');
    if (fi) {
      fi.oninput = () => { menu.filter = fi.value; menu.sel = 0; renderMenu(); };
      fi.onkeydown = menuKey;
      fi.focus();
      fi.setSelectionRange(fi.value.length, fi.value.length);
    }
  }
  function openMenu(kind, anchor) {
    if (menu.kind === kind && !menu.el.classList.contains('hidden')) return closeMenu();
    menu.kind = kind;
    menu.anchor = anchor;
    menu.filter = '';
    menu.items = menuItems(kind);
    menu.sel = Math.max(0, menu.items.findIndex((i) => i.on));
    renderMenu();
    menu.el.classList.remove('hidden');
    anchor.setAttribute('aria-expanded', 'true');
    // above the composer, aligned with the chip (clamped to the panel)
    const r = anchor.getBoundingClientRect();
    const w = Math.min(kind === 'model' ? 340 : 300, window.innerWidth - 16);
    menu.el.style.width = `${w}px`;
    menu.el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    menu.el.style.bottom = `${window.innerHeight - r.top + 6}px`;
    if (kind !== 'model') menu.el.focus();
  }
  function closeMenu() {
    menu.el.classList.add('hidden');
    menu.anchor?.setAttribute('aria-expanded', 'false');
    menu.kind = '';
  }
  function chooseMenu(i) {
    const it = menu.items[i];
    if (!it) return;
    const kind = menu.kind;
    closeMenu();
    if (kind === 'mode') {
      state.mode = it.value;
      setModeLabel(it.value);
      save();
      vscode.postMessage({ type: 'setMode', chatId: active, mode: it.value });
    } else if (kind === 'effort') {
      picker.effort = it.value;
      setEffortLabel();
      vscode.postMessage({ type: 'setEffort', chatId: active, effort: it.value });
    } else if (it.kind === 'conn') {
      if (!it.on) vscode.postMessage({ type: 'conn', action: 'use', id: it.value });
    } else {
      picker.choice = it.value;
      setModelLabel();
      vscode.postMessage({ type: 'setModel', chatId: active, value: it.value });
    }
    input.focus();
  }
  function menuKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      menu.sel = (menu.sel + (e.key === 'ArrowDown' ? 1 : -1) + menu.items.length) % Math.max(1, menu.items.length);
      renderMenu();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseMenu(menu.sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      input.focus();
    }
  }
  menu.el.tabIndex = -1;
  menu.el.addEventListener('keydown', (e) => e.target === menu.el && menuKey(e));
  menu.el.addEventListener('mousedown', (e) => {
    const mi = e.target.closest('.mi');
    if (mi) {
      e.preventDefault();
      chooseMenu(Number(mi.dataset.i));
    }
    const a = e.target.closest('[data-act="settings"], [data-act="addconn"]');
    if (a) {
      e.preventDefault();
      closeMenu();
      openModelSettings(a.dataset.act === 'addconn' ? 'add' : 'connections');
    }
  });
  document.querySelectorAll('.chip[data-menu]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openMenu(b.dataset.menu, b); }));
  document.addEventListener('mousedown', (e) => {
    if (!menu.el.classList.contains('hidden') && !menu.el.contains(e.target) && !e.target.closest('.chip[data-menu]')) closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  $('addctx').onclick = () => {
    const at = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, at);
    const ins = (before && !/\s$/.test(before) ? ' ' : '') + '@';
    input.value = before + ins + input.value.slice(at);
    input.focus();
    input.setSelectionRange(at + ins.length, at + ins.length);
    input.dispatchEvent(new Event('input'));
  };
  $('newchat').onclick = () => vscode.postMessage({ type: 'newChat' });

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
    el.classList.toggle('hidden', !images.length && !pastes.length);
    el.innerHTML =
      pastes.map((p, k) => `<span class="att paste" title="Click to edit it in the message box">${ic('clippy')}<span class="an" data-pe="${k}">Pasted text · ${lineCount(p.text).toLocaleString()} line${lineCount(p.text) === 1 ? '' : 's'}</span><span class="x" data-pk="${k}" title="Remove" aria-label="Remove">${ic('close')}</span></span>`).join('') +
      images.map((i, k) => `<span class="att"><img src="${esc(i.dataUrl)}" alt=""><span class="an">${esc(i.name)}</span><span class="x" data-k="${k}" title="Remove" aria-label="Remove">${ic('close')}</span></span>`).join('');
  }
  $('atts').addEventListener('click', (e) => {
    const xi = e.target.closest('[data-k]');
    if (xi) {
      images.splice(Number(xi.dataset.k), 1);
      return renderAtts();
    }
    const xp = e.target.closest('[data-pk]');
    if (xp) {
      pastes.splice(Number(xp.dataset.pk), 1);
      return renderAtts();
    }
    const pe = e.target.closest('[data-pe]');
    if (pe) {
      // back into the message box, to edit it
      const [p] = pastes.splice(Number(pe.dataset.pe), 1);
      input.value = input.value ? `${input.value}\n\n${p.text}` : p.text;
      renderAtts();
      autosize();
      input.focus();
    }
  });
  input.addEventListener('paste', (e) => {
    for (const it of e.clipboardData?.items || []) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        addImageFile(it.getAsFile());
        return;
      }
    }
    // a big paste (a log, a stack trace) becomes a chip instead of filling the box
    const t = e.clipboardData?.getData('text/plain') || '';
    if (isLong(t)) {
      e.preventDefault();
      pastes.push({ text: t.replace(/\r\n/g, '\n') });
      renderAtts();
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
    if (t.closest('[data-act="cfg"]')) return (e.preventDefault(), openModelSettings('connections'));
    if (t.closest('[data-act="test"]')) return (e.preventDefault(), openModelSettings('test'));
    if (t.closest('[data-act="add"]')) return (e.preventDefault(), openModelSettings('add'));
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
    const more = t.closest('[data-more]');
    if (more) {
      const lt = more.closest('.longtext');
      lt.classList.toggle('open');
      more.textContent = lt.classList.contains('open') ? 'Show less' : 'Show all';
    }
    const cp = t.closest('[data-copy]');
    if (cp) {
      vscode.postMessage({ type: 'copy', text: cp.closest('pre.code').querySelector('code').textContent });
      cp.innerHTML = ic('check');
      setTimeout(() => (cp.innerHTML = ic('copy')), 1200);
    }
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
    const sec = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
    const k = (t) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t));
    let line = `${n(st.toolCalls, 'tool call', 'tool calls')}, ${n(st.filesChanged.length, 'file changed', 'files changed')}, ${sec(st.durationMs)}${st.costUsd ? `, $${st.costUsd.toFixed(st.costUsd < 0.01 ? 4 : 2)}` : ''}`;
    // where the time went: setup on our side, then the model (its first reply is mostly prompt processing)
    const parts = [];
    if (st.setupMs >= 1000) parts.push(`setup ${sec(st.setupMs)}`);
    if (st.firstTokenMs !== undefined) parts.push(`first reply after ${sec(st.firstTokenMs)}`);
    if (st.promptTokens) parts.push(`${k(st.promptTokens)} prompt tokens${st.cachedTokens !== undefined ? (st.cachedTokens ? `, ${k(st.cachedTokens)} cached` : ', none cached') : ''}`);
    if (parts.length) line += ` <span class="tm" title="Setup: Tugline's work before the first model request. First reply: how long the model server took to start answering (mostly reading the prompt; a server that caches prompts answers faster from the second message on). Cached: prompt tokens the server reused from its cache.">· ${esc(parts.join(' · '))}</span>`;
    return line;
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
    if (v.state === 'unreachable' && v.notApi) {
      // the server answered, with a web page: the address of a chat website, not its API
      title = `${esc(host(v.baseUrl))} answered with a web page, not an API`;
      body += v.error ? `<div class="hint">${esc(v.error)}</div>` : '';
      if (v.suggestBaseUrl) body += `<div class="obh">The API is here — click to use it:</div><div class="obl"><button data-ob="useServer" data-url="${esc(v.suggestBaseUrl)}" title="${esc(v.suggestBaseUrl)}">${esc(v.suggestBaseUrl)}</button></div>`;
    } else if (v.state === 'unreachable') {
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
    const d = add(cid, 'perm onboard', `<div class="ptitle">${ic('plug')}<span>${title}</span></div>${body}<div class="row"><button class="secondary" data-ob="retry">Retry</button><button class="secondary" data-ob="configure">Add a connection</button><span class="spacer"></span><button class="secondary" data-ob="dismiss">Dismiss</button></div><div class="obs hint"></div>`);
    d.dataset.state = v.state;
  }
  // delegated, so the card's buttons work however it was (re)rendered
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('.msg.onboard button[data-ob]');
    if (!b) return;
    const card = b.closest('.msg.onboard');
    const action = b.dataset.ob;
    if (action === 'configure') openModelSettings('add');
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
      <h3>Skills</h3>${skills}<div class="row"><button class="secondary" id="newskill">${ic('add')}New skill</button></div>
      <div class="newskill hidden" id="newskillBox"><label for="newskillText">What should the skill teach the agent?</label><textarea id="newskillText" rows="2" placeholder="For example: how we write database migrations in this project"></textarea><div class="row"><button id="newskillGo">Create the skill</button><button class="secondary" id="newskillCancel">Cancel</button></div></div>`;
    el.querySelector('#regsearch').onclick = () => vscode.postMessage({ type: 'manage', action: 'searchRegistry', query: el.querySelector('#regq').value });
    el.querySelector('#addsrv').onclick = () => {
      const name = el.querySelector('#addname').value.trim();
      const cmd = el.querySelector('#addcmd').value.trim();
      if (!name || !cmd) return;
      const config = /^https?:\/\//.test(cmd) ? { url: cmd } : { command: cmd.split(/\s+/)[0], args: cmd.split(/\s+/).slice(1) };
      vscode.postMessage({ type: 'manage', action: 'addServer', name, config });
    };
    el.querySelector('#newskill').onclick = () => {
      el.querySelector('#newskillBox').classList.remove('hidden');
      el.querySelector('#newskillText').focus();
    };
    el.querySelector('#newskillCancel').onclick = () => el.querySelector('#newskillBox').classList.add('hidden');
    el.querySelector('#newskillGo').onclick = () => {
      const text = el.querySelector('#newskillText').value.trim();
      if (!text) return el.querySelector('#newskillText').focus();
      vscode.postMessage({ type: 'manage', action: 'createSkill', text });
      el.querySelector('#newskillBox').classList.add('hidden');
      showView('chat');
    };
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

  // ------------------------------------------------------------ settings: connections, behaviour, safety

  let settingsScope = 'user';
  let settingsData = null;
  const TABS = [
    { id: 'connections', label: 'Connections', icon: 'plug' },
    { id: 'behaviour', label: 'Behaviour', icon: 'settings' },
    { id: 'safety', label: 'Safety', icon: 'shield' },
  ];
  state.stab = 'connections';

  // token sizes offered as one-click choices (the same lists as src/core/llm/modelInfo.ts)
  const CTX_SIZES = [8192, 16384, 32768, 65536, 131072, 200000, 262144, 1048576];
  const OUT_SIZES = [4096, 8192, 16384, 32768, 65536];
  const tok = (n) => (n >= 1000000 ? `${+(n / 1048576).toFixed(n % 1048576 ? 1 : 0)}M` : n >= 1000 ? (n % 1024 === 0 ? `${n / 1024}K` : `${Math.round(n / 1000)}K`) : String(n));
  const STEPS = [
    { id: 'server', label: 'Server' },
    { id: 'model', label: 'Model' },
    { id: 'chat', label: 'Chat' },
    { id: 'tools', label: 'Tools' },
  ];

  // the connection manager's working state survives re-renders (a reload must never wipe what the user typed)
  const conn = { list: [], providers: [], locked: {}, local: null, view: 'list', d: null, models: [], modelsFor: '', modelsReq: 0, modelsLoading: false, modelsErr: '', suggest: '', ollama: false, listOpen: false, test: null, testReq: 0, saving: false, msg: null, loaded: false };

  const provider = (id) => conn.providers.find((p) => p.id === id) || conn.providers.find((p) => p.id === 'custom') || { id: 'custom', name: 'Custom URL', mark: '+', blurb: '' };
  const mark = (pid, big) => `<span class="pmark p-${esc(pid)}${big ? ' big' : ''}" aria-hidden="true">${esc(provider(pid).mark)}</span>`;
  const testDot = (t) => {
    if (!t) return `<span class="tdot none" title="Not tested yet"></span>`;
    const cls = !t.ok ? 'fail' : t.tools === 'text' ? 'warn' : 'ok';
    const when = new Date(t.at).toLocaleString();
    const what = !t.ok ? `Failed: ${t.error || 'no tool calls'}` : t.tools === 'text' ? 'Works (text tool protocol)' : 'Works (native tool calls)';
    return `<span class="tdot ${cls}" title="${esc(`${what}. Tested ${when}`)}"></span>`;
  };

  function settingsSkeleton() {
    const el = $('settings');
    if (el.querySelector('.settings')) return;
    el.innerHTML = `<div class="settings">
      <nav class="stabs" role="tablist" aria-label="Settings">${TABS.map((t) => `<button role="tab" class="stab" data-stab="${t.id}" aria-selected="false">${ic(t.icon)}<span>${t.label}</span></button>`).join('')}</nav>
      <div class="stab-pane" id="stab-connections" role="tabpanel"></div>
      <div class="stab-pane hidden" id="stab-behaviour" role="tabpanel"></div>
      <div class="stab-pane hidden" id="stab-safety" role="tabpanel"></div>
    </div>`;
    el.querySelector('.stabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-stab]');
      if (b) showTab(b.dataset.stab);
    });
    bindConnections(el.querySelector('#stab-connections'));
  }
  function showTab(id) {
    state.stab = id;
    document.querySelectorAll('.stab').forEach((b) => {
      b.classList.toggle('on', b.dataset.stab === id);
      b.setAttribute('aria-selected', String(b.dataset.stab === id));
    });
    for (const t of TABS) $('stab-' + t.id)?.classList.toggle('hidden', t.id !== id);
  }

  /** Open the settings at a connection screen: the list, the gallery, the active one's form, or its test. */
  function openModelSettings(focus) {
    state.connFocus = focus || 'connections';
    showView('settings');
    applyConnFocus();
  }
  function applyConnFocus() {
    const f = state.connFocus;
    if (!f || !conn.loaded) return;
    state.connFocus = '';
    showTab('connections');
    const act = conn.list.find((c) => c.active);
    if (f === 'add') openGallery();
    else if ((f === 'edit' || f === 'test') && act) {
      openForm(act);
      if (f === 'test') runTest();
    } else if (!conn.list.length) openGallery();
    else {
      conn.view = 'list';
      renderConnections();
    }
  }

  // ---- the list

  function renderConnections() {
    const pane = $('stab-connections');
    if (!pane) return;
    // a new screen (list, gallery, form) starts at the top
    if (conn.shown !== conn.view) {
      conn.shown = conn.view;
      $('settings').scrollTop = 0;
    }
    if (conn.view === 'gallery') return renderGallery(pane);
    if (conn.view === 'form') return renderForm(pane);
    const locked = conn.locked || {};
    const rows = conn.list.map((c) => `<li class="crow ${c.active ? 'on' : ''}" data-id="${esc(c.id)}">
        ${mark(c.provider)}
        <div class="cmain"><div class="cname">${esc(c.name)}${testDot(c.lastTest)}</div><div class="cmeta"><span class="mono">${esc(c.model)}</span><span>${esc(c.host)}</span>${c.contextWindow ? `<span>${tok(c.contextWindow)} context</span>` : ''}</div></div>
        <div class="cacts">${c.active ? `<span class="inuse">${lineGlyph('ok')}In use</span>` : `<button class="secondary sm" data-c="use">Use</button>`}
          <button class="ib" data-c="edit" title="Edit" aria-label="Edit ${esc(c.name)}">${ic('edit')}</button>
          <button class="ib" data-c="dup" title="Duplicate" aria-label="Duplicate ${esc(c.name)}">${ic('copy')}</button>
          ${c.active ? '' : `<button class="ib" data-c="del" title="Delete" aria-label="Delete ${esc(c.name)}">${ic('trash')}</button>`}</div>
        <div class="cconfirm hidden">Delete ${esc(c.name)} and its saved key? <button class="danger sm" data-c="delyes">Delete</button><button class="secondary sm" data-c="delno">Keep</button></div>
      </li>`);
    pane.innerHTML = `<div class="phead"><div><h2>Connections</h2><p class="hint">Where your model runs. Switch between them any time from the model button under the message box.</p></div></div>
      ${locked.baseUrl ? `<p class="caveat">${ic('lock')}<span>Your organisation manages the model endpoint${locked.model ? ` (${esc(locked.model)})` : ''}. You can change its key, but not the server.</span></p>` : ''}
      ${conn.msg ? `<p class="${conn.msg.bad ? 'err' : 'okmsg'}">${ic(conn.msg.bad ? 'error' : 'check')}<span>${esc(conn.msg.text)}</span></p>` : ''}
      ${conn.list.length ? `<ul class="clist">${rows.join('')}</ul>` : `<div class="cempty">${lineGlyph('none')}<p>No connection yet. Add one to start: a model on this computer, your company's server, or a hosted API.</p></div>`}
      ${locked.baseUrl ? '' : `<button class="addconn" data-c="add">${ic('add')}<span>Add a connection</span></button>`}`;
  }

  /** The brand's small mark: two nodes on a line, coloured by the connection's state. */
  function lineGlyph(st) {
    return `<span class="lglyph ${st || 'none'}" aria-hidden="true"><i></i><b></b><i></i></span>`;
  }

  // ---- the gallery

  function openGallery() {
    conn.view = 'gallery';
    conn.msg = null;
    renderConnections();
    vscode.postMessage({ type: 'conn', action: 'detect' });
  }
  function renderGallery(pane) {
    const groups = [
      ['local', 'On this computer', 'Free and private: the model runs on your machine.'],
      ['company', 'Your company', 'A server on your network, a chat site or a gateway.'],
      ['hosted', 'Hosted', 'Pay per use with an API key.'],
    ];
    const status = (p) => {
      if (!p.local) return '';
      if (!conn.local) return `<span class="lstat">${ic('loading')}Looking…</span>`;
      const s = conn.local.find((x) => x.kind === p.id);
      return s ? `<span class="lstat on"><span class="live"></span>Running, ${s.models} model${s.models === 1 ? '' : 's'}</span>` : `<span class="lstat">Not running</span>`;
    };
    pane.innerHTML = `<div class="phead"><button class="ib back" data-c="back" title="Back" aria-label="Back">${ic('arrow-left')}</button><div><h2>Add a connection</h2><p class="hint">Pick where the model runs. Everything else is filled in for you.</p></div></div>
      ${groups.map(([g, title, sub]) => `<section class="pgroup"><h3>${title}</h3><p class="hint">${sub}</p><div class="tiles">${conn.providers.filter((p) => p.group === g).map((p) => `<button class="tile" data-p="${esc(p.id)}">${mark(p.id)}<span class="tt"><span class="tn">${esc(p.name)}</span><span class="tb">${esc(p.blurb)}</span>${status(p)}</span></button>`).join('')}</div></section>`).join('')}`;
  }

  // ---- the form

  function draftFrom(c, p) {
    const d = {
      id: c?.id,
      provider: c?.provider || p?.id || 'custom',
      name: c?.name || '',
      baseUrl: c?.baseUrl ?? p?.baseUrl ?? '',
      apiKey: '',
      hasKey: !!c?.hasKey,
      clearKey: false,
      model: c?.model || '',
      ctxPick: 'auto',
      ctxCustom: '',
      outPick: 'auto',
      outCustom: '',
      toolMode: c?.toolMode || 'auto',
      vision: !!c?.vision,
      headers: (c?.headerNames || []).map((n) => ({ name: n, saved: true })),
      headersOpen: !!(c?.headerNames || []).length,
      savedCtx: c?.contextWindow || 0,
      active: !!c?.active,
    };
    if (c?.contextWindow) [d.ctxPick, d.ctxCustom] = CTX_SIZES.includes(c.contextWindow) ? [c.contextWindow, ''] : ['custom', String(c.contextWindow)];
    if (c?.maxOutputTokens) [d.outPick, d.outCustom] = OUT_SIZES.includes(c.maxOutputTokens) ? [c.maxOutputTokens, ''] : ['custom', String(c.maxOutputTokens)];
    return d;
  }
  function openForm(c, p) {
    conn.view = 'form';
    conn.d = draftFrom(c, p);
    conn.models = [];
    conn.modelsFor = '';
    conn.modelsErr = '';
    conn.suggest = '';
    conn.test = null;
    conn.msg = null;
    conn.listOpen = !c && !!conn.d.baseUrl;
    renderConnections();
    if (conn.d.baseUrl) loadModels(false);
  }
  const modelInfo = () => conn.models.find((m) => m.id === conn.d.model);
  /** What Auto means for this model: the size the server reports, Ollama's own, or the default. */
  function autoCtx() {
    const mi = modelInfo();
    if (conn.ollama) return { value: undefined, label: 'Auto', note: 'Ollama reports the size when the model loads; Tugline reads it then.' };
    if (mi && mi.contextWindow) return { value: mi.contextWindow, label: `Auto (${tok(mi.contextWindow)})`, note: `The server reports ${tok(mi.contextWindow)} tokens for this model.` };
    return { value: undefined, label: 'Auto', note: "The server doesn't report it, so Tugline assumes 32K. Pick the size if you know it." };
  }
  function autoOut() {
    const mi = modelInfo();
    if (mi && mi.maxOutput) return { value: mi.maxOutput, label: `Auto (${tok(mi.maxOutput)})` };
    return { value: undefined, label: 'Auto' };
  }
  function draftPayload() {
    const d = conn.d;
    const ctx = d.ctxPick === 'auto' ? autoCtx().value : d.ctxPick === 'custom' ? Number(d.ctxCustom) || undefined : d.ctxPick;
    const out = d.outPick === 'auto' ? autoOut().value : d.outPick === 'custom' ? Number(d.outCustom) || undefined : d.outPick;
    const dr = {
      id: d.id,
      provider: d.provider,
      name: d.name.trim(),
      baseUrl: d.baseUrl.trim(),
      apiKey: d.apiKey || undefined,
      clearKey: d.clearKey || undefined,
      model: d.model.trim(),
      contextWindow: ctx,
      maxOutputTokens: out,
      toolMode: d.toolMode,
      vision: d.vision,
      headers: d.headers.filter((h) => h.name.trim()).map((h) => (h.value === undefined || (h.saved && h.value === '') ? { name: h.name.trim() } : { name: h.name.trim(), value: h.value })),
    };
    for (const k of Object.keys(dr)) if (dr[k] === undefined) delete dr[k];
    return dr;
  }

  function renderForm(pane) {
    const d = conn.d;
    const p = provider(d.provider);
    const locked = conn.locked || {};
    const lockUrl = !!locked.baseUrl;
    const keyPh = d.hasKey && !d.clearKey ? 'Saved. Type to replace it' : p.needsKey ? 'Paste your API key' : 'Leave empty if the server needs none';
    pane.innerHTML = `<div class="phead"><button class="ib back" data-c="back" title="Back" aria-label="Back">${ic('arrow-left')}</button>${mark(d.provider, true)}<div><h2>${d.id ? esc(d.name || p.name) : esc(p.name)}</h2><p class="hint">${d.id ? (d.active ? 'In use now. Changes apply from the next message.' : 'Saved connection') : esc(p.blurb)}</p></div></div>
      <div class="cform">
        <div class="field"><label for="cfUrl">Base URL</label><input id="cfUrl" spellcheck="false" autocomplete="off" placeholder="${esc(p.placeholder || p.baseUrl || 'https://ai.example.com/v1')}" value="${esc(d.baseUrl)}" ${lockUrl ? 'disabled' : ''}><span class="hint">${esc(p.note || 'The OpenAI-compatible API address, usually ending in /v1.')}</span><div id="cfSuggest"></div></div>
        <div class="field"><label for="cfKey">API key${p.needsKey ? '' : ' <span class="opt">optional</span>'}</label><div class="pw"><input id="cfKey" type="password" spellcheck="false" autocomplete="off" placeholder="${esc(keyPh)}" value="${esc(d.apiKey)}"><button class="ib" id="cfKeyShow" title="Show or hide the key" aria-label="Show or hide the key">${ic('eye')}</button></div>
          <span class="hint">Kept in VS Code's secret storage and sent only to this server.${p.keyUrl ? ` <a href="${esc(p.keyUrl)}">Get a key</a>` : ''}${d.hasKey && !d.clearKey ? ' <button class="linkbtn" data-c="clearkey">Remove the saved key</button>' : ''}${d.clearKey ? ' The saved key will be removed when you save. <button class="linkbtn" data-c="keepkey">Keep it</button>' : ''}</span></div>
        <div class="field"><label for="cfModel">Model</label>
          <div class="combo"><span class="cicon">${ic('search')}</span><input id="cfModel" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="${conn.listOpen}" aria-controls="cfModels" placeholder="${d.baseUrl ? 'Search the server’s models or type a name' : 'Enter the base URL first'}" value="${esc(d.model)}" ${locked.model ? 'disabled' : ''}><button class="ib" data-c="reload" title="Load the models again" aria-label="Load the models again">${ic('refresh')}</button></div>
          <div id="cfModels"></div></div>
        <div class="field"><label>Context window</label><div class="chips2" id="cfCtx"></div><span class="hint" id="cfCtxNote"></span></div>
        <details class="fmore" ${d.moreOpen ? 'open' : ''}><summary>${ic('chevron-right')}More options<span class="hint" id="cfMoreSum"></span></summary>
          <div class="field"><label>Longest reply</label><div class="chips2" id="cfOut"></div><span class="hint">Tokens the model may write in one reply. Larger allows bigger edits.</span></div>
          <div class="field"><label>Tool calling</label><div class="seg" id="cfTool">${[['auto', 'Auto'], ['native', 'Native'], ['text', 'Text']].map(([v, l]) => `<button class="${d.toolMode === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div><span class="hint">Auto uses native tool calls and switches to a text protocol when the server rejects them.</span></div>
          <label class="toggle"><input type="checkbox" id="cfVision" ${d.vision ? 'checked' : ''}><span class="sw"></span>The model reads images (screenshots are shown to it)</label>
          <div class="field"><label>Custom headers</label><div id="cfHeaders"></div><button class="linkbtn addh" data-c="addh">${ic('add')}Add a header</button><span class="hint">For gateways that want a team or project ID. Values are kept with the key, in secret storage.</span></div>
          <div class="field"><label for="cfName">Name</label><input id="cfName" spellcheck="false" placeholder="${esc(p.baseUrl ? p.name : 'Shown in the model menu')}" value="${esc(d.name)}"></div>
        </details>
        <div class="tline" id="cfTest"></div>
        <div id="cfMsg"></div>
        <div class="formacts"><button class="secondary" data-c="test">${ic('pulse')}Test</button><span class="spacer"></span>
          ${d.active ? `<button data-c="save" ${conn.saving ? 'disabled' : ''}>${ic('check')}Save</button>` : `${d.id ? `<button class="secondary" data-c="save" ${conn.saving ? 'disabled' : ''}>Save</button>` : ''}<button data-c="saveuse" ${conn.saving ? 'disabled' : ''}>${ic('check')}${d.id ? 'Save and use' : 'Add and use'}</button>`}</div>
      </div>`;
    renderModelList();
    renderSizes();
    renderHeaders();
    renderTest();
    renderSuggest();
    renderFormMsg();
  }

  function renderSuggest() {
    const el = $('cfSuggest');
    if (!el) return;
    el.innerHTML = conn.suggest ? `<button class="suggest" data-c="usesuggest">${ic('lightbulb')}<span>The API is at <b>${esc(conn.suggest)}</b>. Use it</span></button>` : '';
  }
  function renderFormMsg() {
    const el = $('cfMsg');
    if (!el) return;
    el.innerHTML = conn.msg ? `<p class="${conn.msg.bad ? 'err' : 'okmsg'}">${ic(conn.msg.bad ? 'error' : 'info')}<span>${esc(conn.msg.text)}</span></p>` : '';
  }

  function sortModels(list) {
    const rank = (m) => (m.tools === false ? 2 : 0) + (m.coder ? 0 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }
  function renderModelList() {
    const el = $('cfModels');
    if (!el) return;
    const d = conn.d;
    if (conn.modelsLoading) return (el.innerHTML = `<div class="mstate">${ic('loading')}Loading the server's models…</div>`);
    if (conn.modelsErr) return (el.innerHTML = `<div class="mstate bad">${ic('error')}<span>${esc(conn.modelsErr)}</span></div>`);
    const mi = modelInfo();
    const chosen = d.model && !conn.listOpen ? `<div class="mchosen">${mi ? modelBadges(mi) : conn.models.length ? '<span class="badge warn">not in the server’s list</span>' : ''}</div>` : '';
    if (!conn.listOpen || !conn.models.length) return (el.innerHTML = chosen + (conn.models.length && !d.model ? `<div class="mstate">${conn.models.length} models on this server. Click the box to choose.</div>` : ''));
    const f = d.typing ? d.model.trim().toLowerCase() : '';
    const list = sortModels(conn.models).filter((m) => !f || m.id.toLowerCase().includes(f));
    el.innerHTML = `<div class="mpick" id="cfList" role="listbox">${list.slice(0, 300).map((m) => `<div class="mo ${m.id === d.model ? 'on' : ''}" role="option" aria-selected="${m.id === d.model}" data-model="${esc(m.id)}"><span class="mid">${esc(m.id)}</span>${modelBadges(m)}</div>`).join('') || `<div class="mstate">No model matches. Press Enter to use “${esc(d.model)}”.</div>`}</div><div class="mcount hint">${list.length} of ${conn.models.length} models</div>`;
  }
  function modelBadges(m) {
    return [m.contextWindow ? `<span class="badge">${tok(m.contextWindow)}</span>` : '', m.tools === true ? '<span class="badge good">tools</span>' : m.tools === false ? '<span class="badge warn">no tools</span>' : '', m.vision ? '<span class="badge">images</span>' : '', m.coder ? '<span class="badge">coder</span>' : ''].join('');
  }

  function renderSizes() {
    const d = conn.d;
    const ctx = $('cfCtx');
    if (!ctx) return;
    const a = autoCtx();
    ctx.innerHTML = [`<button class="${d.ctxPick === 'auto' ? 'on' : ''}" data-ctx="auto">${esc(a.label)}</button>`, ...CTX_SIZES.map((n) => `<button class="${d.ctxPick === n ? 'on' : ''}" data-ctx="${n}">${tok(n)}</button>`), `<button class="${d.ctxPick === 'custom' ? 'on' : ''}" data-ctx="custom">Custom</button>`].join('') +
      (d.ctxPick === 'custom' ? `<span class="custom"><input id="cfCtxCustom" type="number" min="1024" step="1024" placeholder="e.g. 98304" value="${esc(d.ctxCustom)}" aria-label="Context window in tokens"><span class="hint">tokens</span></span>` : '');
    $('cfCtxNote').textContent = d.ctxPick === 'auto' ? a.note : 'The most the model can read at once: your files, the conversation and tool results. Tugline summarises older messages before it fills up.';
    const o = autoOut();
    $('cfOut').innerHTML = [`<button class="${d.outPick === 'auto' ? 'on' : ''}" data-out="auto">${esc(o.label)}</button>`, ...OUT_SIZES.map((n) => `<button class="${d.outPick === n ? 'on' : ''}" data-out="${n}">${tok(n)}</button>`), `<button class="${d.outPick === 'custom' ? 'on' : ''}" data-out="custom">Custom</button>`].join('') +
      (d.outPick === 'custom' ? `<span class="custom"><input id="cfOutCustom" type="number" min="256" step="256" placeholder="e.g. 12000" value="${esc(d.outCustom)}" aria-label="Longest reply in tokens"><span class="hint">tokens</span></span>` : '');
    const sum = [d.outPick !== 'auto' ? `reply ${d.outPick === 'custom' ? tok(Number(d.outCustom) || 0) : tok(d.outPick)}` : '', d.toolMode !== 'auto' ? `${d.toolMode} tools` : '', d.vision ? 'images' : '', d.headers.length ? `${d.headers.length} header${d.headers.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    $('cfMoreSum').textContent = sum;
  }

  function renderHeaders() {
    const el = $('cfHeaders');
    if (!el) return;
    el.innerHTML = conn.d.headers.map((h, i) => `<div class="hrow" data-h="${i}"><input class="hn" placeholder="Header name" spellcheck="false" value="${esc(h.name)}" aria-label="Header name"><input class="hv" type="password" placeholder="${h.saved ? 'Saved. Type to replace' : 'Value'}" spellcheck="false" autocomplete="off" value="${esc(h.value || '')}" aria-label="Header value"><button class="ib" data-c="rmh" title="Remove" aria-label="Remove header">${ic('close')}</button></div>`).join('');
  }

  // ---- the test line: the editor at one end, the model at the other, a node for each step in between

  function renderTest() {
    const el = $('cfTest');
    if (!el) return;
    const t = conn.test;
    if (!t) return (el.innerHTML = '', el.className = 'tline');
    const st = (id) => t.steps[id] || {};
    const failed = STEPS.find((s) => st(s.id).state === 'fail');
    el.className = `tline ${t.done ? (t.ok ? 'ok' : 'fail') : 'run'}`;
    el.innerHTML = `<div class="track" role="img" aria-label="${esc(t.done ? (t.ok ? 'Connection works' : 'Connection failed') : 'Testing the connection')}">
        <span class="end">${ic('vm')}</span>${STEPS.map((s) => `<span class="seg2 ${st(s.id).state || ''}"></span><span class="node ${st(s.id).state || ''}" title="${esc(s.label)}"></span>`).join('')}
      </div>
      <div class="tlabels">${STEPS.map((s) => `<span class="${st(s.id).state || ''}">${s.label}</span>`).join('')}</div>
      <ul class="tsteps">${STEPS.filter((s) => st(s.id).detail).map((s) => `<li class="${st(s.id).state}">${ic(st(s.id).state === 'ok' ? 'pass-filled' : st(s.id).state === 'warn' ? 'warning' : st(s.id).state === 'fail' ? 'error' : 'circle-large-outline')}<span>${esc(st(s.id).detail)}</span></li>`).join('')}</ul>
      ${t.suggest ? `<button class="suggest" data-c="usesuggest">${ic('lightbulb')}<span>The API is at <b>${esc(t.suggest)}</b>. Use it</span></button>` : ''}
      ${t.done && t.ok ? `<p class="tdone">${t.tools === 'text' ? 'Ready. This model has no native tool calls, so Tugline uses its text protocol: it works, a little slower.' : 'Ready to use.'}</p>` : ''}
      ${t.done && !t.ok && failed ? `<p class="tdone bad">Fix the ${failed.label.toLowerCase()} step above, then test again.</p>` : ''}`;
  }
  function runTest() {
    const p = draftPayload();
    conn.testReq++;
    conn.test = { req: conn.testReq, steps: {}, done: false, ok: false };
    renderTest();
    $('stab-connections')?.querySelector('.formacts')?.scrollIntoView({ block: 'nearest' });
    vscode.postMessage({ type: 'conn', action: 'test', reqId: conn.testReq, draft: p });
  }

  function loadModels(force) {
    const d = conn.d;
    const url = d.baseUrl.trim();
    if (!/^https?:\/\/\S+$/.test(url)) {
      conn.models = [];
      conn.modelsErr = '';
      return renderModelList();
    }
    const k = url + '|' + d.apiKey + '|' + d.headers.map((h) => `${h.name}=${h.value || ''}`).join(',');
    if (!force && conn.modelsFor === k) return;
    conn.modelsFor = k;
    conn.modelsLoading = true;
    conn.modelsErr = '';
    conn.suggest = '';
    conn.modelsReq++;
    vscode.postMessage({ type: 'conn', action: 'models', reqId: conn.modelsReq, draft: draftPayload() });
    renderModelList();
    renderSuggest();
  }

  function saveConn(use) {
    const p = draftPayload();
    if (!/^https?:\/\/\S+$/.test(p.baseUrl)) return formError('Enter the base URL, starting with http:// or https://.', '#cfUrl');
    if (!p.model) return formError('Choose a model, or type its name.', '#cfModel');
    conn.saving = true;
    conn.msg = null;
    renderFormMsg();
    $('stab-connections').querySelectorAll('.formacts button').forEach((b) => (b.disabled = true));
    vscode.postMessage({ type: 'conn', action: 'save', draft: p, use });
  }
  function formError(text, focus) {
    conn.msg = { bad: true, text };
    renderFormMsg();
    if (focus) $('stab-connections').querySelector(focus)?.focus();
  }

  function bindConnections(pane) {
    let urlTimer;
    pane.addEventListener('input', (e) => {
      const t = e.target;
      const d = conn.d;
      if (!d) return;
      if (t.id === 'cfUrl') {
        d.baseUrl = t.value;
        $('cfModel')?.setAttribute('placeholder', /^https?:\/\/\S+$/.test(d.baseUrl.trim()) ? 'Search the server\u2019s models or type a name' : 'Enter the base URL first');
        clearTimeout(urlTimer);
        urlTimer = setTimeout(() => loadModels(false), 700);
      } else if (t.id === 'cfKey') d.apiKey = t.value;
      else if (t.id === 'cfName') d.name = t.value;
      else if (t.id === 'cfModel') {
        d.model = t.value;
        d.typing = true;
        conn.listOpen = true;
        renderModelList();
      } else if (t.id === 'cfCtxCustom') d.ctxCustom = t.value;
      else if (t.id === 'cfOutCustom') d.outCustom = t.value;
      else if (t.classList.contains('hn') || t.classList.contains('hv')) {
        const h = d.headers[Number(t.closest('.hrow').dataset.h)];
        if (t.classList.contains('hn')) h.name = t.value;
        else h.value = t.value;
      }
    });
    pane.addEventListener('change', (e) => {
      const t = e.target;
      if (!conn.d) return;
      if (t.id === 'cfKey' || t.classList.contains('hv')) loadModels(false);
      if (t.id === 'cfVision') {
        conn.d.vision = t.checked;
        renderSizes();
      }
      if (t.id === 'cfOutCustom') renderSizes();
    });
    pane.addEventListener('focusin', (e) => {
      if (e.target.id === 'cfModel' && conn.d && !conn.listOpen) {
        conn.listOpen = true;
        conn.d.typing = false;
        loadModels(false);
        renderModelList();
      }
    });
    pane.addEventListener('keydown', (e) => {
      if (e.target.id !== 'cfModel') return;
      const opts = [...pane.querySelectorAll('#cfList .mo')];
      const i = opts.findIndex((o) => o.classList.contains('cur'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = opts.length ? (i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length : -1;
        opts.forEach((o, k) => o.classList.toggle('cur', k === n));
        opts[n]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pickModel(i >= 0 ? opts[i].dataset.model : conn.d.model.trim());
      } else if (e.key === 'Escape') {
        conn.listOpen = false;
        renderModelList();
      }
    });
    pane.addEventListener('focusout', (e) => {
      // close the list when focus leaves the model box (a click on an option is a mousedown first)
      if (e.target.id === 'cfModel') setTimeout(() => { if (conn.d && document.activeElement?.id !== 'cfModel' && conn.listOpen) { conn.listOpen = false; renderModelList(); renderSizes(); } }, 150);
    });
    pane.addEventListener('mousedown', (e) => {
      const mo = e.target.closest('#cfList .mo');
      if (mo) {
        e.preventDefault();
        pickModel(mo.dataset.model);
      }
    });
    pane.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile[data-p]');
      if (tile) return openForm(null, provider(tile.dataset.p));
      const ctxb = e.target.closest('[data-ctx]');
      if (ctxb) {
        const v = ctxb.dataset.ctx;
        conn.d.ctxPick = v === 'auto' || v === 'custom' ? v : Number(v);
        renderSizes();
        if (v === 'custom') $('cfCtxCustom')?.focus();
        return;
      }
      const outb = e.target.closest('[data-out]');
      if (outb) {
        const v = outb.dataset.out;
        conn.d.outPick = v === 'auto' || v === 'custom' ? v : Number(v);
        renderSizes();
        if (v === 'custom') $('cfOutCustom')?.focus();
        return;
      }
      const tool = e.target.closest('#cfTool button');
      if (tool) {
        conn.d.toolMode = tool.dataset.v;
        pane.querySelectorAll('#cfTool button').forEach((x) => x.classList.toggle('on', x === tool));
        return renderSizes();
      }
      const b = e.target.closest('[data-c]');
      if (!b) return;
      const row = b.closest('.crow');
      const id = row?.dataset.id;
      const c = conn.list.find((x) => x.id === id);
      switch (b.dataset.c) {
        case 'add':
          return openGallery();
        case 'back':
          conn.view = conn.view === 'form' && !conn.d?.id ? 'gallery' : 'list';
          conn.msg = null;
          return renderConnections();
        case 'use':
          b.disabled = true;
          return vscode.postMessage({ type: 'conn', action: 'use', id });
        case 'edit':
          return openForm(c);
        case 'dup':
          return vscode.postMessage({ type: 'conn', action: 'duplicate', id });
        case 'del':
          return row.querySelector('.cconfirm').classList.remove('hidden');
        case 'delno':
          return row.querySelector('.cconfirm').classList.add('hidden');
        case 'delyes':
          return vscode.postMessage({ type: 'conn', action: 'delete', id });
        case 'clearkey':
          conn.d.clearKey = true;
          conn.d.apiKey = '';
          return renderForm(pane);
        case 'keepkey':
          conn.d.clearKey = false;
          return renderForm(pane);
        case 'reload':
          return loadModels(true);
        case 'usesuggest': {
          const u = conn.suggest || conn.test?.suggest;
          if (!u) return;
          conn.d.baseUrl = u;
          conn.suggest = '';
          conn.test = null;
          pane.querySelector('#cfUrl').value = u;
          renderTest();
          return loadModels(true);
        }
        case 'addh':
          conn.d.headers.push({ name: '', value: '' });
          renderHeaders();
          renderSizes();
          return pane.querySelector('.hrow:last-child .hn')?.focus();
        case 'rmh':
          conn.d.headers.splice(Number(b.closest('.hrow').dataset.h), 1);
          renderHeaders();
          return renderSizes();
        case 'test':
          return runTest();
        case 'save':
          return saveConn(false);
        case 'saveuse':
          return saveConn(true);
      }
    });
    pane.addEventListener('toggle', (e) => {
      if (e.target.classList?.contains('fmore') && conn.d) conn.d.moreOpen = e.target.open;
    }, true);
    pane.addEventListener('click', (e) => {
      if (e.target.id === 'cfKeyShow' || e.target.closest('#cfKeyShow')) {
        const k = pane.querySelector('#cfKey');
        k.type = k.type === 'password' ? 'text' : 'password';
      }
    });
  }
  function pickModel(id) {
    if (!id || !conn.d) return;
    conn.d.model = id;
    conn.d.typing = false;
    conn.listOpen = false;
    const input = $('cfModel');
    if (input) input.value = id;
    // a size the user picked stays; Auto follows the new model
    renderModelList();
    renderSizes();
    if (!conn.d.name && conn.d.provider === 'custom') $('cfName')?.setAttribute('placeholder', id);
  }

  // ---- behaviour and safety

  function renderSettings() {
    settingsSkeleton();
    showTab(state.stab);
    const s = settingsData;
    if (!s) return;
    const pr = s.prefs || {};
    const beh = $('stab-behaviour');
    beh.innerHTML = `<div class="phead"><div><h2>Behaviour</h2><p class="hint">How much the agent may do without asking, for new chats. Each chat can change it from the message box.</p></div></div>
      <div class="modes" role="radiogroup" aria-label="Default permission mode">${MODES.map((m) => `<label class="moderow ${pr.permissionMode === m.value ? 'on' : ''} m-${m.value}"><input type="radio" name="pfMode" value="${m.value}" ${pr.permissionMode === m.value ? 'checked' : ''}><span class="mdot"></span><span class="mtx"><b>${esc(m.label)}</b><span class="hint">${esc(m.desc)}</span></span></label>`).join('')}</div>
      <div class="toggles"><label class="toggle"><input type="checkbox" id="pfNotify" ${pr.notifications !== false ? 'checked' : ''}><span class="sw"></span>Notify me when a long task finishes</label>
      <label class="toggle"><input type="checkbox" id="pfTerminal" ${pr.visibleTerminal ? 'checked' : ''}><span class="sw"></span>Run commands in a visible terminal</label></div>
      <div class="row links"><a href="#" data-sl="vss">${ic('settings')}All VS Code settings for Tugline</a></div>`;
    beh.querySelectorAll('input[name="pfMode"]').forEach((r) => (r.onchange = () => {
      vscode.postMessage({ type: 'settings', action: 'pref', key: 'permissionMode', value: r.value });
      beh.querySelectorAll('.moderow').forEach((x) => x.classList.toggle('on', x.querySelector('input').checked));
    }));
    beh.querySelector('#pfNotify').onchange = (ev) => vscode.postMessage({ type: 'settings', action: 'pref', key: 'notifications', value: ev.target.checked });
    beh.querySelector('#pfTerminal').onchange = (ev) => vscode.postMessage({ type: 'settings', action: 'pref', key: 'visibleTerminal', value: ev.target.checked });
    beh.querySelector('[data-sl="vss"]').onclick = (ev) => (ev.preventDefault(), vscode.postMessage({ type: 'settings', action: 'vscodeSettings', scope: settingsScope }));

    const sc = s[settingsScope];
    const d = sc.data || {};
    const perms = d.permissions || {};
    const hooks = d.hooks || {};
    const saf = $('stab-safety');
    saf.innerHTML = `<div class="phead"><div><h2>Safety</h2><p class="hint">Files the agent must never change, commands it may or may not run, and hooks. Deny rules and protected files apply in every mode.</p></div></div>
      <div class="seg scope" id="scopeSeg"><button data-scope="user" class="${settingsScope === 'user' ? 'on' : ''}">For you</button><button data-scope="project" class="${settingsScope === 'project' ? 'on' : ''}" ${s.hasWorkspace ? '' : 'disabled'}>For this project</button></div>
      ${settingsScope === 'project' ? `<p class="caveat">${ic('info')}<span>${s.trusted ? 'This workspace is trusted: its project config applies in full.' : 'This workspace is not trusted. From project config only deny rules, protected paths and disabled skills take effect; allow rules, modes, hooks and MCP servers are ignored until you trust it.'}</span></p>` : ''}
      <p class="hint mono">${esc(sc.file || sc.error || '')}</p>
      <div class="field"><label for="pp">Protected paths</label><textarea id="pp" rows="3" spellcheck="false" placeholder=".env&#10;secrets/**">${esc((perms.protectedPaths || []).join('\n'))}</textarea><span class="hint">One glob per line. The agent can never write these.</span></div>
      <div class="row"><button class="secondary sm" id="savepp">Save protected paths</button></div>
      <div class="field"><label for="allow">Allow rules</label><textarea id="allow" rows="3" spellcheck="false" placeholder="bash(npm test)&#10;edit(src/**)">${esc((perms.allow || []).join('\n'))}</textarea></div>
      <div class="field"><label for="deny">Deny rules</label><textarea id="deny" rows="3" spellcheck="false" placeholder="bash(git push*)">${esc((perms.deny || []).join('\n'))}</textarea></div>
      <div class="row"><button class="secondary sm" id="saverules">Save rules</button></div>
      <details class="fmore" ${state.hooksOpen ? 'open' : ''} id="hooksBox"><summary>${ic('chevron-right')}Hooks</summary>
        <div class="field"><label for="hookev">When</label><select id="hookev">${['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompact', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification'].map((h) => `<option>${h}</option>`).join('')}</select><textarea id="hooks" rows="4" class="mono" spellcheck="false"></textarea><span class="hint">A JSON list, such as [{"matcher":"bash","command":"./check.sh"}]. Project hooks also need approval (/hooks approve).</span></div>
        <div class="row"><button class="secondary sm" id="savehooks">Save hooks</button></div></details>
      <div class="row links"><a href="#" id="rulesfile">${ic('book')}Edit ${settingsScope === 'user' ? '~/.tugline/AGENTS.md' : 'AGENTS.md'} (instructions)</a><a href="#" id="openfile">${ic('json')}Open the config file</a></div>`;
    saf.querySelector('#hooksBox').ontoggle = (ev) => (state.hooksOpen = ev.target.open);
    saf.querySelectorAll('#scopeSeg button').forEach((b) => (b.onclick = () => { settingsScope = b.dataset.scope; renderSettings(); }));
    const hookText = () => JSON.stringify(hooks[saf.querySelector('#hookev').value] || [], null, 2);
    saf.querySelector('#hooks').value = hookText();
    saf.querySelector('#hookev').onchange = () => (saf.querySelector('#hooks').value = hookText());
    const lines = (id) => saf.querySelector(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    const post = (m) => vscode.postMessage({ type: 'settings', scope: settingsScope, ...m });
    const saved = (b) => { const t = b.innerHTML; b.innerHTML = `${ic('check')}Saved`; setTimeout(() => (b.innerHTML = t), 1400); };
    saf.querySelector('#savepp').onclick = (ev) => (post({ action: 'protectedPaths', value: lines('#pp') }), saved(ev.currentTarget));
    saf.querySelector('#saverules').onclick = (ev) => (post({ action: 'rules', allow: lines('#allow'), deny: lines('#deny') }), saved(ev.currentTarget));
    saf.querySelector('#savehooks').onclick = (ev) => {
      try {
        post({ action: 'hooks', event: saf.querySelector('#hookev').value, hooks: JSON.parse(saf.querySelector('#hooks').value || '[]') });
        saved(ev.currentTarget);
      } catch (err) {
        add(active, 'error', `Hooks: invalid JSON (${esc(err.message)})`);
      }
    };
    saf.querySelector('#rulesfile').onclick = (ev) => (ev.preventDefault(), post({ action: 'rulesFile' }));
    saf.querySelector('#openfile').onclick = (ev) => (ev.preventDefault(), post({ action: 'openFile' }));
  }

  /** Messages for the connection manager. */
  function onConnMessage(m) {
    switch (m.type) {
      case 'connections': {
        conn.list = m.list || [];
        conn.providers = m.providers || conn.providers;
        conn.locked = m.locked || {};
        conn.loaded = true;
        settingsSkeleton();
        if (conn.view === 'form' && conn.d?.id) {
          // keep the form; refresh what the list shows about it
          const c = conn.list.find((x) => x.id === conn.d.id);
          if (c) {
            conn.d.hasKey = c.hasKey;
            conn.d.active = c.active;
          }
        } else if (conn.view !== 'form') renderConnections();
        applyConnFocus();
        renderHero();
        break;
      }
      case 'connLocal':
        conn.local = m.servers || [];
        if (conn.view === 'gallery') renderConnections();
        break;
      case 'connModels':
        if (m.reqId !== conn.modelsReq || !conn.d) break;
        conn.modelsLoading = false;
        conn.models = m.models || [];
        conn.ollama = !!m.ollama;
        conn.modelsErr = m.error || '';
        conn.suggest = m.suggestBaseUrl || '';
        // an existing connection's saved size that equals what the server reports is Auto
        if (conn.d.savedCtx && conn.d.ctxPick !== 'auto' && modelInfo()?.contextWindow === conn.d.savedCtx) conn.d.ctxPick = 'auto';
        renderModelList();
        renderSizes();
        renderSuggest();
        break;
      case 'connTest': {
        const t = conn.test;
        if (!t || m.reqId !== t.req) break;
        if (m.name === 'done') {
          t.done = true;
          t.ok = m.state === 'ok';
          t.tools = m.tools;
          requestAnimationFrame(() => $('stab-connections')?.querySelector('.formacts')?.scrollIntoView({ block: 'nearest' }));
          if (m.contextWindow && !conn.models.some((x) => x.id === conn.d.model)) conn.models.push({ id: conn.d.model, contextWindow: m.contextWindow });
          renderSizes();
        } else {
          t.steps[m.name] = { state: m.state, detail: m.detail };
          if (m.suggestBaseUrl) t.suggest = m.suggestBaseUrl;
        }
        renderTest();
        break;
      }
      case 'connSaved':
        conn.saving = false;
        if (!m.ok) {
          conn.msg = { bad: true, text: m.error || 'The connection could not be saved.' };
          if (conn.view === 'form') renderForm($('stab-connections'));
          break;
        }
        conn.view = 'list';
        conn.msg = { bad: false, text: `${m.used ? 'Saved. All new messages use it.' : 'Saved.'}${m.dropped ? ' The old key was removed because the server changed.' : ''}` };
        renderConnections();
        break;
      case 'connError':
        conn.saving = false;
        conn.msg = { bad: true, text: m.error };
        if (conn.view === 'form') renderFormMsg();
        else renderConnections();
        break;
    }
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
        picker.model = m.model || '';
        picker.baseUrl = m.baseUrl || '';
        picker.choice = m.choice || '';
        picker.items = m.picker || [];
        picker.effort = m.effort || 'default';
        picker.connections = m.connections || [];
        setModelLabel();
        renderHero();
        setEffortLabel();
        $('mic').classList.toggle('hidden', !m.voice);
        if (m.mode) {
          state.mode = m.mode;
          setModeLabel(m.mode);
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
          if (h.role === 'user') add(cid, 'user resumed', userHtml(h.text.replace(/<(attached_context|ide_context|environment|environment_update|repo_map)\b[\s\S]*?<\/\1>/g, '').trim()));
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
        add(cid, 'notice probe', `${ic('plug')}<span>Connection test: ${yn(r.chatOk, 'chat')} ${yn(r.nativeTools, 'native tool calls')} ${r.textToolsTested === false && r.nativeTools ? `<span title="The text protocol is only a fallback for models without native tool calls, so it was not tested.">${ic('dash')}text tool calls not needed</span>` : yn(r.textTools, 'text tool calls')} in ${r.latencyMs ?? '?'} ms${r.errors.length ? '<br>' + esc(r.errors.join(' | ')) : ''}${m.ollama ? '<br>' + esc(m.ollama) : ''}</span>`);
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
      case 'connections':
      case 'connLocal':
      case 'connModels':
      case 'connTest':
      case 'connSaved':
      case 'connError':
        onConnMessage(m);
        break;
      case 'showView':
        if (m.focus) state.connFocus = m.focus === 'model' ? 'connections' : m.focus;
        showView(m.view);
        applyConnFocus();
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
  // the saved connections (and the provider marks) for the model switcher
  vscode.postMessage({ type: 'conn', action: 'load' });
})();
