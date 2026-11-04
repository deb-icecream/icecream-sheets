/**
 * Headless tests for the web inference binding (no React rendering).
 * Verifies buildInferenceContext maps the typed view correctly (including
 * #PERM! denials), authorize() delegates to protection, and applyProposal
 * routes edits through host.execute().
 */
import { describe, expect, it, vi } from 'vitest';
import { err, scalar, type EngineHost, type TypedCell } from '@icecream-sheets/engine';
import { applyProposal, buildInferenceContext, readColumnHistory } from './inference';
import type { Proposal } from '@icecream-sheets/service';

function cell(sheet: string, row: number, col: number, value: unknown, formula?: string): TypedCell {
  return {
    ref: { sheet, row, col },
    value:
      typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
        ? scalar(value as never)
        : value === null
          ? scalar(null)
          : (value as TypedCell['value']),
    ...(formula !== undefined ? { formula } : {}),
  };
}

function mockHost(cells: Record<string, TypedCell>, executed: unknown[] = []): EngineHost {
  const get = (sheet: string, row: number, col: number): TypedCell =>
    cells[`${sheet}:${row}:${col}`] ?? cell(sheet, row, col, null);
  return {
    getView: () => ({
      usedRange: (sheet: string) =>
        Object.keys(cells).some((k) => k.startsWith(`${sheet}:`))
          ? { sheet, startRow: 0, startCol: 0, endRow: 4, endCol: 2 }
          : null,
      readCell: (ref: { sheet: string; row: number; col: number }) => get(ref.sheet, ref.row, ref.col),
      readRange: (range: { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number }) => {
        const rows: TypedCell[][] = [];
        for (let r = range.startRow; r <= range.endRow; r++) {
          const row: TypedCell[] = [];
          for (let c = range.startCol; c <= range.endCol; c++) row.push(get(range.sheet, r, c));
          rows.push(row);
        }
        return rows;
      },
    }),
    execute: (cmd: unknown) => {
      executed.push(cmd);
      return { ok: true as const };
    },
  } as unknown as EngineHost;
}

const protection = {
  hidden: new Set<string>(),
  locked: new Set<string>(),
  isHiddenFrom: (sheet: string, row: number, col: number, _p: string) =>
    protection.hidden.has(`${sheet}:${row}:${col}`),
  isCellEditable: (sheet: string, row: number, col: number) => !protection.locked.has(`${sheet}:${row}:${col}`),
};

