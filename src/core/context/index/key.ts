/** Per-project index location shared by N2 (code search) and D7/R15 (repo-map cache). No imports from the index modules (keeps the module graph acyclic). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function projectKey(workspace: string): string {
  let real = path.resolve(workspace);
  try {
    real = fs.realpathSync(real);
  } catch {
    /* keep */
  }
  const base = path.basename(real).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root';
  return `${base}-${crypto.createHash('sha1').update(real).digest('hex').slice(0, 12)}`;
}

export function indexDir(homeDir: string, workspace: string): string {
  return path.join(homeDir, 'index', projectKey(workspace));
}
