import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '../src/index.js';
import { EngineWorkbook } from '@icecream-sheets/engine';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');

function val(wb: any, sheet: string, r: number, c: number): string {
  const v: any = wb.getValue({ sheet, row: r, col: c });
  if (v && v.kind === 'error') return `${v.code} ${String((v as any).message ?? '').slice(0, 120)}`;
  return JSON.stringify(v && v.value !== undefined ? v.value : v);
}

describe('bisect', () => {
  it('bisects _Hours', () => {
    const mk = (names: any[]) =>
      new EngineWorkbook(
        { 'Лист1': [[1], [2], [3], [4], [5], [6]] } as any,
        { definedNames: names } as any,
      ) as any;
    const n1 = [{ name: '_Hours', ref: 'Лист1!$F$4' }];
    const n2 = [{ name: 'dates', ref: 'Лист1!$F$3' }];
    const n3 = [{ name: 'PlanData', ref: 'Лист1!$A$4:$G$5' }];
    const w1: any = new EngineWorkbook(
      { 'Лист1': [['=SUM(_Hours)'], [2], [3]] } as any,
      { definedNames: n1 } as any,
    );
    console.log('only _Hours =>', val(w1, 'Лист1', 0, 0));
    const w2: any = new EngineWorkbook(
      { 'Лист1': [['=SUM(_Hours)'], [2], [3]] } as any,
      { definedNames: [...n1, ...n2, ...n3] } as any,
    );
    console.log('all three =>', val(w2, 'Лист1', 0, 0));
    const w3: any = new EngineWorkbook(
      { 'Лист1': [['=SUM(_Hours)'], [2], [3]] } as any,
      { definedNames: [...n1, ...n3] } as any,
    );
    console.log('_Hours+PlanData =>', val(w3, 'Лист1', 0, 0));
  });

  it('scans AND(D2:D80) range for error cells', () => {
    const adapter = new XlsxAdapter();
    const data: any = adapter.read(
      new Uint8Array(readFileSync(join(dir, 'closedxml-xlsx-functions-excel-2010.xlsx'))),
    );
    const initial: Record<string, any[][]> = {};
    for (const s of data.sheets) initial[s.name] = s.rows.map((r: any[]) => [...r]);
    const wb: any = new EngineWorkbook(initial, { definedNames: data.definedNames });
    // D is col 3; scan rows 2..80 (idx 1..79)
    let bad = 0;
    for (let r = 1; r < 80 && bad < 8; r++) {
      const v: any = wb.getValue({ sheet: 'Sheet1', row: r, col: 3 });
      if (v && v.kind === 'error') {
        bad++;
        const f = (initial['Sheet1'][r] as any[])[3];
        console.log(`D${r + 1} => ${v.code} | ${String(f).slice(0, 120)}`);
      }
    }
    console.log('B39 =>', val(wb, 'Sheet1', 38, 1), '| C39 =>', val(wb, 'Sheet1', 38, 2));
    console.log('B77 =>', val(wb, 'Sheet1', 76, 1), '| C77 =>', val(wb, 'Sheet1', 76, 2));
    console.log('F44 =>', val(wb, 'Sheet1', 43, 5));
  });
});
