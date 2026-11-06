/**
 * MCP registry search (SPEC G3): the official registry API,
 * `GET https://registry.modelcontextprotocol.io/v0/servers?search=<q>`.
 *
 * Results are only shown to the user, with a suggested config entry; nothing is
 * installed or started from a search. Registry text is third-party content, so
 * it is length-capped and stripped of control characters before printing.
 */
import type { McpServerConfig } from '../config.js';

export const DEFAULT_REGISTRY = 'https://registry.modelcontextprotocol.io';

export interface RegistryServer {
  name: string;
  description: string;
  version?: string;
  repository?: string;
  /** Suggested `mcpServers` entry, when the registry entry has an npm/pypi package or a remote URL. */
  suggested?: McpServerConfig;
}

function clean(s: unknown, max = 300): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u001b]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function suggest(server: any): McpServerConfig | undefined {
  const remote = (server?.remotes ?? []).find((r: any) => typeof r?.url === 'string' && /^https:\/\//.test(r.url));
  if (remote) return { url: remote.url };
  for (const p of server?.packages ?? []) {
    const id = p?.identifier ?? p?.name;
    if (typeof id !== 'string' || !/^[@A-Za-z0-9._/-]+$/.test(id)) continue;
    const reg = String(p?.registryType ?? p?.registry_name ?? p?.registry_type ?? '').toLowerCase();
    const ver = typeof p?.version === 'string' && /^[\w.+-]+$/.test(p.version) ? p.version : undefined;
    if (reg === 'npm') return { command: 'npx', args: ['-y', ver ? `${id}@${ver}` : id] };
    if (reg === 'pypi') return { command: 'uvx', args: [ver ? `${id}==${ver}` : id] };
    if (reg === 'oci' || reg === 'docker') return { command: 'docker', args: ['run', '-i', '--rm', ver ? `${id}:${ver}` : id] };
  }
  return undefined;
}

export async function searchRegistry(query: string, opts: { fetchFn?: typeof fetch; baseUrl?: string; limit?: number; signal?: AbortSignal } = {}): Promise<RegistryServer[]> {
  const base = (opts.baseUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)) throw new Error('the MCP registry URL must be https');
  const url = `${base}/v0/servers?search=${encodeURIComponent(query)}&limit=${Math.max(1, Math.min(opts.limit ?? 20, 100))}`;
  const res = await (opts.fetchFn ?? fetch)(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
  if (!res.ok) throw new Error(`MCP registry returned HTTP ${res.status}`);
  const body: any = await res.json();
  const items: any[] = Array.isArray(body?.servers) ? body.servers : [];
  const out: RegistryServer[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const s = item?.server ?? item; // v0 wraps each entry as {server, _meta}
    const name = clean(s?.name, 200);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: clean(s?.description), version: s?.version ? clean(s.version, 40) : undefined, repository: s?.repository?.url ? clean(s.repository.url, 200) : undefined, suggested: suggest(s) });
  }
  return out;
}

export function formatRegistryResults(list: RegistryServer[]): string {
  if (!list.length) return 'No servers found.';
  return list
    .map((s) => {
      const lines = [`${s.name}${s.version ? ` ${s.version}` : ''}`, `  ${s.description || '(no description)'}`];
      if (s.repository) lines.push(`  repo: ${s.repository}`);
      if (s.suggested) lines.push(`  config: "${s.name.split('/').pop()}": ${JSON.stringify(s.suggested)}`);
      return lines.join('\n');
    })
    .join('\n');
}
