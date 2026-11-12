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
              <button class="chip" id="modelBtn" data-menu="model" aria-haspopup="menu" title="Model for this chat">${ic('sparkle')}<span class="lbl"></span>${ic('chevron-down')}</button>
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

  // An empty chat invites a first task: three starters fill the composer (they never send on their own).
  function emptyHtml() {
    const starters = [
      ['beaker', 'Fix the failing tests', 'Run the tests, find why they fail and fix the code. Do not change the tests.'],
      ['book', 'Explain the current file', 'Explain what the current file does, how it fits into the project, and anything risky in it.'],
      ['list-ordered', 'Plan a change first', 'Make a plan for this change before editing anything: '],
    ];
    return `<div class="empty"><div class="logo">${ic('sparkle')}</div><h2>What should we work on?</h2>
      <p class="lede">Tugline reads your code, edits files, runs commands in a sandbox and checks its work with your project's tests, on the model you choose.</p>
      <div class="starters">${starters.map(([i, t, prompt]) => `<button class="starter" data-prompt="${esc(prompt)}">${ic(i)}<span>${esc(t)}</span></button>`).join('')}</div>
      <p class="hint">Type <kbd>@</kbd> to add files, problems or terminal output, and <kbd>/</kbd> for commands. Select code and press <kbd>Ctrl+Alt+K</kbd> to edit it inline.</p>
      <p class="hint"><a href="#" data-act="cfg">Model and API key</a><span class="sep"></span><a href="#" data-act="test">Test connection</a></p></div>`;
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
    if (v === 'settings') vscode.postMessage({ type: 'settings', action: 'load' });
  }
  document.querySelectorAll('nav.views button[data-view]').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  function openModelSettings() {
    state.focusModel = true;
    showView('settings');
  }

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
  const picker = { model: '', baseUrl: '', choice: '', items: [], effort: 'default' };
  function setModeLabel(m) {
    const mo = MODES.find((x) => x.value === m) || MODES[0];
    $('modeBtn').querySelector('.lbl').textContent = mo.label;
    app.dataset.mode = mo.value;
  }
  function setModelLabel() {
    const cur = picker.items.find((i) => i.value === picker.choice);
    $('modelBtn').querySelector('.lbl').textContent = cur ? cur.label : shortModel(picker.model) || 'Choose a model';
    $('modelBtn').title = `Model for this chat: ${picker.model || 'none'}${picker.baseUrl ? ` @ ${picker.baseUrl}` : ''}`;
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
    const base = [{ value: '', label: shortModel(picker.model) || 'Default model', desc: `${picker.model || ''} (from settings)`, group: 'Default', on: !picker.choice }];
    const rest = picker.items.map((i) => ({ value: i.value, label: i.label, desc: i.detail || '', group: i.group === 'profiles' ? 'Profiles' : 'Models on the endpoint', on: i.value === picker.choice }));
    return [...base, ...rest].filter((i) => !f || i.label.toLowerCase().includes(f) || String(i.value).toLowerCase().includes(f));
  }
  function renderMenu() {
    const kind = menu.kind;
    menu.items = menuItems(kind);
    let group = '';
    const rows = menu.items.map((it, i) => {
      const g = it.group && it.group !== group ? `<div class="mg">${esc((group = it.group))}</div>` : '';
      return `${g}<div class="mi ${i === menu.sel ? 'cur' : ''} ${it.on ? 'on' : ''}" role="menuitemradio" aria-checked="${!!it.on}" data-i="${i}" data-value="${esc(it.value)}">${it.icon ? ic(it.icon) : ''}<span class="mt"><span class="ml">${esc(it.label)}</span>${it.desc ? `<span class="md">${esc(it.desc)}</span>` : ''}</span>${it.on ? ic('check') : ''}</div>`;
    });
    const search = kind === 'model' ? `<div class="msearch">${ic('search')}<input id="menuFilter" placeholder="Filter models" value="${esc(menu.filter)}" aria-label="Filter models"></div>` : '';
    const foot = kind === 'model' ? `<div class="mfoot"><a href="#" data-act="settings">${ic('settings-gear')}Manage models and endpoint…</a></div>` : '';
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
    const w = Math.min(300, window.innerWidth - 16);
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
    const a = e.target.closest('[data-act="settings"]');
    if (a) {
      e.preventDefault();
      closeMenu();
      showView('settings');
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
    if (t.closest('[data-act="cfg"]')) return (e.preventDefault(), openModelSettings());
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
    const d = add(cid, 'perm onboard', `<div class="ptitle">${ic('plug')}<span>${title}</span></div>${body}<div class="row"><button class="secondary" data-ob="retry">Retry</button><button class="secondary" data-ob="configure">Other endpoint…</button><span class="spacer"></span><button class="secondary" data-ob="dismiss">Dismiss</button></div><div class="obs hint"></div>`);
    d.dataset.state = v.state;
  }
  // delegated, so the card's buttons work however it was (re)rendered
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('.msg.onboard button[data-ob]');
    if (!b) return;
    const card = b.closest('.msg.onboard');
    const action = b.dataset.ob;
    if (action === 'configure') openModelSettings();
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
  // the model card's working state survives re-renders (a settings reload must not wipe what the user typed)
  const ep = { baseUrl: '', apiKey: '', model: '', ctx: '', maxOut: '', toolMode: 'auto', models: [], modelsFor: '', modelsNote: '', loading: false, result: null, busy: false, dirty: false, req: 0 };
  const PRESETS = [
    { id: 'ollama', label: 'Ollama (this computer)', url: 'http://localhost:11434/v1', key: false },
    { id: 'lmstudio', label: 'LM Studio (this computer)', url: 'http://localhost:1234/v1', key: false },
    { id: 'llamacpp', label: 'llama.cpp server (this computer)', url: 'http://localhost:8080/v1', key: false },
    { id: 'company', label: "Company server (vLLM, SGLang, Open WebUI, a gateway)", url: '', key: true },
    { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', key: true },
    { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', key: true },
    { id: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1', key: true },
  ];
  const presetOf = (url) => PRESETS.find((p) => p.url && p.url === url)?.id || 'company';

  function loadModels(force) {
    const url = ep.baseUrl.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return;
    if (!force && ep.modelsFor === url + '|' + ep.apiKey) return;
    ep.modelsFor = url + '|' + ep.apiKey;
    ep.loading = true;
    ep.req++;
    vscode.postMessage({ type: 'settings', action: 'endpointModels', reqId: ep.req, baseUrl: url, apiKey: ep.apiKey || undefined });
    renderModelList();
  }
  function renderModelList() {
    const el = $('epModels');
    if (!el) return;
    if (ep.loading) return (el.innerHTML = `<div class="hint">${ic('loading')} Loading models…</div>`);
    // filter only while the user types in the model box; a saved model name does not hide the list
    const f = ep.typing ? ep.model.trim().toLowerCase() : '';
    const list = ep.models.filter((m) => !f || m.id.toLowerCase().includes(f) || m.id === ep.model);
    const sug = ep.suggest ? `<div class="obl"><button class="secondary" data-ep="useSuggest" title="${esc(ep.suggest)}">${ic('arrow-right')}Use ${esc(ep.suggest)}</button></div>` : '';
    el.innerHTML = (ep.modelsNote ? `<div class="${ep.modelsErr ? 'err' : 'hint'}">${esc(ep.modelsNote)}</div>${sug}` : '') +
      (list.length ? `<div class="mlist pick">${list.slice(0, 200).map((m) => `<div class="mi ${m.id === ep.model ? 'on' : ''}" data-model="${esc(m.id)}"><span class="mt"><span class="ml">${esc(m.id)}</span></span>${(m.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}${m.id === ep.model ? ic('check') : ''}</div>`).join('')}</div>` : '');
  }
  function epResultHtml() {
    const r = ep.result;
    if (!r) return '';
    if (r.busy) return `<div class="epres busy">${ic('loading')}<span>${esc(r.text)}</span></div>`;
    if (!r.ok) return `<div class="epres bad">${ic('error')}<span>${esc(r.error || 'The connection failed.')}</span></div>`;
    const rep = r.report || {};
    const yn = (ok, t) => `<span class="${ok ? 'add' : 'rem'}">${ic(ok ? 'check' : 'close')}${t}</span>`;
    const tools = rep.nativeTools ? yn(true, 'native tool calls') : rep.textTools ? yn(true, 'text tool protocol') : yn(false, 'tool calls');
    const speed = rep.latencyMs ? `${(rep.latencyMs / 1000).toFixed(1)} s for a short reply${rep.tokensPerSecond ? ` · ~${rep.tokensPerSecond} tok/s` : ''}` : '';
    return `<div class="epres ok">${ic('pass-filled')}<span><b>Connected to ${esc(r.model || '')}</b><br>${yn(rep.chatOk, 'chat')} ${tools}${speed ? `<br><span class="hint">${esc(speed)}</span>` : ''}${(rep.errors || []).length ? `<br><span class="hint">${esc(rep.errors.join(' | '))}</span>` : ''}</span></div>`;
  }
  function renderSettings() {
    const s = settingsData;
    const el = $('settings');
    if (!s) return;
    const e = s.endpoint || {};
    if (!ep.dirty) {
      ep.baseUrl = e.baseUrl || '';
      ep.model = e.model || '';
      ep.ctx = e.contextWindow ? String(e.contextWindow) : '';
      ep.maxOut = e.maxOutputTokens ? String(e.maxOutputTokens) : '';
      ep.toolMode = e.toolMode || 'auto';
    }
    const locked = e.locked || {};
    const pr = s.prefs || {};
    const sc = s[settingsScope];
    const d = sc.data || {};
    const perms = d.permissions || {};
    const hooks = d.hooks || {};
    const preset = presetOf(ep.baseUrl);
    el.innerHTML = `<div class="settings">
      <section class="card sec" id="sec-model">
        <div class="sech">${ic('sparkle')}<h3>Model</h3></div>
        <p class="hint">Tugline works with any OpenAI-compatible endpoint: a model on this computer, your company's server, or a hosted API.</p>
        ${locked.baseUrl || locked.model ? `<p class="caveat">${ic('lock')} Your organisation manages the endpoint${locked.model ? ` (${esc(locked.model)})` : ''}. It cannot be changed here.</p>` : ''}
        <div class="field"><label for="epPreset">Provider</label><select id="epPreset" ${locked.baseUrl ? 'disabled' : ''}>${PRESETS.map((p) => `<option value="${p.id}" ${p.id === preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="epUrl">Base URL</label><input id="epUrl" spellcheck="false" placeholder="https://ai.example.com/v1" value="${esc(ep.baseUrl)}" ${locked.baseUrl ? 'disabled' : ''}><span class="hint">The API address, usually ending in <code>/v1</code> (Open WebUI: <code>/api</code>), not the chat website's address.</span></div>
        <div class="field"><label for="epKey">API key</label><div class="pw"><input id="epKey" type="password" spellcheck="false" autocomplete="off" placeholder="${e.hasKey ? '•••••••• saved — type to replace' : 'Leave empty if your endpoint needs none'}" value="${esc(ep.apiKey)}"><button class="ib" id="epKeyShow" title="Show or hide the key" aria-label="Show or hide the key">${ic('eye')}</button></div><span class="hint">Kept in VS Code's secret storage, never in settings files.${e.hasKey ? ' <a href="#" data-ep="clearKey">Remove the saved key</a>' : ''}</span></div>
        <div class="field"><label for="epModel">Model</label><div class="row tight"><input id="epModel" spellcheck="false" placeholder="Type or pick from the list" value="${esc(ep.model)}" ${locked.model ? 'disabled' : ''}><button class="secondary" id="epLoad" title="Ask the endpoint which models it serves">${ic('refresh')}Load</button></div><div id="epModels"></div></div>
        <details class="more" ${ep.moreOpen ? 'open' : ''}><summary>Advanced: context window, output limit, tool calling</summary>
          <div class="grid2">
            <div class="field"><label for="epCtx">Context window (tokens)</label><input id="epCtx" type="number" min="0" step="1024" placeholder="auto" value="${esc(ep.ctx)}"></div>
            <div class="field"><label for="epMax">Max output tokens</label><input id="epMax" type="number" min="0" step="256" value="${esc(ep.maxOut)}"></div>
          </div>
          <div class="field"><label>Tool calling</label><div class="seg" id="epTool">${[['auto', 'Auto'], ['native', 'Native'], ['text', 'Text protocol']].map(([v, l]) => `<button class="${ep.toolMode === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div><span class="hint">Auto uses the model's native tool calls and falls back to a text protocol when the server rejects them.</span></div>
        </details>
        <div class="row acts"><button id="epSave" ${ep.busy ? 'disabled' : ''}>${ic('check')}Save and test</button><button class="secondary" id="epTest" ${ep.busy ? 'disabled' : ''}>Test connection</button></div>
        <div id="epResult">${epResultHtml()}</div>
      </section>
      <section class="card sec">
        <div class="sech">${ic('settings')}<h3>Behaviour</h3></div>
        <div class="field"><label for="pfMode">Default permission mode for new chats</label><select id="pfMode">${MODES.map((m) => `<option value="${m.value}" ${pr.permissionMode === m.value ? 'selected' : ''}>${esc(m.label)}: ${esc(m.desc)}</option>`).join('')}</select></div>
        <label class="toggle"><input type="checkbox" id="pfNotify" ${pr.notifications !== false ? 'checked' : ''}><span class="sw"></span>Notify me when a long task finishes</label>
        <label class="toggle"><input type="checkbox" id="pfTerminal" ${pr.visibleTerminal ? 'checked' : ''}><span class="sw"></span>Run commands in a visible terminal</label>
      </section>
      <details class="card sec" ${state.rulesOpen ? 'open' : ''} id="secRules"><summary class="sech">${ic('shield')}<h3>Rules and safety</h3><span class="hint">protected files, allow and deny rules, hooks</span></summary>
      <div class="row"><span class="hint">Applies to</span><select id="scope"><option value="user">You (~/.tugline)</option><option value="project" ${s.hasWorkspace ? '' : 'disabled'}>This project (.tugline)</option></select></div>
      ${settingsScope === 'project' ? `<p class="caveat">${s.trusted ? 'This workspace is trusted: its project config applies in full.' : 'This workspace is not trusted. From project config only deny rules, protected paths and disabled skills take effect; allow rules, modes, hooks and MCP servers are ignored until you trust it.'}</p>` : ''}
      <p class="hint mono">${esc(sc.file || sc.error || '')}</p>
      <div class="field"><label for="pp">Protected paths (one glob per line; the agent may never write these)</label><textarea id="pp" rows="3">${esc((perms.protectedPaths || []).join('\n'))}</textarea></div>
      <div class="row"><button class="secondary" id="savepp">Save protected paths</button></div>
      <div class="field"><label for="allow">Allow rules (e.g. <code>bash(npm test)</code>, <code>edit(src/**)</code>)</label><textarea id="allow" rows="3">${esc((perms.allow || []).join('\n'))}</textarea></div>
      <div class="field"><label for="deny">Deny rules</label><textarea id="deny" rows="3">${esc((perms.deny || []).join('\n'))}</textarea></div>
      <div class="row"><button class="secondary" id="saverules">Save rules</button></div>
      <div class="field"><label for="hookev">Hooks</label><select id="hookev">${['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompact', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification'].map((h) => `<option>${h}</option>`).join('')}</select><textarea id="hooks" rows="4" class="mono"></textarea><span class="hint">JSON list: [{"matcher":"bash","command":"./check.sh"}]. Project hooks also need approval (/hooks approve).</span></div>
      <div class="row"><button class="secondary" id="savehooks">Save hooks</button></div>
      </details>
      <div class="row links"><a href="#" id="rulesfile">${ic('book')}Edit ${settingsScope === 'user' ? '~/.tugline/AGENTS.md' : 'AGENTS.md'} (instructions)</a><a href="#" id="openfile">${ic('json')}Open config file</a><a href="#" id="vss">${ic('settings')}All VS Code settings</a></div>
    </div>`;
    el.querySelector('#scope').value = settingsScope;
    renderModelList();
    // ---- model card
    const bind = (id, key) => el.querySelector(id)?.addEventListener('input', (ev) => { ep[key] = ev.target.value; ep.dirty = true; });
    bind('#epUrl', 'baseUrl');
    bind('#epKey', 'apiKey');
    bind('#epCtx', 'ctx');
    bind('#epMax', 'maxOut');
    el.querySelector('#epModel')?.addEventListener('input', (ev) => { ep.model = ev.target.value; ep.dirty = true; ep.typing = true; renderModelList(); });
    el.querySelector('#epUrl')?.addEventListener('change', () => loadModels(false));
    el.querySelector('#epKey')?.addEventListener('change', () => loadModels(false));
    el.querySelector('#epModel')?.addEventListener('focus', () => loadModels(false));
    el.querySelector('#epPreset')?.addEventListener('change', (ev) => {
      const p = PRESETS.find((x) => x.id === ev.target.value);
      ep.dirty = true;
      if (p && p.url) ep.baseUrl = p.url;
      else if (p && p.id === 'company' && PRESETS.some((x) => x.url === ep.baseUrl)) ep.baseUrl = '';
      el.querySelector('#epUrl').value = ep.baseUrl;
      if (p && p.id === 'company') el.querySelector('#epUrl').focus();
      ep.models = [];
      ep.modelsNote = '';
      ep.suggest = '';
      loadModels(true);
    });
    el.querySelector('#epKeyShow').onclick = () => { const k = el.querySelector('#epKey'); k.type = k.type === 'password' ? 'text' : 'password'; };
    el.querySelector('#epLoad').onclick = () => loadModels(true);
    el.querySelector('#epModels').addEventListener('click', (ev) => {
      const mi = ev.target.closest('.mi[data-model]');
      if (mi) {
        ep.model = mi.dataset.model;
        ep.typing = false;
        ep.dirty = true;
        el.querySelector('#epModel').value = ep.model;
        renderModelList();
      }
      const sug = ev.target.closest('[data-ep="useSuggest"]');
      if (sug) {
        ep.baseUrl = ep.suggest;
        ep.dirty = true;
        el.querySelector('#epUrl').value = ep.baseUrl;
        ep.suggest = '';
        loadModels(true);
      }
    });
    el.querySelector('.more').ontoggle = (ev) => (ep.moreOpen = ev.target.open);
    el.querySelectorAll('#epTool button').forEach((b) => (b.onclick = () => { ep.toolMode = b.dataset.v; ep.dirty = true; el.querySelectorAll('#epTool button').forEach((x) => x.classList.toggle('on', x === b)); }));
    el.querySelector('[data-ep="clearKey"]')?.addEventListener('click', (ev) => { ev.preventDefault(); vscode.postMessage({ type: 'settings', action: 'clearKey' }); });
    const saveEp = () => {
      const url = ep.baseUrl.trim();
      if (!/^https?:\/\/\S+$/.test(url)) {
        ep.result = { ok: false, error: 'Enter the base URL, starting with http:// or https://.' };
        return (el.querySelector('#epResult').innerHTML = epResultHtml());
      }
      ep.busy = true;
      ep.result = { busy: true, text: `Saving and testing ${ep.model || 'the endpoint'}…` };
      vscode.postMessage({ type: 'settings', action: 'saveEndpoint', baseUrl: url, apiKey: ep.apiKey || undefined, model: ep.model.trim(), contextWindow: Number(ep.ctx) || 0, maxOutputTokens: Number(ep.maxOut) || 0, toolMode: ep.toolMode });
      renderSettings();
    };
    el.querySelector('#epSave').onclick = saveEp;
    el.querySelector('#epTest').onclick = () => {
      ep.busy = true;
      ep.result = { busy: true, text: 'Testing the saved endpoint…' };
      vscode.postMessage({ type: 'settings', action: 'testEndpoint' });
      renderSettings();
    };
    // ---- behaviour (VS Code settings)
    const pref = (key, value) => vscode.postMessage({ type: 'settings', action: 'pref', key, value });
    el.querySelector('#pfMode').onchange = (ev) => pref('permissionMode', ev.target.value);
    el.querySelector('#pfNotify').onchange = (ev) => pref('notifications', ev.target.checked);
    el.querySelector('#pfTerminal').onchange = (ev) => pref('visibleTerminal', ev.target.checked);
    // ---- rules and safety (config files)
    el.querySelector('#secRules').ontoggle = (ev) => (state.rulesOpen = ev.target.open);
    const hookText = () => JSON.stringify(hooks[el.querySelector('#hookev').value] || [], null, 2);
    el.querySelector('#hooks').value = hookText();
    el.querySelector('#hookev').onchange = () => (el.querySelector('#hooks').value = hookText());
    el.querySelector('#scope').onchange = (ev) => { settingsScope = ev.target.value; renderSettings(); };
    const lines = (id) => el.querySelector(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    const post = (m) => vscode.postMessage({ type: 'settings', scope: settingsScope, ...m });
    el.querySelector('#savepp').onclick = () => post({ action: 'protectedPaths', value: lines('#pp') });
    el.querySelector('#saverules').onclick = () => post({ action: 'rules', allow: lines('#allow'), deny: lines('#deny') });
    el.querySelector('#savehooks').onclick = () => {
      try {
        post({ action: 'hooks', event: el.querySelector('#hookev').value, hooks: JSON.parse(el.querySelector('#hooks').value || '[]') });
      } catch (err) {
        add(active, 'error', `Hooks: invalid JSON (${esc(err.message)})`);
      }
    };
    el.querySelector('#rulesfile').onclick = (ev) => (ev.preventDefault(), post({ action: 'rulesFile' }));
    el.querySelector('#openfile').onclick = (ev) => (ev.preventDefault(), post({ action: 'openFile' }));
    el.querySelector('#vss').onclick = (ev) => (ev.preventDefault(), post({ action: 'vscodeSettings' }));
    if (state.focusModel) {
      state.focusModel = false;
      el.querySelector('#sec-model').scrollIntoView({ block: 'start' });
      (ep.baseUrl ? el.querySelector('#epModel') : el.querySelector('#epUrl'))?.focus();
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
        setModelLabel();
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
      case 'endpointModels':
        if (m.reqId !== ep.req) break;
        ep.loading = false;
        ep.typing = false;
        ep.models = m.models || [];
        ep.modelsErr = !!m.error;
        ep.suggest = m.suggestBaseUrl || '';
        ep.modelsNote = m.error ? m.error : ep.models.length ? `${ep.models.length} model${ep.models.length === 1 ? '' : 's'} on this endpoint: click one to use it.` : 'The endpoint listed no models. Type the model name.';
        renderModelList();
        break;
      case 'endpointResult':
        ep.busy = false;
        // the form shows what was saved: the host's fresh settings when it sends them, else what the user typed
        if (m.ok && m.settings) ep.dirty = false;
        ep.apiKey = m.ok ? '' : ep.apiKey;
        ep.result = { ok: m.ok, error: m.error, report: m.report, model: m.model };
        if (m.settings) settingsData = m.settings;
        if (state.view === 'settings') renderSettings();
        break;
      case 'showView':
        if (m.focus === 'model') state.focusModel = true;
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
