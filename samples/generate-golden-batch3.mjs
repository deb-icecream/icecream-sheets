/**
 * Golden dataset batch 3: the six functions implemented in Phase 2 of the
 * Excel function-coverage work (2026-10-21) — GROUPBY, PIVOTBY, ODDFPRICE,
 * ODDFYIELD, ODDLPRICE, ODDLYIELD.
 *
 * Expectations are Microsoft's documented worked examples (the same cases
 * asserted in packages/engine/tests/groupby-functions.test.ts and
 * packages/engine/tests/financial-functions3.test.ts).
 */
import { writeFileSync } from 'fs';
import * as XLSX from 'xlsx';

const expected = {}; // "Sheet!A1" -> value or {approx, tol} or {error}

function setupData(ws, data, rowOff = 0, colOff = 0) {
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r].length; c++) {
      const addr = XLSX.utils.encode_cell({ r: r + rowOff, c: c + colOff });
      const v = data[r][c];
      ws[addr] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
    }
  }
}

function formula(ws, r, c, f) {
  const addr = XLSX.utils.encode_cell({ r, c });
  ws[addr] = { t: 'n', v: 0, f: f.slice(1) };
}

// ============ Sheet: OddBond (ODDFPRICE / ODDFYIELD / ODDLPRICE / ODDLYIELD)
const oddWs = {};
{
  const cases = [
    // Microsoft's documented ODDFPRICE example (short first period, basis 1).
    ['=ODDFPRICE(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0785,0.0625,100,2,1)',
      { approx: 113.597717474079, tol: 1e-6 }],
    // Microsoft's documented ODDFYIELD example (full-precision result).
    ['=ODDFYIELD(DATE(2008,11,11),DATE(2021,3,1),DATE(2008,10,15),DATE(2009,3,1),0.0575,84.50,100,2,0)',
      { approx: 0.0772455415972989, tol: 1e-9 }],
    // Microsoft's documented ODDLPRICE example (exact).
    ['=ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,0)',
      { approx: 99.8782860147213, tol: 1e-9 }],
    // Microsoft's documented ODDLYIELD example (docs show 0.04519).
    ['=ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,100,2,0)',
      { approx: 0.04519223563, tol: 1e-9 }],
    // Price/yield round-trip pair (from financial-functions3.test.ts).
    ['=ODDLPRICE(DATE(2020,3,20),DATE(2020,5,10),DATE(2020,1,15),0.045,0.035,100,2,0)',
      { approx: 100.13428645473392, tol: 1e-9 }],
    ['=ODDLYIELD(DATE(2020,3,20),DATE(2020,5,10),DATE(2020,1,15),0.045,100.13428645473392,100,2,0)',
      { approx: 0.035, tol: 1e-9 }],
  ];
  cases.forEach(([f, exp], i) => {
    formula(oddWs, i, 0, f);
    expected[`OddBond!A${i + 1}`] = exp;
  });
  oddWs['!ref'] = 'A1:A6';
}

// ============ Sheet: GroupBy (Microsoft GROUPBY worked example data)
// NOTE on read contract: EngineWorkbook.getValue applies implicit
// intersection at a dynamic-array anchor (top-left scalar); spill
// materialization into neighbor cells is the app-layer spill component's
// job (see packages/engine/tests/engine.test.ts "spill component"). The
// full result grid is therefore asserted cell-by-cell through
// CHOOSECOLS(CHOOSEROWS(<fn>(...), r), c) consumer formulas — the
// engine's own array functions evaluate their argument in array
// context. (INDEX/SUM do not take dynamic-array results as array
// arguments under HyperFormula — a pre-existing platform behavior that
// affects the whole dynamic-array family, SEQUENCE/SORT included.)
const gbWs = {};
{
  const sales = [
    ['Region', 'Product', 'Sales'],
    ['East', 'Apples', 100],
    ['East', 'Oranges', 150],
    ['West', 'Apples', 200],
    ['West', 'Oranges', 50],
    ['North', 'Apples', 300],
  ];
  setupData(gbWs, sales);
  formula(gbWs, 0, 4, '=GROUPBY(A1:A6,C1:C6,SUM,3)');
  expected['GroupBy!E1'] = 'Region'; // anchor, implicit intersection
  // Full spilled grid: Region/Sales, East 250, North 300, West 250, Total 800.
  const out = [
    ['Region', 'Sales'],
    ['East', 250],
    ['North', 300],
    ['West', 250],
    ['Total', 800],
  ];
  let j = 0;
  out.forEach((rowArr, r) => rowArr.forEach((v, c) => {
    if (r === 0 && c === 0) return; // anchor asserted above
    formula(gbWs, j, 9, `=CHOOSECOLS(CHOOSEROWS(GROUPBY($A$1:$A$6,$C$1:$C$6,SUM,3),${r + 1}),${c + 1})`);
    expected[`GroupBy!J${j + 1}`] = v;
    j++;
  }));
  gbWs['!ref'] = 'A1:J9';
}

// ============ Sheet: PivotBy (Microsoft PIVOTBY worked example data)
const pbWs = {};
{
  const byYear = [
    ['Region', 'Year', 'Sales'],
    ['East', 2023, 100],
    ['East', 2024, 150],
    ['West', 2023, 200],
    ['West', 2024, 50],
    ['North', 2023, 300],
    ['North', 2024, 100],
  ];
  setupData(pbWs, byYear);
  formula(pbWs, 0, 4, '=PIVOTBY(A1:A7,B1:B7,C1:C7,SUM,3)');
  expected['PivotBy!E1'] = 'Year'; // anchor, implicit intersection
  // Full spilled grid (asserted via INDEX consumers — see GroupBy note).
  const out = [
    ['Year', 2023, 2024, 'Total'],
    ['Region', 'Sales', 'Sales', 'Sales'],
    ['East', 100, 150, 250],
    ['North', 300, 100, 400],
    ['West', 200, 50, 250],
    ['Total', 600, 300, 900],
  ];
  let j = 0;
  out.forEach((rowArr, r) => rowArr.forEach((v, c) => {
    if (r === 0 && c === 0) return; // anchor asserted above
    formula(pbWs, j, 9, `=CHOOSECOLS(CHOOSEROWS(PIVOTBY($A$1:$A$7,$B$1:$B$7,$C$1:$C$7,SUM,3),${r + 1}),${c + 1})`);
    expected[`PivotBy!J${j + 1}`] = v;
    j++;
  }));
  pbWs['!ref'] = 'A1:J23';
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, oddWs, 'OddBond');
XLSX.utils.book_append_sheet(wb, gbWs, 'GroupBy');
XLSX.utils.book_append_sheet(wb, pbWs, 'PivotBy');
XLSX.writeFile(wb, 'test-data/gold/functions-batch3.xlsx');
writeFileSync('test-data/gold/functions-batch3-expected.json', JSON.stringify(expected, null, 2) + '\n');
console.log(`batch3: ${Object.keys(expected).length} expectations written`);
