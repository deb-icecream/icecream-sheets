/**
 * Save-pin tests (save-consistency fix): pin + copy-on-write stash on
 * EngineHost. A pinned read must observe exactly the pin-time state of
 * the ONE live model while edits keep applying — no torn cross-sheet
 * state — and ops the stash cannot represent (overflow, structural,
 * name-table) must fail with SavePinOverflowError, unapplied.
 */
import { describe, expect, it } from 'vitest';
import {
  Authorizer,
  EngineHost,
  EngineWorkbook,
  SavePinOverflowError,
  scalar,
  type CellRef,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function find(
  rows: Array<{ ref: CellRef; input: unknown; value: unknown }>,
  sheet: string,
  row: number,
  col: number,
) {
  return rows.find((e) => e.ref.sheet === sheet && e.ref.row === row && e.ref.col === col);
}

/** Sheet1!A1 = 2, Sheet3!A1 = =Sheet1!A1*10 (cached 20). */
function tornFixture(): EngineHost {
  const host = new EngineHost();
  host.execute({ cmd: 'addSheet', name: 'Sheet3' });
  host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 2 });
  host.execute({ cmd: 'setFormula', ref: c('Sheet3', 0, 0), formula: '=Sheet1!A1*10' });
  return host;
}

describe('save pins: pin + copy-on-write stash', () => {
  it('(a) torn-state: pinned reads stay mutually consistent at the pin revision', () => {
    const host = tornFixture();
    const pin = host.beginSavePin();
    expect(pin.rev).toBe(host.currentRevision());

    const res = host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 5 });
    expect(res.ok).toBe(true);
    expect(host.currentRevision()).toBe(pin.rev + 1);

    // Live state moved on: 5 / 50.
    const live = host.bulkReadback();
    expect(find(live, 'Sheet1', 0, 0)?.value).toEqual(scalar(5));
    expect(find(live, 'Sheet3', 0, 0)?.value).toEqual(scalar(50));

    // Pinned state is the pin-time state on BOTH sheets: 2 / 20.
    const p1 = host.bulkReadbackSheetPinned(pin, 'Sheet1');
    expect(find(p1, 'Sheet1', 0, 0)?.input).toBe(2);
    expect(find(p1, 'Sheet1', 0, 0)?.value).toEqual(scalar(2));
    const p3 = host.bulkReadbackSheetPinned(pin, 'Sheet3');
    expect(find(p3, 'Sheet3', 0, 0)?.input).toBe('=Sheet1!A1*10');
    expect(find(p3, 'Sheet3', 0, 0)?.value).toEqual(scalar(20));

    // The edited cell AND its recalculated dependent were stashed.
    expect(host.savePinStashCells(pin)).toBe(2);

    host.releaseSavePin(pin);
    // Chosen contract: stash size of a released pin reads 0, and a
    // pinned read on a released pin throws (fail closed).
    expect(host.savePinStashCells(pin)).toBe(0);
    expect(() => host.bulkReadbackSheetPinned(pin, 'Sheet1')).toThrow(/released save pin/);
  });

  it('(b) cells created after the pin are omitted; cells deleted after the pin remain', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 1 });
    const pin = host.beginSavePin();

    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 2), value: 99 }); // created after pin
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: null }); // deleted after pin

    const pinned = host.bulkReadbackSheetPinned(pin, 'Sheet1');
    expect(find(pinned, 'Sheet1', 0, 0)?.input).toBe(1);
    expect(find(pinned, 'Sheet1', 0, 0)?.value).toEqual(scalar(1));
    expect(find(pinned, 'Sheet1', 0, 2)).toBeUndefined();

    const live = host.bulkReadback();
    expect(find(live, 'Sheet1', 0, 0)).toBeUndefined();
    expect(find(live, 'Sheet1', 0, 2)?.value).toEqual(scalar(99));
    host.releaseSavePin(pin);
  });

  it('(c) overflow: op exceeding the stash cap throws SavePinOverflowError and is not applied', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 1 });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 1), formula: '=A1+1' });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 2), formula: '=B1+1' });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 3), formula: '=C1+1' });
    // Changed set of an A1 edit = {A1, B1, C1, D1} = 4 cells > cap 2.
    const pin = host.beginSavePin({ stashCapCells: 2 });

    let thrown: unknown;
    try {
      host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 10 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SavePinOverflowError);
    expect((thrown as Error).name).toBe('SavePinOverflowError');

    // Op NOT applied: live values unchanged, revision unchanged.
    const live = host.bulkReadback();
    expect(find(live, 'Sheet1', 0, 0)?.value).toEqual(scalar(1));
    expect(find(live, 'Sheet1', 0, 3)?.value).toEqual(scalar(4));
    expect(host.currentRevision()).toBe(pin.rev);

    host.releaseSavePin(pin);
    const res = host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 10 });
    expect(res.ok).toBe(true);
    expect(find(host.bulkReadback(), 'Sheet1', 0, 3)?.value).toEqual(scalar(13));
  });

  it('(d) structural and name ops during a pin throw SavePinOverflowError', () => {
    const host = tornFixture();
    const pin = host.beginSavePin();
    expect(() =>
      host.execute({ cmd: 'insertRows', sheet: 'Sheet1', row: 0, count: 1 }),
    ).toThrow(SavePinOverflowError);
    expect(() => host.execute({ cmd: 'addSheet', name: 'Nope' })).toThrow(
      SavePinOverflowError,
    );
    expect(() =>
      host.execute({ cmd: 'renameSheet', name: 'Sheet1', newName: 'Renamed' }),
    ).toThrow(SavePinOverflowError);
    // Name ops take the safer documented route too: overflow error.
    expect(() =>
      host.execute({ cmd: 'defineName', name: 'Foo', refersTo: 'Sheet1!$A$1' }),
    ).toThrow(SavePinOverflowError);
    // None of them applied.
    expect(host.sheetNames()).toEqual(['Sheet1', 'Sheet3']);
    expect(host.currentRevision()).toBe(pin.rev);

    host.releaseSavePin(pin);
    const res = host.execute({ cmd: 'insertRows', sheet: 'Sheet1', row: 0, count: 1 });
    expect(res.ok).toBe(true);
  });

  it('multiple concurrent pins are independent', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 1 });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 1), formula: '=A1*10' });

    const pin1 = host.beginSavePin();
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 2 });
    const pin2 = host.beginSavePin();
    expect(pin2.rev).toBe(pin1.rev + 1);
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 3 });

    expect(find(host.bulkReadbackSheetPinned(pin1, 'Sheet1'), 'Sheet1', 0, 0)?.value).toEqual(scalar(1));
    expect(find(host.bulkReadbackSheetPinned(pin1, 'Sheet1'), 'Sheet1', 0, 1)?.value).toEqual(scalar(10));
    expect(find(host.bulkReadbackSheetPinned(pin2, 'Sheet1'), 'Sheet1', 0, 0)?.value).toEqual(scalar(2));
    expect(find(host.bulkReadbackSheetPinned(pin2, 'Sheet1'), 'Sheet1', 0, 1)?.value).toEqual(scalar(20));

    // Releasing one pin leaves the other fully functional.
    host.releaseSavePin(pin1);
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 4 });
    expect(find(host.bulkReadbackSheetPinned(pin2, 'Sheet1'), 'Sheet1', 0, 0)?.value).toEqual(scalar(2));
    expect(host.savePinStashCells(pin2)).toBeGreaterThan(0);
    host.releaseSavePin(pin2);
  });

  it('pinned reads apply bulkReadback authorization per requesting principal', () => {
    const denyB1 = (action: string, target: string) =>
      !(action === 'cell.read' && target === 'Sheet1!B1');
    const host = new EngineHost(undefined, new Authorizer(denyB1));
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 7 });
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 1), value: 'secret' });
    const pin = host.beginSavePin();
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 1), value: 'rotated' });

    const pinned = host.bulkReadbackSheetPinned(pin, 'Sheet1');
    // Permitted cell: pin-time state.
    expect(find(pinned, 'Sheet1', 0, 0)?.value).toEqual(scalar(7));
    // Denied cell: same #PERM! behavior as bulkReadback — never the
    // pin-time (or live) value.
    const denied = find(pinned, 'Sheet1', 0, 1)?.value as { kind: string; code?: string };
    expect(denied.kind).toBe('error');
    expect(denied.code).toBe('#PERM!');
    host.releaseSavePin(pin);
  });

  it('safety net: direct EngineWorkbook writes during a pin are also copy-on-write', () => {
    const wb = new EngineWorkbook();
    const host = new EngineHost(wb);
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 3 });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 1), formula: '=A1*2' });
    const pin = host.beginSavePin();

    // Bypass execute() entirely: the workbook write funnel must stash.
    wb.setCell(c('Sheet1', 0, 0), 30);

    const pinned = host.bulkReadbackSheetPinned(pin, 'Sheet1');
    expect(find(pinned, 'Sheet1', 0, 0)?.value).toEqual(scalar(3));
    expect(find(pinned, 'Sheet1', 0, 1)?.value).toEqual(scalar(6));
    const live = host.bulkReadback();
    expect(find(live, 'Sheet1', 0, 0)?.value).toEqual(scalar(30));
    expect(find(live, 'Sheet1', 0, 1)?.value).toEqual(scalar(60));
    host.releaseSavePin(pin);
  });

  it('(e) no pin: execute paths behave exactly as before', () => {
    const host = tornFixture();
    expect(host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 9 }).ok).toBe(true);
    expect(find(host.bulkReadback(), 'Sheet3', 0, 0)?.value).toEqual(scalar(90));
    expect(host.execute({ cmd: 'insertRows', sheet: 'Sheet1', row: 0, count: 1 }).ok).toBe(true);
    expect(
      host.execute({ cmd: 'defineName', name: 'Foo', refersTo: 'Sheet1!$A$2' }).ok,
    ).toBe(true);
    // savePinStashCells on a never-registered pin is 0.
    expect(host.savePinStashCells({ id: 'save-pin-999', rev: 0 })).toBe(0);
  });
});
