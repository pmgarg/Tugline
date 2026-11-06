/**
 * Tool providers (SPEC S0.2). Workstreams contribute tools by registering a
 * provider from their own module and adding one import line to providers.ts.
 */
import type { HarnessConfig } from '../config.js';
import type { ToolDef } from './types.js';

export interface ProviderEnv {
  workspace: string;
  homeDir: string;
  /** Agent depth: 0 = main agent, 1 = subagent */
  depth: number;
  /** v1.2 N46 (review F11): the host answers code navigation itself (VS Code's language features) */
  hostNavigates?: boolean;
}

export interface ToolProvider {
  id: string;
  tools(cfg: HarnessConfig, env: ProviderEnv): ToolDef[] | Promise<ToolDef[]>;
}

const providers = new Map<string, ToolProvider>();

export function registerToolProvider(p: ToolProvider): void {
  providers.set(p.id, p);
}

export function unregisterToolProvider(id: string): void {
  providers.delete(id);
}

export function toolProviders(): ToolProvider[] {
  return [...providers.values()];
}

/** Collect tools from all registered providers; a failing provider is reported, not fatal. */
export async function providerTools(cfg: HarnessConfig, env: ProviderEnv, onError?: (id: string, e: Error) => void): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const p of providers.values()) {
    try {
      out.push(...(await p.tools(cfg, env)));
    } catch (e) {
      onError?.(p.id, e as Error);
    }
  }
  return out;
}
