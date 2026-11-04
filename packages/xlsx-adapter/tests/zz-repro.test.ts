import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '../src/index.js';
import { EngineWorkbook } from '@icecream-sheets/engine';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');

function val(wb: any, sheet: string, r: number, c: number): string {
  const v: any = wb.getValue({ sheet, row: r, col: c });
  if (v && v.kind === 'error') return v.code;
  return JSON.stringify(v && v.value !== undefined ? v.value : v);
}

describe('repro', () => {
  it('reproduces _Hours #ERROR with real file data', () => {
    const adapter = new XlsxAdapter();
    const data: any = adapter.read(
      new Uint8Array(
        readFileSync(join(dir, 'closedxml-TryToLoad-FileWithDefaultStyleNameNotInEnglish.xlsx')),
      ),
    );
    const initial: Record<string, any[][]> = {};
    for (const s of data.sheets) initial[s.name] = s.rows.map((r: any[]) => [...r]);
    const wb: any = new EngineWorkbook(initial, { definedNames: data.definedNames });
    console.log('G4 =SUM(_Hours) =>', val(wb, data.sheets[0].name, 3, 6));
    console.log('F1 =title =>', val(wb, data.sheets[0].name, 0, 5));
    // what does the name resolve to?
    console.log('names:', JSON.stringify(data.definedNames));
  });

  it('reproduces CELL address with real beyond-excel data', () => {
    const adapter = new XlsxAdapter();
    const data: any = adapter.read(
      new Uint8Array(readFileSync(join(dir, 'beyond-excel-bxl3way.xlsx'))),
    );
    const initial: Record<string, any[][]> = {};
    for (const s of data.sheets) initial[s.name] = s.rows.map((r: any[]) => [...r]);
    const wb: any = new EngineWorkbook(initial, { definedNames: data.definedNames });
    console.log('G8 HYPERLINK =>', val(wb, 'CHKs', 7, 6));
    // direct CELL probe
    const wb2: any = new EngineWorkbook(
      { CHKs: [['x'], ['=CELL("address",Income_Statement_Pivot)']] } as any,
      { definedNames: [{ name: 'Income_Statement_Pivot', ref: 'CHKs!$B$20' }] } as any,
    );
    console.log('CELL addr name =>', val(wb2, 'CHKs', 1, 0));
  });
});
