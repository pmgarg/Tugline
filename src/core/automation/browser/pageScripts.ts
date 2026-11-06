/**
 * Code that runs inside the page. Kept as plain JavaScript source and turned
 * into functions at runtime: bundlers (tsx/esbuild `keepNames`) inject helpers
 * such as `__name` into compiled functions, which do not exist in the page
 * and break `page.evaluate`. A runtime `new Function` has clean source.
 */

/** Build a page function from source text. */
export function pageFn<A = unknown, R = unknown>(src: string): (arg: A) => R {
  return new Function(`return (${src});`)() as (arg: A) => R;
}

/**
 * DOM-walk fallback snapshot (SPEC E1) for Playwright builds without
 * `ariaSnapshot({mode:'ai'})`/`getByRef`. Assigns stable `data-oh-ref`
 * attributes (reused across snapshots, like Playwright's own refs), computes an
 * ARIA role and accessible name, states, values and boxes, and pierces open
 * shadow roots. Returns a UiNode-shaped tree.
 */
export const DOM_SNAPSHOT_SRC = String.raw`(opts) => {
  let seq = window.__ohRefSeq || 0;
  const INTERACTIVE = new Set(['button','link','textbox','searchbox','checkbox','radio','combobox','listbox','option','menuitem','menuitemcheckbox','menuitemradio','tab','switch','slider','spinbutton','treeitem']);
  const KEEP = new Set(['main','navigation','banner','contentinfo','complementary','region','search','form','dialog','alertdialog','table','row','cell','columnheader','rowheader','list','listitem','heading','paragraph','img','status','alert','tabpanel','tablist','menu','menubar','group','article','figure','tree','grid','gridcell']);
  const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const hidden = (el) => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };
  const inputRole = (el) => {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (['button','submit','reset','image'].includes(t)) return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'range') return 'slider';
    if (t === 'number') return 'spinbutton';
    if (t === 'search') return 'searchbox';
    if (t === 'hidden') return null;
    if (t === 'file') return 'button';
    return 'textbox';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'input': return inputRole(el);
      case 'textarea': return 'textbox';
      case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'option': return 'option';
      case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return el.closest('article,section,main') ? 'generic' : 'banner';
      case 'footer': return el.closest('article,section,main') ? 'generic' : 'contentinfo';
      case 'aside': return 'complementary';
      case 'form': return 'form';
      case 'section': return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) ? 'region' : 'generic';
      case 'dialog': return 'dialog';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'th': return 'columnheader';
      case 'td': return 'cell';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'p': return 'paragraph';
      case 'article': return 'article';
      case 'fieldset': return 'group';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'canvas': return 'canvas';
      default: return 'generic';
    }
  };
  const byIds = (ids) => txt(ids.split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' '));
  const nameOf = (el, role) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const n = byIds(lb); if (n) return n; }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return txt(al);
    const tag = el.tagName.toLowerCase();
    if (['input','textarea','select'].includes(tag)) {
      if (el.labels && el.labels.length) return txt([...el.labels].map((l) => l.textContent).join(' '));
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (['button','submit','reset'].includes(t)) return txt(el.value || (t === 'submit' ? 'Submit' : ''));
      return txt(el.getAttribute('title') || '');
    }
    if (tag === 'img') return txt(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (tag === 'fieldset') { const lg = el.querySelector('legend'); return lg ? txt(lg.textContent) : ''; }
    if (['button','link','heading','option','menuitem','tab','cell','columnheader','rowheader','treeitem','menuitemcheckbox','menuitemradio','switch','checkbox','radio'].includes(role)) return txt(el.innerText || el.textContent).slice(0, 200);
    return txt(el.getAttribute('title') || '');
  };
  const statesOf = (el, role) => {
    const s = [];
    const tag = el.tagName.toLowerCase();
    if ((role === 'checkbox' || role === 'radio' || role === 'switch') && (el.checked || el.getAttribute('aria-checked') === 'true')) s.push('checked');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    const ex = el.getAttribute('aria-expanded');
    if (ex === 'true') s.push('expanded'); else if (ex === 'false') s.push('expanded=false');
    if ((tag === 'option' && el.selected) || el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    const hp = el.getAttribute('aria-haspopup');
    if (hp && hp !== 'false') s.push('haspopup=' + (hp === 'true' ? 'menu' : hp));
    if (role === 'heading') s.push('level=' + (el.getAttribute('aria-level') || tag.slice(1)));
    if (document.activeElement === el) s.push('focused');
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password') s.push('password');
    return s;
  };
  const boxOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const clickable = (el, role) => !INTERACTIVE.has(role) && (el.onclick || getComputedStyle(el).cursor === 'pointer') && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
  let count = 0;
  const walkKids = (el, out) => {
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : [...el.childNodes];
    for (const k of kids) visit(k, out);
  };
  const visit = (node, out) => {
    if (count > (opts.maxNodes || 20000)) return;
    if (node.nodeType === 3) { const t = txt(node.textContent); if (t) out.push({ role: 'text', name: t }); return; }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (['script','style','noscript','template','head','meta','link'].includes(tag)) return;
    if (hidden(el)) return;
    const role = roleOf(el);
    if (!role) return;
    const n = { role };
    count++;
    const interactive = INTERACTIVE.has(role) || clickable(el, role);
    const name = nameOf(el, role);
    if (name) n.name = name;
    const st = statesOf(el, role);
    if (clickable(el, role)) st.push('clickable');
    if (st.length) n.states = st;
    if (interactive || KEEP.has(role) || role === 'canvas') {
      let ref = el.getAttribute('data-oh-ref');
      if (!ref) { ref = 'e' + (++seq); el.setAttribute('data-oh-ref', ref); }
      n.ref = ref;
      n.box = boxOf(el);
    }
    if (tag === 'a' && el.getAttribute('href')) n.url = el.getAttribute('href');
    if (['textbox','searchbox','spinbutton','slider'].includes(role) && 'value' in el) n.value = String(el.value);
    if (role === 'combobox' && tag === 'select') { const o = el.selectedOptions[0]; if (o) n.value = txt(o.textContent); }
    if (el.getAttribute('placeholder')) n.placeholder = el.getAttribute('placeholder');
    const kids = [];
    // Interactive leaves carry their text as the name; do not repeat it as children.
    if (!(['button','link','option','menuitem','tab','heading','cell','columnheader','checkbox','radio'].includes(role) && n.name)) walkKids(el, kids);
    else if (tag === 'select') walkKids(el, kids);
    if (kids.length) n.children = kids;
    out.push(n);
  };
  const out = [];
  visit(document.body || document.documentElement, out);
  window.__ohRefSeq = seq;
  return { role: 'document', children: out };
}`;

