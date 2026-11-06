/**
 * Tugline extension service worker (SPEC v1.1 N29): wires chrome.* events
 * to the Bridge (lib/bridge.js). A tab is shared only from the toolbar action.
 */
import { Bridge } from './lib/bridge.js';

const bridge = new Bridge({ chrome, WebSocket, log: (s) => console.log(`[tugline] ${s}`) });
self.ohBridge = bridge; // for the options page and for tests (extension contexts only)

chrome.action.onClicked.addListener((tab) => void bridge.toggleShare(tab));
chrome.debugger.onEvent.addListener((source, method, params) => void bridge.onDebuggerEvent(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => void bridge.onDebuggerDetach(source, reason));
chrome.tabs.onRemoved.addListener((tabId) => void bridge.onTabRemoved(tabId));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const t = bridge.shared.get(tabId);
  if (t && (info.url || info.title)) {
    t.url = tab.url;
    t.title = tab.title;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only our own pages (options) may talk to the worker.
  if (sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith(chrome.runtime.getURL(''))) return false;
  (async () => {
    if (msg.type === 'status') return bridge.snapshot();
    if (msg.type === 'save') return (await bridge.save(msg.settings), bridge.snapshot());
    if (msg.type === 'stopAll') return (await bridge.stopAll(), bridge.snapshot());
    if (msg.type === 'reconnect') return (bridge.connect(), bridge.snapshot());
    throw new Error('unknown request');
  })().then(
    (r) => reply({ ok: true, ...r }),
    (e) => reply({ ok: false, error: e.message }),
  );
  return true;
});

bridge.ready = bridge.load().then(() => bridge.connect());
