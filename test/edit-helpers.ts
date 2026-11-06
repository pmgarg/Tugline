/** Shared helpers for the WS1 edit tests (not a test file itself). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadLedger, type ToolContext } from '../src/core/tools/types.js';
import { defaultConfig, deepMerge } from '../src/core/config.js';

/** A ToolContext for calling file tools directly; `events` collects emitted events. */
export function editCtx(ws: string, over: Partial<ToolContext> & { cfg?: any } = {}): ToolContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-edit-home-'));
  const config = deepMerge(defaultConfig(), deepMerge({ homeDir: home }, over.cfg ?? {}));
  const events: any[] = [];
  return {
    workspace: ws,
    config,
    ledger: new ReadLedger(),
    signal: new AbortController().signal,
    llm: { profile: { model: 'test-model' } },
    emit: (e: any) => events.push(e),
    events,
    ...over,
  } as unknown as ToolContext;
}

