/**
 * Validate 54 real-world Excel files against the engine.
 * For each file: load via XlsxAdapter, count formulas, check for errors.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { EngineWorkbook } = await import('../packages/engine/dist/index.js');
const { XlsxAdapter } = await import('../packages/xlsx-adapter/dist/index.js');

const dir = 'test-data/real-world';
const files = readdirSync(dir).filter(f => f.endsWith('.xlsx'));

const adapter = new XlsxAdapter();
let totalFormulas = 0;
let totalErrors = 0;
let filesOk = 0;
const results = [];

for (const file of files) {
  try {
    const data = adapter.read(new Uint8Array(readFileSync(join(dir, file))));
    const initial = {};
    for (const sheet of data.sheets) initial[sheet.name] = sheet.rows;
    const wb = new EngineWorkbook(initial);
    
    // Count formulas and errors by sampling
    let formulas = 0, errors = 0;
    for (const sheet of data.sheets) {
      const rows = sheet.rows;
      for (let r = 0; r < Math.min(rows.length, 100); r++) {
        for (let c = 0; c < (rows[r]?.length || 0); c++) {
          const v = wb.getValue({ sheet: sheet.name, row: r, col: c });
          if (v.kind === 'error') errors++;
        }
      }
      // Count formula cells from raw data
      for (const row of rows) {
        for (const cell of row || []) {
          if (typeof cell === 'string' && cell.startsWith('=')) formulas++;
        }
      }
    }
    totalFormulas += formulas;
    totalErrors += errors;
    if (errors === 0) filesOk++;
    results.push({ file, formulas, errors, status: errors === 0 ? 'OK' : `${errors} errors` });
  } catch (e) {
    results.push({ file, formulas: 0, errors: 0, status: `LOAD FAILED: ${e.message}` });
  }
}

console.log(`\n${filesOk}/${files.length} files load without errors`);
console.log(`Total formulas: ${totalFormulas}, total cell errors: ${totalErrors}\n`);
console.log('Top 10 by formula count:');
results.sort((a, b) => b.formulas - a.formulas).slice(0, 10).forEach(r => {
  console.log(`  ${r.file}: ${r.formulas} formulas, ${r.status}`);
});
