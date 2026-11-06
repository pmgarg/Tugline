/**
 * `tug browser-extension` (SPEC v1.1 N29): pairing for the real-browser extension.
 *
 *   tug browser-extension pair [--rotate]   print the URL and pairing token to paste into the extension's options
 *   tug browser-extension path              print the folder to load with chrome://extensions → Load unpacked
 *
 * The token lives in ~/.tugline/browser-extension.json (mode 0600). It only
 * lets the extension offer tabs the user shares; it is not the `tug serve` token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCliCommand } from '../../../commands.js';
import { EXTENSION_PATH, pairingFile, pairingToken } from './hub.js';

export function extensionDir(): string {
  // src/core/automation/browser/extension → repo root (also dist/… in a build).
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const c = path.join(d, 'browser-extension', 'manifest.json');
    if (fs.existsSync(c)) return path.dirname(c);
    d = path.dirname(d);
  }
  return path.resolve('browser-extension');
}

registerCliCommand({
  name: 'browser-extension',
  description: 'pair the Tugline browser extension (real-browser tabs you share) with tug serve',
  usage: 'pair [--rotate] | path',
  needsModel: false,
  async run(argv, ctx) {
    const sub = argv[0] ?? 'pair';
    if (sub === 'path') {
      ctx.write(`${extensionDir()}\n`);
      return 0;
    }
    if (sub !== 'pair') {
      ctx.write('usage: tug browser-extension pair [--rotate] | path\n');
      return 2;
    }
    const token = pairingToken(ctx.config.homeDir, { create: true, rotate: argv.includes('--rotate') })!;
    const port = (ctx.config as any).server?.port ?? 7878;
    ctx.write(
      [
        `1. Load the extension: chrome://extensions → Developer mode → Load unpacked → ${extensionDir()}`,
        `2. In its options page, paste:`,
        `     Server URL     ws://127.0.0.1:${port}${EXTENSION_PATH}`,
        `     Pairing token  ${token}`,
        `   and list the sites the agent may use (they must also be in browser.attachedAllowDomains).`,
        `3. Run \`tug serve\`, set browser.extensionEnabled: true, and click the toolbar button on a tab to share it.`,
        `(token stored in ${pairingFile(ctx.config.homeDir)}; --rotate makes a new one and unpairs the old)`,
        '',
      ].join('\n'),
    );
    return 0;
  },
});
