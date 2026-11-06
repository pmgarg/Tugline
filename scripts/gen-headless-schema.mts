// Regenerates docs/schemas/headless-output.schema.json from src/cli/output.ts (v1.2 N49 AC2).
import fs from 'node:fs';
import { headlessJsonSchema } from '../src/cli/output.js';
fs.writeFileSync('docs/schemas/headless-output.schema.json', JSON.stringify(headlessJsonSchema(), null, 2) + '\n');
console.log('wrote docs/schemas/headless-output.schema.json');