/** Facts the policy layer needs about the whole page (E3 L0, E8). */
export const PAGE_FACTS_SRC = String.raw`() => {
  const q = (s) => document.querySelectorAll(s).length;
  const cardFields = q('input[autocomplete^="cc-"], input[name*="cardnumber" i], input[name*="card-number" i], input[name*="ccnum" i], input[id*="cardnumber" i], input[data-stripe], iframe[src*="stripe.com"], iframe[name*="card" i]') > 0;
  const otpField = q('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="2fa" i], input[id*="otp" i]') > 0;
  const passwords = [...document.querySelectorAll('input[type=password]')].map((el) => ({
    value: el.value,
    label: ((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim(),
  }));
  const text = (document.body ? document.body.innerText : '').slice(0, 20000);
  const canvas = q('canvas');
  const iframes = [...document.querySelectorAll('iframe')].map((f) => f.src || '');
  return { cardFields, otpField, passwords, text, canvas, iframes, title: document.title };
}`;

/** Facts about one target element (fence, handoff, recorder selectors). */
export const ELEMENT_INFO_SRC = String.raw`(el) => {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  const nm = ((el.getAttribute('name') || '') + ' ' + (el.id || '')).toLowerCase();
  let fieldKind = 'other';
  if (ac.startsWith('cc-') || /card.?num|ccnum|cc-?number|cvc|cvv/.test(nm)) fieldKind = 'card';
  else if (ac === 'one-time-code' || /otp|2fa|totp/.test(nm)) fieldKind = 'otp';
  else if (type === 'password') fieldKind = 'password';
  const form = el.form || el.closest('form');
  const submit = (tag === 'button' && (type === 'submit' || (!type && !!form))) || (tag === 'input' && (type === 'submit' || type === 'image'));
  const hp = el.getAttribute('aria-haspopup');
  return {
    tag, type, id: el.id || '', testid: el.getAttribute('data-testid') || '',
    haspopup: !!hp && hp !== 'false', expanded: el.getAttribute('aria-expanded'),
    submit, inForm: !!form, fieldKind, isFile: tag === 'input' && type === 'file', isSelect: tag === 'select',
    href: tag === 'a' ? (el.getAttribute('href') || '') : '', target: el.getAttribute('target') || '',
  };
}`;
