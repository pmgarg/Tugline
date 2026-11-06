/**
 * Tugline browser extension: request and command policy (SPEC v1.1 N29).
 *
 * Pure functions, no chrome.* calls, so they are unit-tested in node
 * (test/browser-extension.test.ts). The extension enforces this on its own,
 * independently of the core: a compromised or misconfigured core still cannot
 * take the shared tab to a site the user did not allow in the extension.
 *
 * A URL must pass BOTH lists for a top-level navigation:
 *   - `userSites`: the sites the user allowed in the extension's options page;
 *   - `coreSites`: browser.attachedAllowDomains, pushed by the core when an agent attaches.
 * Subresources may go to any public host unless `strictSubresources`. Literal
 * private/loopback/link-local/metadata addresses and internal names are refused
 * unless listed in `allowHosts` (web.allowHosts, pushed by the core). Hostnames
 * that need DNS to judge are checked by the core (it resolves them) after this.
 */

/** Same semantics as the core's domainAllowed(): exact host, "*.example.com" (apex included), or "*". */
export function hostMatches(host, patterns) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return (patterns || []).some((p) => {
    const q = String(p).toLowerCase().trim();
    if (!q) return false;
    if (q === '*') return true;
    if (q.startsWith('*.')) return h.endsWith(q.slice(1)) || h === q.slice(2);
    return h === q;
  });
}

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Mirrors the core's isPrivateAddress() for literal addresses. */
export function isPrivateLiteral(host) {
  const v = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (V4.test(v)) return ipv4Private(v);
  if (!v.includes(':')) return false;
  if (v === '::1' || v === '::') return true;
  const mapped = v.match(/^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (v.startsWith('::ffff:') && V4.test(v.slice(7))) return ipv4Private(v.slice(7));
  if (/^64:ff9b::/.test(v)) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

export function isInternalName(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h === 'metadata.google.internal';
}

/**
 * Local verdict for one request. kind: 'main' (top-level navigation of a
 * shared tab), 'frame' (iframe document) or 'sub' (any other request).
 * Returns a reason string to refuse, or undefined to pass (to the core check).
 */
export function checkRequest(url, kind, policy) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'invalid URL';
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return undefined;
  if (!/^(https?|wss?):$/.test(u.protocol)) return kind === 'main' ? `${u.protocol} pages cannot be opened by the agent` : undefined;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const p = policy || {};
  if (kind === 'main') {
    if (!hostMatches(host, p.userSites)) return `${host} is not in the extension's allowed sites (Tugline options)`;
    if (!hostMatches(host, p.coreSites)) return `${host} is not in browser.attachedAllowDomains`;
  } else if (p.strictSubresources && !hostMatches(host, p.userSites)) {
    return `${host} is not in the extension's allowed sites (strict subresources)`;
  }
  const allowed = hostMatches(host, p.allowHosts);
  if (!allowed && (isInternalName(host) || isPrivateLiteral(host))) return `${host} is a private, loopback or metadata address (SSRF rule; add it to web.allowHosts to allow)`;
  return undefined;
}

/**
 * CDP commands the core may NOT send through the extension. The extension owns
 * the Fetch domain (its request guard); cookies and browser-wide state stay out
 * of reach; new tabs are never created (only tabs the user shares are driven).
 */
const DENY_METHODS = new Set([
  'Network.getAllCookies',
  'Network.getCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.setRequestInterception',
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
  'Storage.clearDataForOrigin',
  'Page.setDownloadBehavior',
  'Target.createTarget',
  'Target.createBrowserContext',
  'Target.closeTarget',
  'Target.attachToTarget',
  'Target.exposeDevToolsProtocol',
  'Browser.close',
  'Browser.crash',
  'SystemInfo.getProcessInfo',
  // Reach the user's file system or fetch outside the page's own request path (N29 review).
  'DOM.setFileInputFiles',
  'DOM.getFileInfo',
  'Page.setInterceptFileChooserDialog',
  'Network.loadNetworkResource',
]);
const DENY_DOMAINS = ['IO.', 'FileSystem.', 'Fetch.', 'Browser.', 'Tethering.', 'Extensions.', 'Memory.', 'Tracing.', 'HeapProfiler.', 'Cast.'];

export function checkCommand(method, params, policy) {
  const m = String(method || '');
  if (DENY_METHODS.has(m) || DENY_DOMAINS.some((d) => m.startsWith(d))) return `${m} is not available through the Tugline extension`;
  if (m === 'Page.navigate') return checkRequest(params && params.url, 'main', policy);
  // A synthetic drag can carry local files into the page, like a file input.
  if (m === 'Input.dispatchDragEvent' && params && params.data && Array.isArray(params.data.files) && params.data.files.length) return `${m} with files is not available through the Tugline extension`;
  return undefined;
}

/** Fetch.requestPaused → kind. The tab's main frame id equals its target id. */
export function requestKind(ev, mainFrameId, isChildTarget) {
  if (ev.resourceType !== 'Document') return 'sub';
  return !isChildTarget && ev.frameId === mainFrameId ? 'main' : 'frame';
}

/** Validate a pairing URL from the options page: ws:// on a loopback host only. */
export function validPairingUrl(s) {
  try {
    const u = new URL(String(s).trim());
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return undefined;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return undefined;
    if (!u.pathname || u.pathname === '/') u.pathname = '/browser-extension';
    return u.toString();
  } catch {
    return undefined;
  }
}
