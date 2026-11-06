/**
 * v1.2 N49 (review F13, Cline "certificate trust"): the CLI trusts the operating system's certificate store in
 * addition to Node's bundled roots and NODE_EXTRA_CA_CERTS, so it works behind TLS-inspecting corporate proxies and
 * with internal endpoints. On by default; `--no-system-ca` or `cli.systemCa: false` turns it off. Uses Node's own
 * store reader (tls.getCACertificates('system')), so no certificate file is written.
 */
import tls from 'node:tls';

export interface SystemCaResult {
  applied: boolean;
  system: number;
  total: number;
  reason?: string;
}

type TlsCa = typeof tls & { getCACertificates?: (kind?: 'default' | 'system' | 'bundled' | 'extra') => string[]; setDefaultCACertificates?: (certs: string[]) => void };

export function applySystemCa(enabled: boolean, t: TlsCa = tls as TlsCa): SystemCaResult {
  if (!enabled) return { applied: false, system: 0, total: 0, reason: 'turned off (--no-system-ca / cli.systemCa: false)' };
  if (typeof t.getCACertificates !== 'function' || typeof t.setDefaultCACertificates !== 'function') return { applied: false, system: 0, total: 0, reason: `this Node.js (${process.version}) cannot read the system store; set NODE_EXTRA_CA_CERTS` };
  let system: string[] = [];
  try {
    system = t.getCACertificates('system');
  } catch (e) {
    return { applied: false, system: 0, total: 0, reason: `the system store could not be read: ${(e as Error).message}` };
  }
  const base = t.getCACertificates('default'); // bundled + NODE_EXTRA_CA_CERTS (merged, never replaced)
  const all = [...new Set([...base, ...system])];
  t.setDefaultCACertificates(all);
  return { applied: true, system: system.length, total: all.length };
}

/** RC7: one line for `tug doctor`: whether the OS certificate store is trusted, and why not. */
export function describeSystemCa(r: SystemCaResult): string {
  return r.applied ? `OS certificate store trusted (${r.system} system root(s); ${r.total} in all, with the bundled roots${process.env.NODE_EXTRA_CA_CERTS ? ' and NODE_EXTRA_CA_CERTS' : ''})` : `OS certificate store NOT trusted: ${r.reason ?? 'unknown'}`;
}
