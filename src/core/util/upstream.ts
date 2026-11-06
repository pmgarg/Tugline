/**
 * One hardened way to turn a request path received by a forwarding proxy (the container session's model relay, a
 * metering proxy) into the upstream URL, before any credential is attached (N36 re-check RC-1).
 *
 *   buildUpstreamTarget({ origin, basePath }, reqUrl, allowPaths?, method?) → { ok: true, url } | { ok: false, reason }
 *
 * `method`, when given, must be one of MODEL_API_METHODS (GET, HEAD, POST); `isAllowedMethod` is the same check alone.
 *
 * `reqUrl` is what follows the route prefix: a path with an optional query, e.g. "/v1/chat/completions?x=1".
 * Refused, before anything is built: an absolute or protocol-relative URL ("http://…", "//host", "/\host"), any
 * backslash, encoded ".", "/", "\" or "%" ("%2e", "%2f", "%5c", "%25", any case), "." or ".." segments, control
 * characters and whitespace. Then the URL is built and checked AS BUILT: its origin must equal the route's origin,
 * its pathname must equal what was asked (no normalisation happened) and lie at or under `basePath`, and (unless the
 * caller passes its own list) the path below `basePath` must be a model API path. The caller attaches credentials
 * only to an `ok` result and must not follow redirects from the upstream.
 */

export interface UpstreamRoute {
  /** scheme://host[:port], e.g. "https://api.openai.com" */
  origin: string;
  /** the endpoint's base path, e.g. "/v1", or "/" */
  basePath: string;
}

export type UpstreamTarget = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Paths below the base path that a model client uses: OpenAI-compatible (`/chat/completions`, `/completions`,
 * `/embeddings`, `/models[/<id>]`, `/responses`), Anthropic (`/messages`), rerankers, the same under `/v1` (a base
 * path of "/"), Ollama's native API and llama.cpp's `/props` and `/health`.
 */
export const MODEL_API_PATHS: RegExp[] = [
  /^(?:\/v1)?\/(?:chat\/completions|completions|embeddings|responses|messages|rerank|models)$/,
  /^(?:\/v1)?\/models\/[A-Za-z0-9._:@+-]{1,200}$/,
  /^\/api\/(?:chat|generate|tags|show|embed|embeddings|version|ps)$/,
  /^\/(?:props|health)?$/,
];

/** Re-check 2 RC-1g: the methods a model client uses. Anything else (DELETE, PUT, PATCH, OPTIONS, TRACE, CONNECT …) is refused. */
export const MODEL_API_METHODS: readonly string[] = ['GET', 'HEAD', 'POST'];

/** Is `method` one a forwarding proxy may send upstream (default: MODEL_API_METHODS)? */
export function isAllowedMethod(method: string | undefined, allowed: readonly string[] = MODEL_API_METHODS): boolean {
  return typeof method === 'string' && allowed.includes(method.toUpperCase()) && method === method.toUpperCase();
}

const ENCODED_SEPARATOR = /%(?:2e|2f|5c|25)/i;

export function buildUpstreamTarget(route: UpstreamRoute, reqUrl: string, allowPaths: RegExp[] | null = MODEL_API_PATHS, method?: string): UpstreamTarget {
  if (method !== undefined && !isAllowedMethod(method)) return { ok: false, reason: `method ${String(method).slice(0, 16)} is not forwarded (${MODEL_API_METHODS.join(', ')} only)` };
  if (typeof reqUrl !== 'string' || !reqUrl.startsWith('/')) return { ok: false, reason: 'not a path' };
  if (reqUrl.startsWith('//')) return { ok: false, reason: 'protocol-relative URL' };
  if (reqUrl.includes('\\')) return { ok: false, reason: 'backslash in the path' };
  if (/[\u0000- \u007f]/.test(reqUrl)) return { ok: false, reason: 'control character or space in the path' };
  if (ENCODED_SEPARATOR.test(reqUrl)) return { ok: false, reason: 'encoded ".", "/", "\\" or "%" in the path' };
  const q = reqUrl.search(/[?#]/);
  const rawPath = q < 0 ? reqUrl : reqUrl.slice(0, q);
  if (reqUrl.includes('#')) return { ok: false, reason: 'fragment in the request' };
  const segs = rawPath.split('/').slice(1);
  if (segs.some((s) => s === '.' || s === '..')) return { ok: false, reason: 'dot segment in the path' };
  if (segs.slice(0, -1).some((s) => s === '')) return { ok: false, reason: 'empty segment in the path' };
  let origin: URL;
  try {
    origin = new URL(route.origin);
  } catch {
    return { ok: false, reason: 'bad route origin' };
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return { ok: false, reason: 'route origin is not http(s)' };
  let url: URL;
  try {
    url = new URL(reqUrl, origin.origin);
  } catch {
    return { ok: false, reason: 'unparsable path' };
  }
  // checked on the URL as built, not on the string
  if (url.origin !== origin.origin) return { ok: false, reason: 'another origin' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL' };
  if (url.pathname !== rawPath) return { ok: false, reason: 'the path changed when normalised' };
  const base = route.basePath === '/' || route.basePath === '' ? '' : route.basePath.replace(/\/+$/, '');
  if (base && !base.startsWith('/')) return { ok: false, reason: 'bad route base path' };
  if (base && url.pathname !== base && !url.pathname.startsWith(base + '/')) return { ok: false, reason: `only ${base} is forwarded` };
  const rel = url.pathname.slice(base.length) || '/';
  if (allowPaths && !allowPaths.some((re) => re.test(rel))) return { ok: false, reason: `${rel} is not a model API path` };
  return { ok: true, url };
}
