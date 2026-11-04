/** SCRATCH: verify engine live-names degradation for _xlcn.* names. */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook } from '@icecream-sheets/engine';

describe('engine live names for _xlcn', () => {
  it('getLiveDefinedNames', () => {
    const wb = new EngineWorkbook(
      { Sheet1: [[1, 2], [3, 4]] },
      {
        definedNames: [
          { name: '_xlcn.WorksheetConnection_Foo.xlsxtblBS1', ref: 'tblBS[]' },
          { name: 'Normal', ref: 'Sheet1!$A$1' },
        ],
      },
    );
    console.log('live:', JSON.stringify(wb.getLiveDefinedNames(), null, 1));
    console.log('listNamedRanges:', JSON.stringify(wb.listNamedRanges(), null, 1));
    expect(true).toBe(true);
  });
});
