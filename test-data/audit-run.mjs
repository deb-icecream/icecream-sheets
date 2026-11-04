// Formula resolution audit across test-data/real-world/*.xlsx
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { XlsxAdapter } from '../../packages/xlsx-adapter/src/adapter.js';
import { EngineWorkbook, TypedView } from '../../packages/engine/src/index.js';

function workbookDataToInitial(data) {
  const initial = {};
  for (const sheet of data.sheets) {
    initial[sheet.name] = sheet.rows.map((row) => [...row]);
  }
  return initial;
}

const dir = join(__dirname, '../../test-data/real-world');
const files = readdirSync(dir).filter((f) => f.endsWith('.xlsx')).sort();
const summary = [];
const totals = {};
for (const file of files) {
  const counts = {};
  let errorCount = 0;
  let formulaCount = 0;
  let err = null;
  try {
    const data = await XlsxAdapter.read(join(dir, file));
    const wb = new EngineWorkbook(workbookDataToInitial(data), { definedNames: data.definedNames });
    const view = new TypedView(wb);
    for (const sheet of data.sheets) {
      const rows = sheet.rows;
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          const cell = rows[r][c];
          const isFormula = typeof cell === 'string' && cell.startsWith('=');
          if (!isFormula) continue;
          formulaCount++;
          const v = wb.getValue({ sheet: sheet.name, row: r, col: c });
          if (v.kind === 'error') {
            errorCount++;
            counts[v.code] = (counts[v.code] || 0) + 1;
          }
        }
      }
    }
  } catch (e) {
    err = String(e && e.message || e).slice(0, 200);
  }
  summary.push({ file, errorCount, formulaCount, counts, err });
  for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] || 0) + v;
  console.log(`${file}: formulas=${formulaCount} errors=${errorCount} ${JSON.stringify(counts)}${err ? ' LOAD-ERR: ' + err : ''}`);
}
console.log('TOTALS', JSON.stringify(totals));
const zero = summary.filter((s) => s.errorCount === 0 && !s.err).length;
const loadErr = summary.filter((s) => s.err).length;
console.log(`files=${files.length} zeroError=${zero} loadErrors=${loadErr}`);
