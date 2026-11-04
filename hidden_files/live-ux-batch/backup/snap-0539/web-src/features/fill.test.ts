/**
 * Unit tests for Fill Down/Right/Up/Left, Fill Series, Justify, and
 * formula reference shifting.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import { cellRef, formatDisplay } from '../engine';
import {
  fillDirection,
  fillSeries,
  justifyText,
  shiftFormulaRefs,
} from './fill';

function makeHost(): EngineHost {
  return new EngineHost();
}

function set(host: EngineHost, sheet: string, row: number, col: number, value: string | number | null): void {
  host.execute({ cmd: 'setCell', ref: cellRef(sheet, row, col), value });
}

function text(host: EngineHost, sheet: string, row: number, col: number): string {
  return formatDisplay(host.getView().readCell(cellRef(sheet, row, col)).value);
}

describe('shiftFormulaRefs', () => {
  it('shifts relative refs down', () => {
    expect(shiftFormulaRefs('=SUM(A1:A3)+B2', 2, 0)).toBe('=SUM(A3:A5)+B4');
  });

  it('shifts relative refs right', () => {
    expect(shiftFormulaRefs('=A1*B1', 0, 1)).toBe('=B1*C1');
  });

  it('keeps absolute parts pinned', () => {
    expect(shiftFormulaRefs('=$A1+A$1+$A$1', 1, 1)).toBe('=$A2+B$1+$A$1');
  });

  it('leaves string literals untouched', () => {
    expect(shiftFormulaRefs('=IF(A1>0,"A1 wins","no")', 1, 0)).toBe('=IF(A2>0,"A1 wins","no")');
  });

  it('handles escaped quotes inside literals', () => {
    expect(shiftFormulaRefs('="a""A1""b"&A1', 1, 0)).toBe('="a""A1""b"&A2');
  });

  it('handles sheet-qualified refs', () => {
    expect(shiftFormulaRefs('=Sheet1!A1+1', 0, 2)).toBe('=Sheet1!C1+1');
  });

  it('produces #REF! when shifted off the grid', () => {
    expect(shiftFormulaRefs('=A1', -1, 0)).toBe('=#REF!');
    expect(shiftFormulaRefs('=A1', 0, -1)).toBe('=#REF!');
  });

  it('does not touch names containing letter-digit runs', () => {
    expect(shiftFormulaRefs('=Sales2024+A1', 1, 0)).toBe('=Sales2024+A2');
  });

  it('does not touch function names', () => {
    expect(shiftFormulaRefs('=LOG10(A1)', 1, 0)).toBe('=LOG10(A2)');
  });

  it('is a no-op for zero offset', () => {
    const f = '=SUM($A$1:B2)';
    expect(shiftFormulaRefs(f, 0, 0)).toBe(f);
  });
});

describe('fillDirection', () => {
  it('fills down copying values', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 10);
    const n = fillDirection(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, 'down');
    expect(n).toBe(2);
    expect(text(host, 'Sheet1', 1, 0)).toBe('10');
    expect(text(host, 'Sheet1', 2, 0)).toBe('10');
    host.dispose();
  });

  it('fills down adjusting relative formula refs', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 5);
    host.execute({ cmd: 'setFormula', ref: cellRef('Sheet1', 1, 0), formula: '=A1*2' });
    fillDirection(host, 'Sheet1', { startRow: 1, startCol: 0, endRow: 3, endCol: 0 }, 'down');
    expect(text(host, 'Sheet1', 1, 0)).toBe('10');
    expect(text(host, 'Sheet1', 2, 0)).toBe('20'); // =A2*2
    expect(text(host, 'Sheet1', 3, 0)).toBe('40'); // =A3*2
    host.dispose();
  });

  it('fills right across columns', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 'x');
    fillDirection(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, 'right');
    expect(text(host, 'Sheet1', 0, 1)).toBe('x');
    expect(text(host, 'Sheet1', 0, 2)).toBe('x');
    host.dispose();
  });

  it('fills up from the bottom edge', () => {
    const host = makeHost();
    set(host, 'Sheet1', 2, 1, 42);
    fillDirection(host, 'Sheet1', { startRow: 0, startCol: 1, endRow: 2, endCol: 1 }, 'up');
    expect(text(host, 'Sheet1', 0, 1)).toBe('42');
    expect(text(host, 'Sheet1', 1, 1)).toBe('42');
    host.dispose();
  });

  it('fills left from the right edge', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 3, 'z');
    fillDirection(host, 'Sheet1', { startRow: 0, startCol: 1, endRow: 0, endCol: 3 }, 'left');
    expect(text(host, 'Sheet1', 0, 1)).toBe('z');
    expect(text(host, 'Sheet1', 0, 2)).toBe('z');
    host.dispose();
  });
});

describe('fillSeries', () => {
  it('extends a linear series down a column', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 1);
    set(host, 'Sheet1', 1, 0, 3);
    const n = fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 4, endCol: 0 }, {});
    expect(n).toBe(4);
    expect(text(host, 'Sheet1', 2, 0)).toBe('5');
    expect(text(host, 'Sheet1', 4, 0)).toBe('9');
    host.dispose();
  });

  it('uses an explicit step with a single seed', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 10);
    fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, { step: 5 });
    expect(text(host, 'Sheet1', 1, 0)).toBe('15');
    expect(text(host, 'Sheet1', 2, 0)).toBe('20');
    host.dispose();
  });

  it('fills a growth series', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 2);
    set(host, 'Sheet1', 1, 0, 6);
    fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 3, endCol: 0 }, { growth: true });
    expect(text(host, 'Sheet1', 2, 0)).toBe('18');
    expect(text(host, 'Sheet1', 3, 0)).toBe('54');
    host.dispose();
  });

  it('fills dates by day', () => {
    const host = makeHost();
    // 2026-10-18 as an Excel serial.
    const serial = Math.round(Date.UTC(2026, 9, 18) / 86400000) + 25569;
    set(host, 'Sheet1', 0, 0, serial);
    fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, { dateUnit: 'day' });
    expect(text(host, 'Sheet1', 1, 0)).toBe(String(serial + 1));
    expect(text(host, 'Sheet1', 2, 0)).toBe(String(serial + 2));
    host.dispose();
  });

  it('fills dates by month', () => {
    const host = makeHost();
    const serial = Math.round(Date.UTC(2026, 0, 15) / 86400000) + 25569;
    set(host, 'Sheet1', 0, 0, serial);
    fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 1, endCol: 0 }, { dateUnit: 'month' });
    const expected = Math.round(Date.UTC(2026, 1, 15) / 86400000) + 25569;
    expect(text(host, 'Sheet1', 1, 0)).toBe(String(expected));
    host.dispose();
  });

  it('copies text seeds', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 'Q1');
    fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, {});
    expect(text(host, 'Sheet1', 0, 1)).toBe('Q1');
    expect(text(host, 'Sheet1', 0, 2)).toBe('Q1');
    host.dispose();
  });

  it('honors a stop value', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 1);
    fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 5, endCol: 0 }, { step: 2, stopValue: 5 });
    expect(text(host, 'Sheet1', 2, 0)).toBe('5');
    expect(text(host, 'Sheet1', 3, 0)).toBe(''); // stopped before writing 7
    host.dispose();
  });

  it('refuses multi-row multi-column ranges', () => {
    const host = makeHost();
    expect(fillSeries(host, 'Sheet1', { startRow: 0, startCol: 0, endRow: 2, endCol: 2 }, {})).toBe(0);
    host.dispose();
  });
});

describe('justifyText', () => {
  it('wraps words across the row by column width', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 'the quick brown fox jumps');
    set(host, 'Sheet1', 0, 1, 'over the lazy dog');
    justifyText(host, 'Sheet1', 0, 0, 1, [10, 10]);
    expect(text(host, 'Sheet1', 0, 0)).toBe('the quick');
    expect(text(host, 'Sheet1', 0, 1)).toBe('brown fox');
    host.dispose();
  });

  it('clears trailing cells when everything fits in fewer columns', () => {
    const host = makeHost();
    set(host, 'Sheet1', 0, 0, 'hi');
    set(host, 'Sheet1', 0, 1, 'there');
    set(host, 'Sheet1', 0, 2, 'old');
    justifyText(host, 'Sheet1', 0, 0, 2, [30, 30, 30]);
    expect(text(host, 'Sheet1', 0, 0)).toBe('hi there old');
    expect(text(host, 'Sheet1', 0, 1)).toBe('');
    expect(text(host, 'Sheet1', 0, 2)).toBe('');
    host.dispose();
  });

  it('is a no-op on an empty row', () => {
    const host = makeHost();
    justifyText(host, 'Sheet1', 3, 0, 2);
    expect(text(host, 'Sheet1', 3, 0)).toBe('');
    host.dispose();
  });
});
