/**
 * Formula resolution audit across test-data/real-world/*.xlsx
 * Run: npx vitest run tests/real-world-audit.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { XlsxAdapter } from '../src/index.js';
import { EngineWorkbook } from '@icecream-sheets/engine';

function workbookDataToInitial(data: any): Record<string, any[][]> {
  const initial: Record<string, any[][]> = {};
  for (const sheet of data.sheets) {
    initial[sheet.name] = sheet.rows.map((row: any[]) => [...row]);
  }
  return initial;
}

describe('real-world formula audit', () => {
  it('counts error cells per file', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
    const files = readdirSync(dir).filter((f) => f.endsWith('.xlsx')).sort();
    const adapter = new XlsxAdapter();
    const summary: any[] = [];
    for (const file of files) {
      const counts: Record<string, number> = {};
      let errorCount = 0;
      let formulaCount = 0;
      let err: string | null = null;
      try {
        const data = adapter.read(new Uint8Array(readFileSync(join(dir, file))));
        const wb = new EngineWorkbook(workbookDataToInitial(data), {
          definedNames: (data as any).definedNames,
        });
        for (const sheet of data.sheets) {
          const rows = sheet.rows as any[][];
          for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            for (let c = 0; c < row.length; c++) {
              const cell = row[c];
              if (!(typeof cell === 'string' && cell.startsWith('='))) continue;
              formulaCount++;
              const v: any = (wb as any).getValue({ sheet: sheet.name, row: r, col: c });
              if (v && v.kind === 'error') {
                errorCount++;
                counts[v.code] = (counts[v.code] || 0) + 1;
              }
            }
          }
        }
      } catch (e: any) {
        err = String(e?.message ?? e).slice(0, 300);
      }
      summary.push({ file, errorCount, formulaCount, counts, err });
    }
    writeFileSync('/tmp/audit-results.json', JSON.stringify(summary, null, 1));
    const totals: Record<string, number> = {};
    let totalErr = 0;
    let zero = 0;
    for (const s of summary) {
      totalErr += s.errorCount;
      if (!s.err && s.errorCount === 0) zero++;
      for (const [k, v] of Object.entries(s.counts)) totals[k] = (totals[k] ?? 0) + (v as number);
    }
    console.log('TOTALS', JSON.stringify({ files: files.length, totalErr, zeroError: zero, breakdown: totals }));
    console.log(
      summary
        .filter((s) => s.errorCount > 0 || s.err)
        .map((s) => `${s.file}: formulas=${s.formulaCount} errors=${s.errorCount} ${JSON.stringify(s.counts)}${s.err ? ' LOADERR=' + s.err : ''}`)
        .join('\n'),
    );
  }, 600000);
});
