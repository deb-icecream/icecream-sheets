/**
 * Tests for the gateway-mode open payload reconstructions
 * (Cycle 10, Phase 2: local mirror + hydration payload).
 */
import { describe, expect, it } from 'vitest';
import { encodeFormatsRecord } from '@icecream-sheets/xlsx-adapter';
import type { WorkbookSnapshot } from '@icecream-sheets/engine';
import {
  buildLocalMirror,
  buildLocalMirrorFromSnapshot,
  mirrorSheetsAsRows,
  mirrorWorkbookData,
  workbookDataFromLoadResult,
} from './localMirror';
import type { EngineLoadResult } from '../services/engineTransport';

const formats = encodeFormatsRecord({ '0:0': 'General', '0:1': '#,##0.00' });

function loadResult(withMirror: boolean): EngineLoadResult {
  return {
    ok: true,
    sheets: ['Sales'],
    file: {
      sheets: [
        {
          name: 'Sales',
          formats,
          colWidths: { 0: 120 },
          rowHeights: {},
          hiddenCols: [],
          hiddenRows: [],
        },
      ],
      metadata: { 'icecream.pageSetup': JSON.stringify({ orientation: 'landscape' }) },
      definedNames: [{ name: 'Cost', ref: 'Sales!$A$1' }],
    },
    columnCounts: { Sales: [2, 2] },
    ...(withMirror
      ? {
          mirror: {
            sheets: [
              {
                name: 'Sales',
                cells: [
                  { row: 0, col: 0, input: 3, value: { kind: 'number', value: 3 } },
                  { row: 0, col: 1, input: '=Cost*2', value: { kind: 'number', value: 6 } },
                ],
              },
            ],
            definedNames: [{ name: 'Cost', ref: 'Sales!$A$1' }],
          },
        }
      : {}),
  };
}

describe('workbookDataFromLoadResult', () => {
  it('decodes formats/metadata, keeps rows empty (cells stay server-side)', () => {
    const data = workbookDataFromLoadResult(loadResult(true));
    expect(data.sheets[0].name).toBe('Sales');
    expect(data.sheets[0].rows).toEqual([]);
    expect(data.sheets[0].formats).toEqual({ '0:0': 'General', '0:1': '#,##0.00' });
    expect(data.sheets[0].colWidths).toEqual({ 0: 120 });
    expect(JSON.parse(data.metadata['icecream.pageSetup'] as string)).toEqual({
      orientation: 'landscape',
    });
    expect(data.definedNames?.[0].name).toBe('Cost');
  });

  it('passes adapter tables through (Phase E whitelist fix — hosted table slicers)', () => {
    const result = loadResult(true);
    result.file.sheets[0]!.tables = [
      {
        name: 'SalesTable',
        sheet: 'Sales',
        startRow: 0,
        startCol: 0,
        endRow: 2,
        endCol: 1,
        columns: ['Item', 'Amount'],
        headerRow: true,
        totalsRow: false,
      },
    ];
    const data = workbookDataFromLoadResult(result);
    const tables = (
      data.sheets[0] as unknown as {
        tables?: { name: string; columns: string[] }[];
      }
    ).tables;
    expect(tables?.[0]?.name).toBe('SalesTable');
    expect(tables?.[0]?.columns).toEqual(['Item', 'Amount']);
  });
});

describe('mirrorSheetsAsRows', () => {
  it('rebuilds adapter-shaped rows from mirror cells', () => {
    const rows = mirrorSheetsAsRows(loadResult(true));
    expect(rows['Sales'][0][0]).toBe(3);
    expect(rows['Sales'][0][1]).toBe('=Cost*2');
  });

  it('returns {} when no mirror ships (flag ON)', () => {
    expect(mirrorSheetsAsRows(loadResult(false))).toEqual({});
  });
});

describe('buildLocalMirror', () => {
  it('builds a live local engine from the mirror (formulas + values)', () => {
    const host = buildLocalMirror(loadResult(true));
    expect(host).not.toBeNull();
    const view = host!.getView();
    expect(view.readCell({ sheet: 'Sales', row: 0, col: 0 }).value).toEqual({
      kind: 'number',
      value: 3,
    });
    // Formula cell evaluates through the local engine's defined name.
    expect(view.readCell({ sheet: 'Sales', row: 0, col: 1 }).value).toEqual({
      kind: 'number',
      value: 6,
    });
  });

  it('returns null when no mirror ships (flag ON — server calc only)', () => {
    expect(buildLocalMirror(loadResult(false))).toBeNull();
  });
});

describe('buildLocalMirrorFromSnapshot (issue #66 — join path)', () => {
  const snap: WorkbookSnapshot = {
    protocolVersion: 1,
    sheets: [
      {
        name: 'Calc',
        cells: [
          { ref: { sheet: 'Calc', row: 0, col: 0 }, input: 10 },
          { ref: { sheet: 'Calc', row: 0, col: 1 }, input: '=A1*2' },
          { ref: { sheet: 'Calc', row: 0, col: 2 }, input: '=Cost+1' },
        ],
      },
    ],
    definedNames: [{ name: 'Cost', ref: 'Calc!$A$1' }],
  };

  it('builds an evaluating mirror from snapshot inputs (formulas + defined names)', () => {
    const { mirror, totalCellCount } = buildLocalMirrorFromSnapshot(snap, 5000);
    expect(totalCellCount).toBe(3);
    expect(mirror).not.toBeNull();
    const view = mirror!.getView();
    expect(view.readCell({ sheet: 'Calc', row: 0, col: 1 }).value).toEqual({
      kind: 'number',
      value: 20,
    });
    expect(view.readCell({ sheet: 'Calc', row: 0, col: 2 }).value).toEqual({
      kind: 'number',
      value: 11,
    });
  });

  it('over the threshold: no engine is built, but the count still reports (no-mirror discipline)', () => {
    const { mirror, totalCellCount } = buildLocalMirrorFromSnapshot(snap, 2);
    expect(mirror).toBeNull();
    expect(totalCellCount).toBe(3);
  });

  it('empty snapshot: no mirror, zero count', () => {
    const { mirror, totalCellCount } = buildLocalMirrorFromSnapshot(
      { protocolVersion: 1, sheets: [{ name: 'Calc', cells: [] }] },
      5000,
    );
    expect(mirror).toBeNull();
    expect(totalCellCount).toBe(0);
  });
});

describe('mirrorWorkbookData', () => {
  it('carries mirror rows for browser-side registry work, null without mirror', () => {
    const withRows = mirrorWorkbookData(loadResult(true));
    expect(withRows!.sheets[0].rows[0][1]).toBe('=Cost*2');
    expect(mirrorWorkbookData(loadResult(false))).toBeNull();
  });
});
