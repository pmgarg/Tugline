/**
 * WorkspaceHost backed by the ACP client's file system (SPEC G1 "fs delegation").
 * When the editor advertises fs.readTextFile / fs.writeTextFile, file tools read
 * the editor's view of a file (including unsaved changes) and write through the
 * editor, so edits show up in its buffers and undo history. Operations the
 * protocol does not cover (exists, delete) use the disk.
 *
 * This only changes where bytes come from: the permission engine has already
 * checked every path before a tool touches the host.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type * as acp from '@agentclientprotocol/sdk';
import { DiskHost, type HostText, type WorkspaceHost } from '../core/host/workspace.js';

export class AcpFsHost implements WorkspaceHost {
  readonly kind = 'acp';
  private disk = new DiskHost();
  /** Paths written through the client in this session (they may not be on disk yet). */
  private written = new Set<string>();

  constructor(private readonly conn: acp.AgentSideConnection, private readonly sessionId: () => string, private readonly caps: { read: boolean; write: boolean }) {}

  private version(text: string): string {
    return `acp:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
  }

  async readText(abs: string): Promise<HostText | undefined> {
    if (!this.caps.read) return this.disk.readText(abs);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return undefined;
    } catch {
      /* fall through to the client */
    }
    try {
      const r = await this.conn.readTextFile({ sessionId: this.sessionId(), path: abs });
      const text = r.content ?? '';
      const onDisk = await this.disk.readText(abs);
      return { text, version: this.version(text), dirty: onDisk ? onDisk.text !== text : true, eol: text.includes('\r\n') ? '\r\n' : '\n', utf8: true };
    } catch {
      // The client could not read it (missing file, or not a text file it knows): use the disk view.
      return this.disk.readText(abs);
    }
  }

  async writeText(abs: string, text: string): Promise<{ version: string }> {
    if (!this.caps.write) return this.disk.writeText(abs, text);
    await this.conn.writeTextFile({ sessionId: this.sessionId(), path: abs, content: text });
    this.written.add(abs);
    return { version: this.version(text) };
  }

  async exists(abs: string): Promise<boolean> {
    return this.written.has(abs) || this.disk.exists(abs);
  }

  async delete(abs: string): Promise<void> {
    this.written.delete(abs);
    await this.disk.delete(abs);
  }
}
