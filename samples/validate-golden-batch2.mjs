/**
 * Validate golden batch 2 against the engine (uses XlsxAdapter like the main validator).
 */
import { readFileSync } from 'node:fs';

const expected = JSON.parse(readFileSync('test-data/gold/functions-batch2-expected.json', 'utf8'));
const { EngineWorkbook } = await import('../packages/engine/dist/index.js');
const { XlsxAdapter } = await import('../packages/xlsx-adapter/dist/index.js');

const adapter = new XlsxAdapter();
const data = adapter.read(new Uint8Array(readFileSync('test-data/gold/functions-batch2.xlsx')));
const initial = {};
for (const sheet of data.sheets) initial[sheet.name] = sheet.rows;
const wb = new EngineWorkbook(initial);

let pass = 0, fail = 0;
const failures = [];

for (const [key, exp] of Object.entries(expected)) {
  const [sheet, a1] = key.split('!');
  // Parse A1: e.g., "B12"
  const m = a1.match(/^([A-Z]+)(\d+)$/);
  const col = m[1].split('').reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const row = parseInt(m[2]) - 1;
  const v = wb.getValue({ sheet, row, col });
  const actual = v.kind === 'error' ? { error: v.code } : v.value;
  
  let ok = false;
  if (exp && typeof exp === 'object' && 'approx' in exp) {
    ok = typeof actual === 'number' && Math.abs(actual - exp.approx) < exp.tol;
  } else if (exp && typeof exp === 'object' && 'error' in exp) {
    ok = v.kind === 'error' && v.code === exp.error;
  } else {
    ok = actual === exp || (typeof actual === 'number' && typeof exp === 'number' && Math.abs(actual - exp) < 0.001);
  }
  
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${key}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(actual)}`);
  }
}

console.log(`\n${pass}/${pass + fail} pass`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  ' + f));
}
