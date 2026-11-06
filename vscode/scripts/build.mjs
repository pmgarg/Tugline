import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode', 'playwright', 'playwright-core'],
  sourcemap: true,
  logLevel: 'info',
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
});
// Third-party notices travel with the extension (Apache-2.0 derived code, Codicons)
fs.copyFileSync(path.join('..', 'NOTICE'), 'NOTICE');
// VS Code's icon font for the webviews (MIT code, CC-BY-4.0 font; see THIRD_PARTY.md)
{
  const src = path.join('node_modules', '@vscode', 'codicons', 'dist');
  const dst = path.join('media', 'codicons');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  for (const f of ['LICENSE', 'LICENSE-CODE']) fs.copyFileSync(path.join(src, '..', f), path.join(dst, f));
}
// Ship bundled skills and agents with the extension
for (const d of ['skills', 'agents']) {
  const src = path.join('..', d);
  const dst = path.join('resources', d);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}
// Optional tree-sitter runtime + grammars (WS1 G6): ~7.6 MB unpacked, ~1 MB in the
// vsix. Same grammar list as BUNDLED_GRAMMARS in src/core/edit/treesitter.ts.
// Skipped (with a note) when the optional packages are not installed.
const TS_GRAMMARS = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'css', 'html', 'yaml', 'bash'];
const tsDst = path.join('resources', 'tree-sitter');
fs.rmSync(tsDst, { recursive: true, force: true });
try {
  const req = createRequire(path.resolve('..', 'package.json'));
  const pkgDir = (p) => path.dirname(req.resolve(`${p}/package.json`, { paths: [path.resolve('..')] }));
  const rtDir = path.dirname(req.resolve('web-tree-sitter'));
  const grammarDirs = [['@vscode/tree-sitter-wasm', 'wasm'], ['tree-sitter-html', ''], ['@tree-sitter-grammars/tree-sitter-yaml', '']].map(([p, sub]) => {
    try {
      return { pkg: p, dir: path.join(pkgDir(p), sub), root: pkgDir(p) };
    } catch {
      return undefined;
    }
  }).filter(Boolean);
  fs.mkdirSync(path.join(tsDst, 'licenses'), { recursive: true });
  for (const f of ['web-tree-sitter.cjs', 'web-tree-sitter.wasm']) fs.copyFileSync(path.join(rtDir, f), path.join(tsDst, f));
  fs.copyFileSync(path.join(rtDir, 'LICENSE'), path.join(tsDst, 'licenses', 'web-tree-sitter.LICENSE'));
  const missing = [];
  for (const g of TS_GRAMMARS) {
    const from = grammarDirs.find((d) => fs.existsSync(path.join(d.dir, `tree-sitter-${g}.wasm`)));
    if (!from) {
      missing.push(g);
      continue;
    }
    fs.copyFileSync(path.join(from.dir, `tree-sitter-${g}.wasm`), path.join(tsDst, `tree-sitter-${g}.wasm`));
    const lic = path.join(from.root, 'LICENSE');
    if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(tsDst, 'licenses', `${from.pkg.replace(/[@/]/g, '_')}.LICENSE`));
  }
  console.log(`bundled tree-sitter (${TS_GRAMMARS.length - missing.length} grammars${missing.length ? `; missing: ${missing.join(', ')}` : ''})`);
} catch (e) {
  fs.rmSync(tsDst, { recursive: true, force: true });
  console.log(`tree-sitter not bundled (optional packages not installed: ${e.message.split('\n')[0]}); the extension uses regex/compiler fallbacks`);
}
fs.copyFileSync('../LICENSE', 'LICENSE');
console.log('built dist/extension.js + resources/');
