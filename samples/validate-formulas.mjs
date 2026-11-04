/**
 * Validates samples/formulas-sample.xlsx end-to-end:
 *   xlsx bytes -> XlsxAdapter.read -> EngineWorkbook -> recalc -> compare
 * against samples/formulas-expected.json (independently computed).
 *
 * Run: node samples/validate-formulas.mjs
 * Exit 0 = all green; exit 1 = mismatches (listed).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '../packages/xlsx-adapter/dist/index.js';
import { EngineWorkbook } from '../packages/engine/dist/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const adapter = new XlsxAdapter();
const data = adapter.read(new Uint8Array(readFileSync(join(root, 'formulas-sample.xlsx'))));
const expected = JSON.parse(readFileSync(join(root, 'formulas-expected.json'), 'utf8'));

const initial = {};
for (const sheet of data.sheets) initial[sheet.name] = sheet.rows;
const wb = new EngineWorkbook(initial);

function a1(addr) {
  const m = addr.match(/^([A-Z]+)(\d+)$/);
  const col = [...m[1]].reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  return { row: parseInt(m[2], 10) - 1, col };
}

let pass = 0;
const failures = [];
for (const [key, exp] of Object.entries(expected)) {
  const [sheet, addr] = key.split('!');
  const { row, col } = a1(addr);
  const got = wb.getValue({ sheet, row, col });
  let ok = false;
  if ('error' in exp) {
    ok = got.kind === 'error' && got.code === exp.error;
  } else if (typeof exp.value === 'number') {
    ok = got.kind === 'number' && Math.abs(got.value - exp.value) < 1e-9;
  } else if (typeof exp.value === 'string') {
    ok = got.kind === 'string' && got.value === exp.value;
  } else if (typeof exp.value === 'boolean') {
    ok = got.kind === 'boolean' && got.value === exp.value;
  }
  if (ok) pass++;
  else failures.push({ key, expected: exp, got });
}

console.log(`${pass}/${pass + failures.length} formulas correct`);
for (const f of failures) {
  console.log(`FAIL ${f.key}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.got)}`);
}
process.exit(failures.length ? 1 : 0);
