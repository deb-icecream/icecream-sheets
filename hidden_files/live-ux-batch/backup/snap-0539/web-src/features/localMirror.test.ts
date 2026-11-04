/**
 * Tests for the gateway-mode open payload reconstructions
 * (Cycle 10, Phase 2: local mirror + hydration payload).
 */
import { describe, expect, it } from 'vitest';
import { encodeFormatsRecord } from '@icecream-sheets/xlsx-adapter';
import {
  buildLocalMirror,
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

describe('mirrorWorkbookData', () => {
  it('carries mirror rows for browser-side registry work, null without mirror', () => {
    const withRows = mirrorWorkbookData(loadResult(true));
    expect(withRows!.sheets[0].rows[0][1]).toBe('=Cost*2');
    expect(mirrorWorkbookData(loadResult(false))).toBeNull();
  });
});
