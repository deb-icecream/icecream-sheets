/**
 * Generates samples/formulas-sample.xlsx — a validation workbook with ~45
 * formulas across 7 sheets — plus samples/formulas-expected.json with the
 * independently computed expected values (plain JS, no HyperFormula).
 *
 * Run: node samples/generate-formulas-sample.mjs
 */
import * as XLSX from '../node_modules/xlsx/xlsx.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)));
mkdirSync(root, { recursive: true });

const expected = {}; // "Sheet!A1" -> {value} | {error}
function cell(ws, addr, formula, exp) {
  // NOTE: SheetJS drops formula cells without a cached value, so a v:0
  // placeholder is required (it is recalculated on read; never trusted).
  ws[addr] = { t: 'n', v: 0, f: formula };
  expected[addr] = exp;
}
function lit(ws, addr, v) {
  ws[addr] = { t: typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's', v };
}
function ref(sheet, addr, ws) {
  const a = `${sheet}!${addr}`;
  ws['!ref'] = ws['!ref'];
  return a;
}

const wb = XLSX.utils.book_new();
const sheets = {};
function newSheet(name) {
  const ws = {};
  sheets[name] = ws;
  XLSX.utils.book_append_sheet(wb, ws, name);
  return ws;
}
const E = (sheet, addr, formula, exp) => {
  const ws = sheets[sheet];
  cell(ws, addr, formula, exp);
  expected[`${sheet}!${addr}`] = exp;
  delete expected[addr];
};

// ---- Math ----
{
  const ws = newSheet('Math');
  lit(ws, 'A1', 10); lit(ws, 'A2', 3);
  E('Math', 'B1', 'A1+A2', { value: 13 });
  E('Math', 'B2', 'A1-A2', { value: 7 });
  E('Math', 'B3', 'A1*A2', { value: 30 });
  E('Math', 'B4', 'A1/A2', { value: 10 / 3 });
  E('Math', 'B5', 'A1^A2', { value: 1000 });
  E('Math', 'B6', 'MOD(A1,A2)', { value: 1 });
  E('Math', 'B7', 'ABS(-42)', { value: 42 });
  E('Math', 'B8', 'ROUND(3.14159,2)', { value: 3.14 });
  E('Math', 'B9', 'SQRT(144)', { value: 12 });
  E('Math', 'B10', 'POWER(2,10)', { value: 1024 });
  E('Math', 'B11', 'INT(7.9)', { value: 7 });
  E('Math', 'B12', '2+3*4', { value: 14 });
  E('Math', 'B13', '(2+3)*4', { value: 20 });
  ws['!ref'] = 'A1:B13';
}
// ---- Stats ----
{
  const ws = newSheet('Stats');
  [5, 10, 15, 20, 25].forEach((v, i) => lit(ws, `A${i + 1}`, v));
  E('Stats', 'B1', 'SUM(A1:A5)', { value: 75 });
  E('Stats', 'B2', 'AVERAGE(A1:A5)', { value: 15 });
  E('Stats', 'B3', 'COUNT(A1:A5)', { value: 5 });
  E('Stats', 'B4', 'MIN(A1:A5)', { value: 5 });
  E('Stats', 'B5', 'MAX(A1:A5)', { value: 25 });
  E('Stats', 'B6', 'COUNTA(A1:A5)', { value: 5 });
  E('Stats', 'B7', 'SUM(A1:A5)/COUNT(A1:A5)', { value: 15 });
  ws['!ref'] = 'A1:B7';
}
// ---- Logic ----
{
  const ws = newSheet('Logic');
  lit(ws, 'A1', 100);
  E('Logic', 'B1', 'IF(A1>50,"big","small")', { value: 'big' });
  E('Logic', 'B2', 'IF(A1<50,"small",IF(A1<200,"medium","large"))', { value: 'medium' });
  E('Logic', 'B3', 'AND(A1>50,A1<200)', { value: true });
  E('Logic', 'B4', 'OR(A1<50,A1>200)', { value: false });
  E('Logic', 'B5', 'NOT(B4)', { value: true });
  E('Logic', 'B6', 'A1=100', { value: true });
  ws['!ref'] = 'A1:B6';
}
// ---- Text ----
{
  const ws = newSheet('Text');
  lit(ws, 'A1', 'Hello'); lit(ws, 'A2', 'World');
  E('Text', 'B1', 'A1&" "&A2', { value: 'Hello World' });
  E('Text', 'B2', 'CONCAT(A1,A2)', { value: 'HelloWorld' });
  E('Text', 'B3', 'LEFT(A1,3)', { value: 'Hel' });
  E('Text', 'B4', 'RIGHT(A2,3)', { value: 'rld' });
  E('Text', 'B5', 'MID("icecream",4,5)', { value: 'cream' });
  E('Text', 'B6', 'LEN("icecream")', { value: 8 });
  E('Text', 'B7', 'UPPER("ice")', { value: 'ICE' });
  E('Text', 'B8', 'LOWER("CREAM")', { value: 'cream' });
  E('Text', 'B9', 'TRIM("  spaced  ")', { value: 'spaced' });
  ws['!ref'] = 'A1:B9';
}
// ---- Lookup ----
{
  const ws = newSheet('Lookup');
  const rows = [['apple', 1.2], ['banana', 0.8], ['cherry', 2.5], ['date', 3.0]];
  rows.forEach(([p, pr], i) => { lit(ws, `A${i + 1}`, p); lit(ws, `B${i + 1}`, pr); });
  E('Lookup', 'C1', 'VLOOKUP("banana",A1:B4,2,FALSE())', { value: 0.8 });
  E('Lookup', 'C2', 'VLOOKUP("cherry",A1:B4,2,FALSE())', { value: 2.5 });
  E('Lookup', 'C3', 'VLOOKUP("fig",A1:B4,2,FALSE())', { error: '#N/A' });
  ws['!ref'] = 'A1:C4';
}
// ---- Dates ----
{
  const ws = newSheet('Dates');
  // Excel 1900 serial for 2026-10-17: days since 1899-12-30
  const serial = Math.round((Date.UTC(2026, 9, 17) - Date.UTC(1899, 11, 30)) / 86400000);
  E('Dates', 'A1', 'DATE(2026,10,17)', { value: serial });
  E('Dates', 'B1', 'YEAR(A1)', { value: 2026 });
  E('Dates', 'B2', 'MONTH(A1)', { value: 10 });
  E('Dates', 'B3', 'DAY(A1)', { value: 17 });
  ws['!ref'] = 'A1:B3';
}
// ---- Refs ----
{
  const ws = newSheet('Refs');
  lit(ws, 'A1', 42);
  E('Refs', 'B1', '$A$1*2', { value: 84 });
  E('Refs', 'C1', 'Math!B1+1', { value: 14 });
  ws['!ref'] = 'A1:C1';
}
// ---- Errors ----
{
  const ws = newSheet('Errors');
  E('Errors', 'A1', '1/0', { error: '#DIV/0!' });
  E('Errors', 'A2', 'VLOOKUP("zzz",Lookup!A1:B4,2,FALSE())', { error: '#N/A' });
  ws['!ref'] = 'A1:A2';
}

const outXlsx = join(root, 'formulas-sample.xlsx');
const outJson = join(root, 'formulas-expected.json');
writeFileSync(outXlsx, Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
writeFileSync(outJson, JSON.stringify(expected, null, 1));
const n = Object.keys(expected).length;
console.log(`wrote ${outXlsx} with ${n} validated formulas`);
