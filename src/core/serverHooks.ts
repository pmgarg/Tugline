/**
 * `tug serve` extension points that live in core, so a core module can mount a
 * WebSocket route on the server port without the server importing it (seam,
 * v1.1). Used by the browser extension hub (N29) at `/browser-extension`.
 *
 * The server checks that the Host header is loopback before calling a handler;
 * the handler does its own Origin and token checks.
 */
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { HarnessConfig } from './config.js';

export interface UpgradeContext {
  port: number;
  config: HarnessConfig;
}

export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer, ctx: UpgradeContext) => boolean;

const handlers = new Map<string, UpgradeHandler>();

export function registerUpgradeHandler(pathname: string, fn: UpgradeHandler): void {
  handlers.set(pathname, fn);
}

export function upgradeHandlerFor(url: string | undefined): UpgradeHandler | undefined {
  if (!url) return undefined;
  const p = url.split('?')[0];
  return handlers.get(p);
}

/**
 * v1.2 F12: JSON-RPC methods a core module adds to `tug serve` (e.g. A2A inbound). `auth: 'owner'` methods need the
 * server token; `auth: 'self'` methods are callable before `auth` and MUST authenticate their own credential (a
 * grant secret) and reach nothing else. Every other method stays behind the normal auth gate.
 */
export interface RpcMethodContext {
  config: HarnessConfig;
  principal?: string;
  /** the connection's peer address (rate limits per source) */
  source?: string;
  /** aborted when the connection closes (long work stops with its caller) */
  signal?: AbortSignal;
  /** an `auth: 'self'` method calls this once its credential checked out: the connection is then exempt from the pre-auth timeout */
  verified?: () => void;
}
export interface RpcMethod {
  auth: 'owner' | 'self';
  run: (params: any, ctx: RpcMethodContext) => unknown;
}
const rpc = new Map<string, RpcMethod>();
export function registerRpcMethod(name: string, m: RpcMethod): void {
  rpc.set(name, m);
}
export function rpcMethods(): ReadonlyMap<string, RpcMethod> {
  return rpc;
}
