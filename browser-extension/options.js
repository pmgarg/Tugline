const $ = (id) => document.getElementById(id);
const ask = (m) => chrome.runtime.sendMessage(m);
function show(s) {
  if (!s || !s.ok) {
    $('status').textContent = `error: ${(s && s.error) || 'no answer'}`;
    return;
  }
  $('status').textContent = `${s.status}${s.agent ? ' · an agent is connected' : ''}`;
  const li = (t) => Object.assign(document.createElement('li'), { textContent: t });
  $('tabs').replaceChildren(...(s.tabs.length ? s.tabs.map((t) => li(`${t.attached ? 'controlled' : 'shared'} · ${t.title || ''} ${t.url || ''}`)) : [li('none')]));
  $('blocked').replaceChildren(...(s.blocked.length ? s.blocked.map((b) => li(`${b.url}: ${b.reason}`)) : [li('none')]));
}
async function init() {
  const s = await ask({ type: 'status' });
  if (s && s.ok) {
    $('url').value = s.url || '';
    $('sites').value = (s.sites || []).join('\n');
    $('strict').checked = !!s.strict;
  }
  show(s);
}
$('save').onclick = async () => show(await ask({ type: 'save', settings: { url: $('url').value, token: $('token').value, sites: $('sites').value, strict: $('strict').checked } }));
$('stop').onclick = async () => show(await ask({ type: 'stopAll' }));
setInterval(async () => show(await ask({ type: 'status' })), 1500);
void init();
