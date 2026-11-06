// V0.1 conformance (v1.2 N45): runs ONE hostile scenario through the VS Code extension host path, inside a real
// VS Code. The driver (test/conformance/drivers/vscode-host.ts) launches VS Code on the scenario's workspace with
// HOME set to the scenario's fake home, and serves a control endpoint: every approval prompt the chat panel raises
// is forwarded there (the driver's human answers), and the answer comes back through the panel's own reply
// message, exactly like a click in the webview. The result is posted back at the end.
const vscode = require('vscode');
const http = require('http');

function call(pathname, body) {
  const u = new URL(pathname, process.env.TUG_CONF_URL);
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-conformance-token': process.env.TUG_CONF_TOKEN } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(b || '{}')) : reject(new Error(`control ${res.statusCode}: ${b}`))));
    });
    req.on('error', reject);
    req.end(data);
  });
}

exports.run = async function () {
  const out = [];
  let stopReason;
  let finalText = '';
  try {
    const ext = vscode.extensions.all.find((e) => e.id.endsWith('tugline'));
    const api = await ext.activate();
    const P = api.provider;
    await vscode.commands.executeCommand('workbench.view.extension.tugline');
    await vscode.commands.executeCommand('tugline.chat.focus');
    const origPost = P.post.bind(P);
    P.post = (m) => {
      if (m.type === 'permission' || m.type === 'ask' || m.type === 'plan') {
        const req = m.type === 'permission' ? { tool: m.request.tool, title: m.request.title, detail: m.request.detail, reason: m.request.reason } : { title: m.question || 'approve the plan' };
        call('/human', req).then(
          (a) => {
            if (m.type === 'permission') P.onMessage({ type: 'permissionReply', id: m.id, decision: a.decision === 'allow' ? 'allow' : 'deny' });
            else if (m.type === 'ask') P.onMessage({ type: 'askReply', id: m.id, answer: a.decision === 'allow' ? 'yes' : 'no' });
            else P.onMessage({ type: 'planReply', id: m.id, approved: a.decision === 'allow' });
          },
          () => P.onMessage({ type: 'permissionReply', id: m.id, decision: 'deny' }),
        );
      }
      if (m.type === 'error') out.push(String(m.message));
      return origPost(m);
    };
    P.eventListeners.push((e) => {
      if (e.type === 'text_delta') out.push(e.text);
      else if (e.type === 'tool_end') out.push(String(e.output || ''));
      else if (e.type === 'notice') out.push(e.message);
      else if (e.type === 'run_end') {
        stopReason = e.stopReason;
        finalText = e.finalText || '';
      }
    });
    const chat = P.newChat();
    await P.getAgent(chat);
    await P.sendPrompt(process.env.TUG_CONF_PROMPT);
    for (const c of P.chats.values()) await c.agent?.dispose();
  } catch (e) {
    out.push(`extension error: ${e && e.stack ? e.stack : e}`);
  }
  await call('/result', { stopReason, finalText, output: out.join('\n') });
};
