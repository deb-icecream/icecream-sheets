/**
 * Golden dataset wave 4: formulas for the 68 engine-implemented functions
 * (batches 1-5). Exact expectations computed in JS.
 */
import { writeFileSync } from 'fs';
import * as XLSX from 'xlsx';

const rows = [];
const expected = {}; // "Sheet!A1" -> expected value or {error: code}

// Helper to add a formula row
let rowNum = 1;
function add(sheet, formula, exp) {
  rows.push({ sheet, row: rowNum, formula, exp });
  rowNum++;
}

function setupData(ws, data) {
  // data: 2D array starting at A1
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r].length; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const v = data[r][c];
      ws[addr] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
    }
  }
}

// ============ Sheet: DbFuncs (database functions) ============
{
  const dbData = [
    ['Name', 'Age', 'Score'],
    ['a', 20, 80],
    ['b', 25, 90],
    ['c', 30, 85],
    ['d', 22, 88],
  ];
  const critData = [
    ['Name', 'Age', 'Score'],
    ['a', '', ''],
    ['b', '', ''],
  ];
  const ws = {};
  setupData(ws, dbData);
  // Criteria at A7
  for (let r = 0; r < critData.length; r++) {
    for (let c = 0; c < critData[r].length; c++) {
      const addr = XLSX.utils.encode_cell({ r: r + 6, c });
      const v = critData[r][c];
      ws[addr] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
    }
  }
  // Formulas start at row 10 (A10)
  const formulas = [
    ['=DSUM(A1:C5,"Score",A7:C9)', 170], // 80+90
    ['=DAVERAGE(A1:C5,"Score",A7:C9)', 85],
    ['=DCOUNT(A1:C5,"Score",A7:C9)', 2],
    ['=DCOUNTA(A1:C5,"Name",A7:C9)', 2],
    ['=DMAX(A1:C5,"Score",A7:C9)', 90],
    ['=DMIN(A1:C5,"Score",A7:C9)', 80],
    ['=DSTDEV(A1:C5,"Score",A7:C9)', Math.sqrt(50)], // sample stdev of [80,90]
    ['=DSTDEVP(A1:C5,"Score",A7:C9)', 5], // population stdev
    ['=DVAR(A1:C5,"Score",A7:C9)', 50],
    ['=DVARP(A1:C5,"Score",A7:C9)', 25],
    ['=DGET(A1:C5,"Score",A7:C8)', 80], // single criterion row matches 'a'
  ];
  formulas.forEach(([f, exp], i) => {
    const addr = XLSX.utils.encode_cell({ r: 9 + i, c: 0 });
    ws[addr] = { t: 'n', v: 0, f: f.slice(1) };
    expected[`DbFuncs!A${10 + i}`] = exp;
  });
  ws['!ref'] = 'A1:C20';
  var dbWs = ws;
}

// ============ Sheet: TextFuncs ============
{
  const ws = {};
  const formulas = [
    ['=NUMBERVALUE("1,234.56")', 1234.56],
    ['=TEXTBEFORE("a,b,c",",")', 'a'],
    ['=TEXTAFTER("a,b,c",",")', 'b,c'],
    ['=TEXTBEFORE("a,b,c",",",2)', 'a,b'],
    ['=ARRAYTOTEXT({1,"a"})', '1,a'],
    ['=VALUETOTEXT(42)', '42'],
    ['=REGEXTEST("abc123","[0-9]+")', true],
    ['=REGEXEXTRACT("abc123","[0-9]+")', '123'],
    ['=REGEXREPLACE("abc123","[0-9]+","XYZ")', 'abcXYZ'],
  ];
  formulas.forEach(([f, exp], i) => {
    const addr = XLSX.utils.encode_cell({ r: i, c: 0 });
    ws[addr] = { t: 'n', v: 0, f: f.slice(1) };
    expected[`TextFuncs!A${i + 1}`] = exp;
  });
  ws['!ref'] = 'A1:A10';
  var textWs = ws;
}

