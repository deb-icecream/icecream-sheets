/**
 * Validates test-data/gold/functions.xlsx against functions-expected.json.
 * Run from repo root: node samples/validate-golden.mjs
 */
import * as XLSX from '../node_modules/xlsx/xlsx.mjs';
import { XlsxAdapter } from '../packages/xlsx-adapter/dist/index.js';
import { EngineWorkbook } from '../packages/engine/dist/index.js';
import { readFileSync } from 'node:fs';

const EPS = 1e-9;
const close = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b)));

const adapter = new XlsxAdapter();
const data = adapter.read(new Uint8Array(readFileSync('test-data/gold/functions.xlsx')));
const initial = {};
for (const sheet of data.sheets) initial[sheet.name] = sheet.rows;
const wb = new EngineWorkbook(initial);
const expected = JSON.parse(readFileSync('test-data/gold/functions-expected.json', 'utf8'));

let pass = 0, fail = 0;
const failures = [];
const smokeFails = [];
for (const [key, exp] of Object.entries(expected)) {
  const [sheet, addr] = key.split('!');
  const m = addr.match(/^([A-Z]+)(\d+)$/);
  const col = [...m[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const row = +m[2] - 1;
  const got = wb.getValue({ sheet, row, col });
  const gk = got?.kind;

  if (exp.smoke) {
    const ok = gk !== 'error' || got.code !== '#NAME?';
    const typeOk = !ok ? true : (exp.type === 'number' ? gk === 'number' : exp.type === 'string' ? gk === 'string' : true);
    if (ok && typeOk) { pass++; continue; }
    fail++;
    smokeFails.push(`${key}: ${JSON.stringify(got)} (expected smoke ${exp.type})`);
    continue;
  }
  let ok = false;
  if ('value' in exp) {
    const ev = exp.value;
    ok = gk === 'number' && typeof ev === 'number' ? close(got.value, ev)
      : gk === 'string' && typeof ev === 'string' ? got.value === ev
      : gk === 'boolean' && typeof ev === 'boolean' ? got.value === ev
      : false;
  } else if ('error' in exp) {
    ok = gk === 'error' && got.code === exp.error;
  }
  if (ok) pass++;
  else { fail++; failures.push(`${key}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)}`); }
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach(f => console.log(' ', f)); }
if (smokeFails.length) { console.log('\nSMOKE FAILURES:'); smokeFails.forEach(f => console.log(' ', f)); }
process.exit(fail ? 1 : 0);
