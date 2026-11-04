/**
 * Detail dump: for each error cell, print file, sheet, ref, error code, formula.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { XlsxAdapter } from '../src/index.js';
import { EngineWorkbook } from '@icecream-sheets/engine';

function colName(c: number): string {
  let s = '';
  let n = c;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

describe('real-world error detail dump', () => {
  it('dumps error cells with formulas', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
    const files = readdirSync(dir).filter((f) => f.endsWith('.xlsx')).sort();
    const adapter = new XlsxAdapter();
    const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
    const lines: string[] = [];
    for (const file of files) {
      if (only && !only.includes(file)) continue;
      try {
        const data = adapter.read(new Uint8Array(readFileSync(join(dir, file))));
        const initial: Record<string, any[][]> = {};
        for (const sheet of data.sheets) initial[sheet.name] = sheet.rows.map((r: any[]) => [...r]);
        const wb = new EngineWorkbook(initial, { definedNames: (data as any).definedNames });
        for (const sheet of data.sheets) {
          const rows = sheet.rows as any[][];
          for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            for (let c = 0; c < row.length; c++) {
              const cell = row[c];
              if (!(typeof cell === 'string' && cell.startsWith('='))) continue;
              const v: any = (wb as any).getValue({ sheet: sheet.name, row: r, col: c });
              if (v && v.kind === 'error') {
                lines.push(
                  `${file} | ${sheet.name}!${colName(c)}${r + 1} | ${v.code} | ${String(cell).slice(0, 300)}`,
                );
              }
            }
          }
        }
      } catch (e: any) {
        lines.push(`${file} | LOADERR | ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    writeFileSync('/tmp/audit-detail.txt', lines.join('\n'));
    console.log(lines.join('\n'));
  }, 600000);
});
