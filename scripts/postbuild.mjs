import fs from 'node:fs';
import path from 'node:path';
const f = 'dist/cli/main.js';
if (fs.existsSync(f)) {
  try {
    fs.chmodSync(f, 0o755);
  } catch {
    // Some mounted or synced folders refuse chmod; `node dist/cli/main.js` still works.
  }
}
// WS6: the desktop sidecars (python / PowerShell) ship next to the compiled desktop module.
const sidecars = 'src/core/automation/desktop/sidecars';
const target = 'dist/core/automation/desktop/sidecars';
/**
 * Plain byte copy: no cpSync. On some mounted or synced folders cpSync fails with EACCES and leaves a broken
 * entry behind, while a plain read/write works everywhere. The sidecars are two small text files.
 */
function copyPlain(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyPlain(s, d);
    else if (e.isFile()) fs.writeFileSync(d, fs.readFileSync(s));
  }
}
if (fs.existsSync(sidecars)) copyPlain(sidecars, target);
