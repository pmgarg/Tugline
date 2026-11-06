/**
 * R1: files the harness itself writes into the workspace on its own (outside a
 * tool result that names them), e.g. the remember tool's `.tugline/MEMORY.md`.
 * The protected-path guard adopts a recorded write (same content) instead of
 * restoring it. Kept dependency-free so any module can call it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const harnessWrites = new Map<string, string>();

export function noteHarnessWrite(absPath: string): void {
  try {
    harnessWrites.set(path.resolve(absPath), crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex'));
  } catch {
    /* nothing written */
  }
}
