/**
 * Issue #50: reads against a sheet that does not exist fail SOFT.
 *
 * The desktop p95 boot log captured an `engine:readCell` handler crash
 * ("Unknown sheet: Sheet1"): the renderer asked for the previous
 * workbook's sheet just after the host had swapped in a workbook
 * without it, and EngineWorkbook.getValue threw through the host,
 * because findUnreadableName → getSerialized → addr → sheetId throws.
 * A read racing a workbook swap is a legitimate race, so the read now
 * resolves to the Excel-consistent #REF! error value. Writes stay
 * fail-loud (setCell still throws via addr()).
 */
import { describe, expect, it } from 'vitest';
import { EngineHost, EngineWorkbook } from '../src/index.js';

describe('unknown-sheet reads (issue #50)', () => {
  it('getValue on a missing sheet returns a #REF! error value, never throws', () => {
    const wb = new EngineWorkbook({ Data: [[1, 2]] });
    const v = wb.getValue({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(v.kind).toBe('error');
    if (v.kind === 'error') {
      expect(v.code).toBe('#REF!');
      expect(v.message).toContain('Unknown sheet: Sheet1');
    }
  });

  it('getValue on an existing sheet is unchanged', () => {
    const wb = new EngineWorkbook({ Data: [[1, '=A1+1']] });
    expect(wb.getValue({ sheet: 'Data', row: 0, col: 0 })).toEqual({ kind: 'number', value: 1 });
    expect(wb.getValue({ sheet: 'Data', row: 0, col: 1 })).toEqual({ kind: 'number', value: 2 });
    // An empty in-range cell of a real sheet still reads as null, not #REF!.
    expect(wb.getValue({ sheet: 'Data', row: 9, col: 9 })).toEqual({ kind: 'null', value: null });
  });

  it('host readCell on a missing sheet returns the error value (the desktop IPC path)', () => {
    const host = new EngineHost();
    host.replaceWorkbook(new EngineWorkbook({ Sales: [[115]] }));
    const v = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(v.kind).toBe('error');
    if (v.kind === 'error') expect(v.message).toContain('Unknown sheet: Sheet1');
    // And the real sheet still reads exactly.
    expect(host.readCell({ sheet: 'Sales', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 115,
    });
  });

  it('suspended (manual) mode reads on a missing sheet also fail soft', () => {
    const wb = new EngineWorkbook({ Data: [[1]] });
    wb.setCalculationMode('manual');
    const v = wb.getValue({ sheet: 'Ghost', row: 0, col: 0 });
    expect(v.kind).toBe('error');
    wb.setCalculationMode('automatic');
  });

  it('writes to a missing sheet still throw (fail-loud writes)', () => {
    const wb = new EngineWorkbook({ Data: [[1]] });
    expect(() => wb.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 5)).toThrow(/Unknown sheet/);
  });
});
