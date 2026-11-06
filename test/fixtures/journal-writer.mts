// R6 regression helper: one process appending N records to a shared session journal.
import { Journal } from '../../src/core/agent/journal.ts';
const [home, ws, n] = process.argv.slice(2);
const j = new Journal(home!, ws!, 'shared-session');
for (let i = 0; i < Number(n); i++) j.write({ type: 'w', pid: process.pid, i });