// ============ Sheet: StatsFuncs ============
{
  const ws = {};
  // Data in A1:A8
  const data = [10, 20, 20, 30, 40, 50, 60, 70];
  data.forEach((v, i) => {
    ws[XLSX.utils.encode_cell({ r: i, c: 0 })] = { t: 'n', v };
  });
  const formulas = [
    ['=MODE.SNGL(A1:A8)', 20],
    ['=MODE(A1:A8)', 20],
    ['=PERCENTILE.INC(A1:A8,0.5)', 35],
    ['=PERCENTILE(A1:A8,0.5)', 35],
    ['=QUARTILE.INC(A1:A8,2)', 35],
    ['=TRIMMEAN(A1:A8,0.25)', 37.5], // trim 1 each end: mean(20,20,30,40,50,60)=36.67? recalc below
    ['=RANK.AVG(20,A1:A8,0)', 6.5],
    ['=RANK(30,A1:A8,0)', 5],
    // Excel-correct value is 3/7 ≈ 0.429 (Microsoft's documented formula:
    // countLess/(countLess+countGreater) = 3/(3+4)); an earlier draft of
    // this generator wrongly recorded 0.5 — the shipped expected JSON
    // already carries 0.429. Do not regress this constant.
    ['=PERCENTRANK.INC(A1:A8,30)', 0.429],
    ['=PROB({1,2,3},{0.2,0.5,0.3},2)', 0.5],
    ['=FORECAST.LINEAR(9,{10,20,30},{1,2,3})', 90],
    ['=INTERCEPT({10,20,30},{1,2,3})', 0],
    ['=AGGREGATE(9,0,A1:A8)', 300],
    ['=AGGREGATE(1,0,A1:A8)', 37.5],
  ];
  // TRIMMEAN: 8*0.25/2=1 trimmed each end → mean(20,30,40,50,60) minus? 
  // Sorted: [10,20,20,30,40,50,60,70], trim 1 each: [20,20,30,40,50,60] mean=36.67
  formulas[5][1] = (20+20+30+40+50+60)/6;
  formulas.forEach(([f, exp], i) => {
    const addr = XLSX.utils.encode_cell({ r: i, c: 1 }); // Column B
    ws[addr] = { t: 'n', v: 0, f: f.slice(1) };
    expected[`StatsFuncs!B${i + 1}`] = exp;
  });
  ws['!ref'] = 'A1:B15';
  var statsWs = ws;
}

// ============ Sheet: MathFuncs ============
{
  const ws = {};
  const formulas = [
    ['=ERF.PRECISE(1)', 0.8427],
    ['=ERFC.PRECISE(0)', 1],
    ['=ECMA.CEILING(4.2)', 5],
    ['=MDETERM({1,2;3,4})', -2],
    ['=PERMUT(5,2)', 20],
    ['=PERMUTATIONA(5,2)', 25],
    ['=BINOM.DIST.RANGE(10,0.5,5,5)', 0.2461],
  ];
  formulas.forEach(([f, exp], i) => {
    const addr = XLSX.utils.encode_cell({ r: i, c: 0 });
    ws[addr] = { t: 'n', v: 0, f: f.slice(1) };
    expected[`MathFuncs!A${i + 1}`] = { approx: exp, tol: 0.01 };
  });
  ws['!ref'] = 'A1:A10';
  var mathWs = ws;
}

// ============ Sheet: FinFuncs ============
{
  const ws = {};
  const formulas = [
    ['=IRR({-100,50,60})', 0.0639],
  ];
  formulas.forEach(([f, exp], i) => {
    const addr = XLSX.utils.encode_cell({ r: i, c: 0 });
    ws[addr] = { t: 'n', v: 0, f: f.slice(1) };
    expected[`FinFuncs!A${i + 1}`] = { approx: exp, tol: 0.01 };
  });
  ws['!ref'] = 'A1:A5';
  var finWs = ws;
}

// ============ Sheet: LookupFuncs ============
{
  const ws = {};
  const data = [[1, 'a'], [2, 'b'], [3, 'c']];
  setupData(ws, data);
  const formulas = [
    ['=XLOOKUP(2,A1:A3,B1:B3)', 'b'],
    ['=LOOKUP(2,A1:A3,B1:B3)', 'b'],
  ];
  formulas.forEach(([f, exp], i) => {
    const addr = XLSX.utils.encode_cell({ r: i, c: 2 }); // Column C
    ws[addr] = { t: 'n', v: 0, f: f.slice(1) };
    expected[`LookupFuncs!C${i + 1}`] = exp;
  });
  ws['!ref'] = 'A1:C5';
  var lookupWs = ws;
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, dbWs, 'DbFuncs');
XLSX.utils.book_append_sheet(wb, textWs, 'TextFuncs');
XLSX.utils.book_append_sheet(wb, statsWs, 'StatsFuncs');
XLSX.utils.book_append_sheet(wb, mathWs, 'MathFuncs');
XLSX.utils.book_append_sheet(wb, finWs, 'FinFuncs');
XLSX.utils.book_append_sheet(wb, lookupWs, 'LookupFuncs');

XLSX.writeFile(wb, 'test-data/gold/functions-batch2.xlsx');
writeFileSync('test-data/gold/functions-batch2-expected.json', JSON.stringify(expected, null, 2));
console.log(`Wrote ${Object.keys(expected).length} formulas across 6 sheets`);
