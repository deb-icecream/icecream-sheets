/**
 * Generates test-data/gold/functions.xlsx — comprehensive per-function
 * coverage of all 393 HyperFormula functions — plus
 * test-data/gold/functions-expected.json.
 *
 * Each entry: exact expected value (computed in plain JS, no HyperFormula)
 * or a smoke assertion (evaluates without #NAME?).
 *
 * Run: node samples/generate-golden.mjs
 */
import * as XLSX from '../node_modules/xlsx/xlsx.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WAVE2 } from './wave2.mjs';
import { WAVE3 } from './wave3.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-data', 'gold');
mkdirSync(root, { recursive: true });

// date serial (1900 system): days since 1899-12-30
const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

const T = []; // {sheet, addr, formula, exp}
const V = (v) => ({ value: v });
const E = (code) => ({ error: code });
const S = (type) => ({ smoke: true, type }); // evaluates, no #NAME?

function add(sheet, addr, formula, exp) { T.push({ sheet, addr, formula, exp }); }

let row = 1;
function seq(sheet, items) {
  for (const [formula, exp] of items) add(sheet, `B${row}`, formula, exp), row++;
  row++;
}

// ---------- MATH ----------
{
  const sh = 'Math'; row = 1;
  const P = Math.PI;
  seq(sh, [
    ['ABS(-5)', V(5)], ['ABS(5)', V(5)],
    ['ACOS(0.5)', V(Math.acos(0.5))], ['ACOSH(2)', V(Math.acosh(2))],
    ['ASIN(0.5)', V(Math.asin(0.5))], ['ASINH(2)', V(Math.asinh(2))],
    ['ATAN(1)', V(Math.atan(1))], ['ATAN2(1,1)', V(Math.atan2(1, 1))],
    ['ATANH(0.5)', V(Math.atanh(0.5))],
    ['COS(1)', V(Math.cos(1))], ['COSH(1)', V(Math.cosh(1))],
    ['SIN(1)', V(Math.sin(1))], ['SINH(1)', V(Math.sinh(1))],
    ['TAN(1)', V(Math.tan(1))], ['TAN(1)', V(Math.tan(1))],
    ['DEGREES(3.14159265358979)', V(180)], ['RADIANS(180)', V(P)],
    ['EXP(1)', V(Math.E)], ['LN(2.71828182845905)', V(1)],
    ['LOG(100,10)', V(2)], ['LOG10(1000)', V(3)],
    ['PI()', V(P)], ['POWER(2,8)', V(256)], ['SQRT(16)', V(4)],
    ['INT(7.9)', V(7)], ['INT(-7.1)', V(-8)],
    ['TRUNC(7.9)', V(7)], ['TRUNC(-7.9)', V(-7)],
    ['ROUND(3.14159,2)', V(3.14)], ['ROUNDDOWN(3.99,1)', V(3.9)],
    ['ROUNDUP(3.11,1)', V(3.2)],
    ['CEILING(4.2,1)', V(5)], ['FLOOR(4.9,1)', V(4)],
    ['EVEN(3)', V(4)], ['ODD(3)', V(3)], ['EVEN(4)', V(4)],
    ['MOD(10,3)', V(1)], ['MOD(-10,3)', V(2)],
    ['QUOTIENT(10,3)', V(3)], ['PRODUCT(2,3,4)', V(24)],
    ['SUMSQ(3,4)', V(25)], ['FACT(5)', V(120)],
    ['GCD(12,18)', V(6)], ['LCM(4,6)', V(12)],
    ['COMBIN(5,2)', V(10)],
    ['SIGN(-5)', V(-1)], ['SIGN(0)', V(0)], ['SIGN(5)', V(1)],
    ['ARABIC("XIV")', V(14)], ['ROMAN(14)', V('XIV')],
    ['BASE(255,16)', V('FF')], ['DECIMAL("FF",16)', V(255)],
  ]);
  // RAND/RANDBETWEEN: smoke (nondeterministic) — check numeric type
  seq(sh, [
    ['RAND()', S('number')], ['RANDBETWEEN(1,10)', S('number')],
  ]);
}
// ---------- STATS ----------
{
  const sh = 'Stats';
  // data in A1:A5 via generator below (literals)
  seq(sh, [
    ['SUM(A1:A5)', V(75)], ['AVERAGE(A1:A5)', V(15)],
    ['COUNT(A1:A5)', V(5)], ['COUNTA(A1:A5)', V(5)],
    ['MAX(A1:A5)', V(25)], ['MIN(A1:A5)', V(5)],
    ['LARGE(A1:A5,2)', V(20)], ['SMALL(A1:A5,2)', V(10)],
    ['MEDIAN(A1:A5)', V(15)],
    ['SUMIF(A1:A5,">10")', V(60)], ['COUNTIF(A1:A5,">10")', V(3)],
    ['AVERAGEIF(A1:A5,">10")', V(20)],
    ['STDEVP(A1:A5)', V(Math.sqrt(50))],
    ['VARP(A1:A5)', V(50)],
  ]);
}
// ---------- TEXT ----------
{
  const sh = 'Text'; row = 1;
  seq(sh, [
    ['CHAR(65)', V('A')], ['CODE("A")', V(65)],
    ['CONCATENATE("a","b","c")', V('abc')], ['CONCAT("a","b","c")', V('abc')],
    ['EXACT("a","a")', V(true)], ['EXACT("a","A")', V(false)],
    ['FIND("c","abcde")', V(3)], ['SEARCH("C","abcde")', V(3)],
    ['LEFT("hello",2)', V('he')], ['RIGHT("hello",2)', V('lo')],
    ['MID("hello",2,3)', V('ell')], ['LEN("hello")', V(5)],
    ['LOWER("ABC")', V('abc')], ['UPPER("abc")', V('ABC')],
    ['PROPER("hello world")', V('Hello World')],
    ['REPLACE("hello",2,3,"ELLO")', V('hELLOo')],
    ['REPT("ab",3)', V('ababab')],
    ['SUBSTITUTE("hello","l","L")', V('heLLo')],
    ['TRIM("  a  b  ")', V('a b')],
    ['VALUE("123")', V(123)], ['VALUE("12.5")', V(12.5)],
    ['T("x")', V('x')], ['T(5)', V('')],
    ['N("x")', V(0)], ['N(5)', V(5)], ['N(TRUE())', V(1)],
  ]);
}
// ---------- LOGICAL ----------
{
  const sh = 'Logic'; row = 1;
  seq(sh, [
    ['AND(TRUE(),TRUE())', V(true)], ['AND(TRUE(),FALSE())', V(false)],
    ['OR(FALSE(),TRUE())', V(true)], ['OR(FALSE(),FALSE())', V(false)],
    ['NOT(TRUE())', V(false)], ['NOT(FALSE())', V(true)],
    ['XOR(TRUE(),FALSE())', V(true)], ['XOR(TRUE(),TRUE())', V(false)],
    ['IF(TRUE(),"y","n")', V('y')], ['IF(FALSE(),"y","n")', V('n')],
    ['IFERROR(1/0,"oops")', V('oops')], ['IFERROR(5,"oops")', V(5)],
    ['IFNA(NA(),"na")', V('na')],
    ['TRUE()', V(true)], ['FALSE()', V(false)],
  ]);
}
// ---------- LOOKUP (data in A1:B4) ----------
{
  const sh = 'Lookup'; row = 1;
  seq(sh, [
    ['VLOOKUP("b",A1:C4,3,FALSE())', V(2)],
    ['VLOOKUP("c",A1:C4,3,FALSE())', V(3)],
    ['VLOOKUP("z",A1:C4,3,FALSE())', E('#N/A')],
    ['HLOOKUP("b",E1:H2,2,FALSE())', V(2)],
    ['INDEX(A1:A4,2)', V('b')],
    ['MATCH("c",A1:A4,0)', V(3)],
    ['CHOOSE(2,"a","b","c")', V('b')],
    ['COLUMN(B5)', V(2)], ['ROW(C7)', V(7)],
    ['COLUMNS(A1:C5)', V(3)], ['ROWS(A1:C5)', V(5)],
    ['ADDRESS(2,3)', V('$C$2')],
  ]);
}
// ---------- DATES ----------
{
  const sh = 'Dates'; row = 1;
  const s = serial(2026, 10, 17);
  seq(sh, [
    ['DATE(2026,10,17)', V(s)],
    ['YEAR(DATE(2026,10,17))', V(2026)],
    ['MONTH(DATE(2026,10,17))', V(10)],
    ['DAY(DATE(2026,10,17))', V(17)],
    ['DAYS(DATE(2026,10,20),DATE(2026,10,17))', V(3)],
    ['WEEKDAY(DATE(2026,10,17))', V(7)], // Saturday
    ['EOMONTH(DATE(2026,10,17),0)', V(serial(2026, 10, 31))],
    ['EDATE(DATE(2026,10,17),1)', V(serial(2026, 11, 17))],
    ['TIME(13,30,0)', V(13.5 / 24)],
    ['HOUR(TIME(13,30,15))', V(13)], ['MINUTE(TIME(13,30,15))', V(30)],
    ['SECOND(TIME(13,30,15))', V(15)],
    ['NOW()', S('number')], ['TODAY()', S('number')],
  ]);
}
// ---------- FINANCIAL ----------
{
  const sh = 'Finance'; row = 1;
  // PMT(rate,nper,pv): = -PMT(0.05/12, 60, 10000)
  const r = 0.05 / 12, n = 60, pv = 10000;
  const pmt = -(r * pv) / (1 - Math.pow(1 + r, -n));
  seq(sh, [
    ['PMT(0.05/12,60,10000)', V(pmt)],
    ['FV(0.05/12,60,-100)', V(100 * ((Math.pow(1 + r, n) - 1) / r))],
    ['PV(0.05/12,60,-100)', V(100 * (1 - Math.pow(1 + r, -n)) / r)],
    ['NPER(0.05/12,-100,10000)', V(Math.log(100 / (100 - 10000 * r)) / Math.log(1 + r))],
    ['SLN(10000,1000,5)', V(1800)],
    ['NPV(0.1,100,200,300)', V(100 / 1.1 + 200 / 1.21 + 300 / 1.331)],
  ]);
}
// ---------- INFO ----------
{
  const sh = 'Info'; row = 1;
  seq(sh, [
    ['ISNUMBER(5)', V(true)], ['ISNUMBER("x")', V(false)],
    ['ISTEXT("x")', V(true)], ['ISTEXT(5)', V(false)],
    ['ISBLANK(A100)', V(true)], ['ISBLANK(5)', V(false)],
    ['ISERROR(1/0)', V(true)], ['ISERROR(5)', V(false)],
    ['ISNA(NA())', V(true)], ['ISNA(5)', V(false)],
    ['ISLOGICAL(TRUE())', V(true)], ['ISNONTEXT("x")', V(false)],
    ['ISNONTEXT(5)', V(true)],
    ['ISEVEN(4)', V(true)], ['ISODD(3)', V(true)],
    ['NA()', E('#N/A')],
  ]);
}
// ---------- ENGINEERING ----------
{
  const sh = 'Eng'; row = 1;
  seq(sh, [
    ['BIN2DEC("1010")', V(10)], ['BIN2HEX("1010")', V('A')],
    ['BIN2OCT("1010")', V('12')],
    ['DEC2BIN(10)', V('1010')], ['DEC2HEX(255)', V('FF')],
    ['DEC2OCT(8)', V('10')], ['HEX2DEC("FF")', V(255)],
    ['BITAND(6,3)', V(2)], ['BITOR(6,3)', V(7)], ['BITXOR(6,3)', V(5)],
    ['BITLSHIFT(6,1)', V(12)], ['BITRSHIFT(6,1)', V(3)],
    ['DELTA(5,5)', V(1)], ['DELTA(5,6)', V(0)],
    ['GESTEP(5,4)', V(1)], ['GESTEP(3,4)', V(0)],
  ]);
}

