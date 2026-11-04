/**
 * Defect E1 — saving dropped ALL defined names (silent corruption).
 *
 * The snapshot is the save serialization source on every host (local,
 * desktop IPC, gateway). It must carry the workbook's defined names —
 * live from HyperFormula, with sheet scope as a 0-based sheet index —
 * and fromSnapshot must restore them BEFORE formulas are parsed, so a
 * snapshot round-trip evaluates identically (no #NAME?).
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook, scalar, type CellRef } from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function buildWorkbook(): EngineWorkbook {
  return new EngineWorkbook(
    {
      Data: [
        [0.25, 100],
        [null, '=BaseAmt*TaxRate'],
        [null, '=BaseAmt*TaxRate*2'],
      ],
      Other: [[7, '=LocalRate*3']],
    },
    {
      definedNames: [
        { name: 'TaxRate', ref: 'Data!$A$1' },
        { name: 'BaseAmt', ref: 'Data!$B$1' },
        // Sheet-scoped to 'Other' (0-based index 1).
        { name: 'LocalRate', ref: 'Other!$A$1', sheet: 1 },
        // HF-unbindable (matches HyperFormula's A1 heuristic
        // /^[A-Za-z]+[0-9]+$/): the XLSX adapter rewrites references to
        // it at import, so the engine never binds it — but the name
        // itself must still be preserved verbatim for save.
        { name: 'RateY1', ref: 'Data!$A$1' },
        // Non-range name (constant): HF holds it as a named expression.
        { name: 'Answer', ref: '42' },
      ],
    },
  );
}

describe('defined names in snapshots (defect E1)', () => {
  it('getLiveDefinedNames returns workbook + sheet-scoped names with live refs', () => {
    const wb = buildWorkbook();
    const names = wb.getLiveDefinedNames();
    const byName = new Map(names.map((d) => [d.name, d]));
    expect(byName.get('TaxRate')).toEqual({ name: 'TaxRate', ref: 'Data!$A$1' });
    expect(byName.get('BaseAmt')).toEqual({ name: 'BaseAmt', ref: 'Data!$B$1' });
    expect(byName.get('LocalRate')).toEqual({ name: 'LocalRate', ref: 'Other!$A$1', sheet: 1 });
    // Unbindable name preserved verbatim from construction.
    expect(byName.get('RateY1')).toEqual({ name: 'RateY1', ref: 'Data!$A$1' });
    // Constant name rides along.
    expect(byName.get('Answer')?.ref).toContain('42');
    // The synthetic boolean literals are NOT file defined names.
    expect(byName.has('TRUE')).toBe(false);
    expect(byName.has('FALSE')).toBe(false);
    expect(names).toHaveLength(5);
  });

  it('toSnapshot carries defined names; fromSnapshot restores them and evaluates identically', () => {
    const wb = buildWorkbook();
    expect(wb.getValue(c('Data', 1, 1))).toEqual(scalar(25));
    expect(wb.getValue(c('Other', 0, 1))).toEqual(scalar(21));

    const snap = wb.toSnapshot();
    expect(snap.definedNames).toHaveLength(5);

    const wb2 = EngineWorkbook.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    // No #NAME?: name-referencing formulas evaluate to the same values.
    expect(wb2.getValue(c('Data', 1, 1))).toEqual(scalar(25));
    expect(wb2.getValue(c('Data', 2, 1))).toEqual(scalar(50));
    expect(wb2.getValue(c('Other', 0, 1))).toEqual(scalar(21));
    // And the restored workbook's snapshot carries the names again
    // (save → reopen → save is stable).
    expect(wb2.toSnapshot().definedNames).toHaveLength(5);
  });

  it('runtime-defined names appear live; deleted names disappear', () => {
    const wb = new EngineWorkbook({ Sheet1: [[2], [3]] });
    wb.defineNamedRange('Total', 'Sheet1!$A$1:$A$2');
    wb.setFormula(c('Sheet1', 0, 1), '=SUM(Total)');
    let names = wb.getLiveDefinedNames();
    expect(names).toContainEqual({ name: 'Total', ref: 'Sheet1!$A$1:$A$2' });

    const def = wb.listNamedRanges().find((d) => d.name === 'Total')!;
    wb.deleteNamedRange(def.id);
    names = wb.getLiveDefinedNames();
    expect(names.map((d) => d.name)).not.toContain('Total');
  });

  it('live refs track structural edits (insert rows above the named cell)', () => {
    const wb = buildWorkbook();
    wb.insertRows('Data', 0, 1);
    const tax = wb.getLiveDefinedNames().find((d) => d.name === 'TaxRate');
    expect(tax?.ref).toBe('Data!$A$2');
  });
});
