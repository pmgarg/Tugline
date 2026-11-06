// Edit-drift micro-benchmark (SPEC A1 AC1). Run: npx tsx scripts/edit-bench.mts
// A case counts as APPLIED only when the matcher applies it AND the result is
// byte-exact; the two genuine ambiguities must be REFUSED as not found.
import { applyEdit, EditMatchError } from '../src/core/edit/match.ts';
import { BENCH_CASES, BENCH_FILE } from '../src/core/edit/benchCases.ts';

let applied = 0;
let correct = 0;
for (const c of BENCH_CASES) {
  try {
    const r = applyEdit(BENCH_FILE, c.anchor, c.replacement, { file: 'svc.py' });
    applied++;
    const exact = r.updated === c.expected;
    if (c.shouldApply && exact) correct++;
    console.log(`APPLIED  ${c.name}  [tier: ${r.tiers.join('+')}]${exact ? '' : c.shouldApply ? '  WRONG BYTES' : '  SHOULD HAVE BEEN REFUSED'}`);
  } catch (e) {
    const reason = e instanceof EditMatchError ? e.fail.reason : (e as Error).message;
    if (!c.shouldApply && reason === 'not_found') correct++;
    console.log(`REFUSED  ${c.name}  [${reason}]${c.shouldApply ? '  SHOULD HAVE APPLIED' : ''}`);
  }
}
console.log(`${applied}/${BENCH_CASES.length} applied; ${correct}/${BENCH_CASES.length} correct (8 must apply byte-exact, 2 ambiguities refused)`);
if (correct !== BENCH_CASES.length) process.exitCode = 1;
