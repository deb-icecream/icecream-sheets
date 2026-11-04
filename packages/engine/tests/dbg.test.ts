import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { EngineWorkbook } from '../src/index.js';
describe('b39', () => {
  it('real', () => {
    const data = new XlsxAdapter().read(new Uint8Array(readFileSync('../../test-data/real-world/closedxml-xlsx-functions-excel-2010.xlsx')));
    const sh = (data.sheets as any[])[0];
    console.log('B39 input:', JSON.stringify(sh.rows[38][1]));
    console.log('F2:F10:', JSON.stringify(sh.rows.slice(1,10).map(r=>r[5])));
    const initial: Record<string, any[][]> = {};
    for (const s of data.sheets) initial[s.name] = (s.rows as any[][]).map((r) => [...r]);
    const wb = new EngineWorkbook(initial);
    console.log('B39 val:', JSON.stringify((wb as any).getValue({sheet: sh.name, row:38, col:1})));
    console.log('B39 formula:', (wb as any).getFormula({sheet: sh.name, row:38, col:1}));
  });
});
