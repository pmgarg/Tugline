// evals/desktop setup (suite.json "setup"): nothing to serve; adds cascade path statistics to report.md
// (the same per-run table as the browser suite, from the `automation` events of desktop tools).
import path from 'node:path';
import { pathReport } from '../browser/setup.mjs';

export async function start() {
  return {
    vars: {},
    stop: async () => {},
    report: (outDir) => pathReport(path.join(outDir, 'runs')),
  };
}