// ---------- WAVE 2: smoke coverage for remaining functions ----------
{
  let r = 1;
  for (const [formula, type] of WAVE2) {
    add('More', `B${r}`, formula, type ? S(type) : S(null));
    r++;
  }
}

// ---------- WAVE 3: engine-implemented functions ----------
{
  let r = 1;
  for (const [formula, type] of WAVE3) {
    // XLOOKUP not-found without if_not_found expects #N/A; mark as error expectation
    if (formula === 'XLOOKUP("z",Lookup!A1:A4,Lookup!C1:C4)') {
      add('More3', `B${r}`, formula, E('#N/A'));
    } else {
      add('More3', `B${r}`, formula, type ? S(type) : S(null));
    }
    r++;
  }
}

console.log(`total test formulas: ${T.length}`);
writeFileSync(join(root, 'functions-plan.json'), JSON.stringify(T, null, 1));

// ---- build workbook ----
const wb = XLSX.utils.book_new();
const sheets = {};
function ws(name) {
  if (!sheets[name]) { sheets[name] = {}; XLSX.utils.book_append_sheet(wb, sheets[name], name); }
  return sheets[name];
}
// literals
{
  const s = ws('Stats');
  [5, 10, 15, 20, 25].forEach((v, i) => { s[`A${i + 1}`] = { t: 'n', v }; });
  s['!ref'] = 'A1:A5';
}
{
  const s = ws('Lookup');
  ['a', 'b', 'c', 'd'].forEach((v, i) => {
    s[`A${i + 1}`] = { t: 's', v }; s[`C${i + 1}`] = { t: 'n', v: i + 1 };
  });
  const keys = ['a', 'b', 'c', 'd'];
  keys.forEach((v, i) => {
    const c = String.fromCharCode(69 + i); // E..H
    s[`${c}1`] = { t: 's', v }; s[`${c}2`] = { t: 'n', v: i + 1 };
  });
  s['!ref'] = 'A1:H4';
}
{
  // Database test data for wave 3
  const s = ws('DbData');
  s['A1'] = { t: 's', v: 'Name' }; s['B1'] = { t: 's', v: 'Sales' };
  s['A2'] = { t: 's', v: 'a' }; s['B2'] = { t: 'n', v: 100 };
  s['A3'] = { t: 's', v: 'b' }; s['B3'] = { t: 'n', v: 200 };
  s['A4'] = { t: 's', v: 'a' }; s['B4'] = { t: 'n', v: 150 };
  s['!ref'] = 'A1:B4';
  const c = ws('DbCrit');
  c['A1'] = { t: 's', v: 'Name' };
  c['A2'] = { t: 's', v: 'a' };
  c['!ref'] = 'A1:A2';
}
// formulas: column B.. for each sheet (100 rows per column).
// Lookup keeps A,C,E:H for data, so its formulas start at I.
const formulaStartCol = { Lookup: 7 }; // offset from B: Lookup formulas start at I
const sheetIdx = {};
for (const t of T) {
  const w = ws(t.sheet);
  const idx = sheetIdx[t.sheet] || 0;
  sheetIdx[t.sheet] = idx + 1;
  const baseC = 1 + (formulaStartCol[t.sheet] || 0); // B=1 + offset
  const col = String.fromCharCode(65 + baseC + Math.floor(idx / 100));
  const r = (idx % 100) + 1;
  const addr = `${col}${r}`;
  w[addr] = { t: 'n', v: 0, f: t.formula };
  t.addr = addr;
}
// fix refs
for (const [name, w] of Object.entries(sheets)) {
  let maxR = 1, maxC = 1;
  for (const k of Object.keys(w)) {
    if (k[0] === '!') continue;
    const m = k.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const c = [...m[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
    maxC = Math.max(maxC, c); maxR = Math.max(maxR, +m[2]);
  }
  const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  w['!ref'] = `A1:${colName(maxC)}${maxR}`;
}

const outXlsx = join(root, 'functions.xlsx');
const outJson = join(root, 'functions-expected.json');
writeFileSync(outXlsx, Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
const exp = {};
for (const t of T) exp[`${t.sheet}!${t.addr}`] = t.exp;
writeFileSync(outJson, JSON.stringify(exp, null, 1));
console.log(`wrote ${outXlsx} (${T.length} formulas)`);