describe('buildInferenceContext', () => {
  it('maps readable cells and marks #PERM! as denied', () => {
    const cells = {
      'S:0:0': cell('S', 0, 0, 'hello'),
      'S:0:1': { ref: { sheet: 'S', row: 0, col: 1 }, value: err('#PERM!') },
    };
    const ctx = buildInferenceContext(mockHost(cells), protection, 'user');
    const grid = ctx.read('S', { startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
    expect(grid[0][0]).toMatchObject({ value: 'hello', denied: false });
    expect(grid[0][1]).toMatchObject({ denied: true });
  });

  it('authorize delegates reads to hidden state and writes to editable state', () => {
    protection.hidden.add('S:1:1');
    protection.locked.add('S:2:2');
    const ctx = buildInferenceContext(mockHost({}), protection, 'user');
    expect(ctx.authorize('cell.read', 'S!B2')).toBe(false);
    expect(ctx.authorize('cell.read', 'S!A1')).toBe(true);
    expect(ctx.authorize('cell.write', 'S!C3')).toBe(false);
    expect(ctx.authorize('cell.write', 'S!A1')).toBe(true);
    protection.hidden.clear();
    protection.locked.clear();
  });

  it('usedRange returns null for unknown sheets', () => {
    const ctx = buildInferenceContext(mockHost({}), protection, 'user');
    expect(ctx.usedRange('Nope')).toBeNull();
  });
});

describe('readColumnHistory', () => {
  it('collects display strings, skipping blanks and #PERM!', () => {
    const cells = {
      'S:0:0': cell('S', 0, 0, 'Apple'),
      'S:1:0': cell('S', 1, 0, 'apple'),
      'S:2:0': cell('S', 2, 0, ''),
      'S:3:0': { ref: { sheet: 'S', row: 3, col: 0 }, value: err('#PERM!') },
      'S:4:0': cell('S', 4, 0, 42),
    };
    expect(readColumnHistory(mockHost(cells), 'S', 0)).toEqual(['Apple', 'apple', '42']);
  });
});

describe('applyProposal', () => {
  const proposal: Proposal = {
    id: 'cleanup:1',
    kind: 'cleanup',
    title: 'Trim spaces',
    description: 'd',
    edits: [
      { kind: 'setValue', at: { sheet: 'S', row: 0, col: 0 }, text: 'x' },
      { kind: 'setFormula', at: { sheet: 'S', row: 1, col: 0 }, formula: '=1+1' },
    ],
    preview: [],
    previewTotal: 2,
    confidence: 0.9,
    reversible: true,
    bulk: true,
  };

  it('routes setValue/setFormula through host.execute', () => {
    const executed: unknown[] = [];
    const { ok, failed } = applyProposal(mockHost({}, executed), proposal);
    expect(ok).toBe(2);
    expect(failed).toEqual([]);
    expect(executed).toHaveLength(2);
    expect(executed[0]).toMatchObject({ cmd: 'setCell' });
    expect(executed[1]).toMatchObject({ cmd: 'setFormula', formula: '=1+1' });
  });

  it('applies only selected indices for bulk proposals', () => {
    const executed: unknown[] = [];
    const { ok } = applyProposal(mockHost({}, executed), proposal, [1]);
    expect(ok).toBe(1);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ cmd: 'setFormula' });
  });

  it('reports failures without throwing', () => {
    const host = mockHost({});
    (host as unknown as { execute: unknown }).execute = () => ({ ok: false as const, error: 'denied' });
    const { ok, failed } = applyProposal(host, proposal);
    expect(ok).toBe(0);
    expect(failed).toHaveLength(2);
    expect(failed[0].error).toBe('denied');
  });

  it('notifies onDeleteRows after each successful deleteRow (named-range tracking)', () => {
    const deleteCalls: [string, number, number][] = [];
    const executed: unknown[] = [];
    const dupProposal: Proposal = {
      id: 'cleanup:dups',
      kind: 'cleanup',
      title: 'Remove duplicate rows',
      description: 'd',
      edits: [
        { kind: 'deleteRow', at: { sheet: 'S', row: 7, col: 0 } },
        { kind: 'deleteRow', at: { sheet: 'S', row: 3, col: 0 } },
      ],
      preview: [],
      previewTotal: 2,
      confidence: 0.9,
      reversible: false,
      bulk: true,
    };
    const { ok, failed } = applyProposal(
      mockHost({}, executed),
      dupProposal,
      undefined,
      (sheet, row, count) => deleteCalls.push([sheet, row, count]),
    );
    expect(ok).toBe(2);
    expect(failed).toEqual([]);
    // applyProposalEdits orders deletions bottom-up.
    expect(deleteCalls).toEqual([
      ['S', 7, 1],
      ['S', 3, 1],
    ]);
  });

  it('does not notify onDeleteRows when the delete fails', () => {
    const deleteCalls: [string, number, number][] = [];
    const host = mockHost({});
    (host as unknown as { execute: unknown }).execute = () => ({ ok: false as const, error: 'denied' });
    const dupProposal: Proposal = {
      id: 'cleanup:dups',
      kind: 'cleanup',
      title: 'Remove duplicate rows',
      description: 'd',
      edits: [{ kind: 'deleteRow', at: { sheet: 'S', row: 3, col: 0 } }],
      preview: [],
      previewTotal: 1,
      confidence: 0.9,
      reversible: false,
      bulk: true,
    };
    const { ok } = applyProposal(host, dupProposal, undefined, (sheet, row, count) =>
      deleteCalls.push([sheet, row, count]),
    );
    expect(ok).toBe(0);
    expect(deleteCalls).toEqual([]);
  });
});
