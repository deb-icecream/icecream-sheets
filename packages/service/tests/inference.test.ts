/**
 * Tests for deterministic inference (design-docs/deterministic-inference.md):
 * autocomplete, formula suggestions, cleanup proposals, the proposal model,
 * and permission gating. Analyzers run against a fake InferenceContext —
 * no engine, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  FUNCTION_CATALOG,
  applyProposalEdits,
  autocompleteFormula,
  cleanupProposalsForSheet,
  completionAtCaret,
  nextProposalId,
  profileColumns,
  rangeColumnsFromGrid,
  selectProposalEdits,
  suggestCellValues,
  suggestFormulasForSheet,
  suggestFunctions,
  suggestRangeRefs,
  type InferenceCell,
  type InferenceContext,
  type Proposal,
  type RangeBounds,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fake host context
// ---------------------------------------------------------------------------

type Raw = string | number | boolean | null;

function makeCtx(
  rows: Raw[][],
  opts: {
    denied?: Set<string>; // 'row,col'
    authorize?: (action: string, target: string) => boolean;
    sheet?: string;
  } = {},
): InferenceContext {
  const sheet = opts.sheet ?? 'Sheet1';
  const denied = opts.denied ?? new Set<string>();
  const authorize = opts.authorize ?? (() => true);
  const toCell = (r: number, c: number): InferenceCell => {
    if (denied.has(`${r},${c}`)) return { value: null, denied: true };
    return { value: rows[r]?.[c] ?? null, denied: false };
  };
  return {
    principal: 'user:test',
    usedRange: () =>
      rows.length === 0
        ? null
        : {
            startRow: 0,
            startCol: 0,
            endRow: rows.length - 1,
            endCol: Math.max(...rows.map((r) => r.length)) - 1,
          },
    read: (_s: string, b: RangeBounds) => {
      const out: InferenceCell[][] = [];
      for (let r = b.startRow; r <= b.endRow; r++) {
        const row: InferenceCell[] = [];
        for (let c = b.startCol; c <= b.endCol; c++) row.push(toCell(r, c));
        out.push(row);
      }
      return out;
    },
    authorize,
  };
}

// ---------------------------------------------------------------------------
// Autocomplete: cell values
// ---------------------------------------------------------------------------

describe('suggestCellValues', () => {
  const history = ['Apple', 'apricot', 'Apple', 'Banana', 'apple pie', 'Apple'];
  it('ranks by frequency then alphabetically, case-insensitive prefix', () => {
    const s = suggestCellValues(history, 'ap');
    expect(s.map((x) => x.text)).toEqual(['Apple', 'apple pie', 'apricot']);
    expect(s[0].count).toBe(3);
  });
  it('skips the exact already-typed value', () => {
    expect(suggestCellValues(['Apple', 'apricot'], 'apricot')).toEqual([]);
    // ...but longer values sharing the prefix are still completable.
    expect(suggestCellValues(history, 'apple').map((x) => x.text)).toEqual(['apple pie']);
  });
  it('caps at max and ignores empties', () => {
    const s = suggestCellValues(['', 'b1', 'b2', 'b3'], 'b', { max: 2 });
    expect(s).toHaveLength(2);
  });
  it('is deterministic across runs', () => {
    const a = suggestCellValues(history, 'a');
    const b = suggestCellValues(history, 'a');
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Autocomplete: functions (generated catalog)
// ---------------------------------------------------------------------------

describe('function catalog', () => {
  it('enumerates the engine function set', () => {
    expect(FUNCTION_CATALOG.length).toBeGreaterThan(500);
    const names = new Set(FUNCTION_CATALOG.map((f) => f.name));
    for (const n of ['SUM', 'AVERAGE', 'XLOOKUP', 'TEXTJOIN', 'VALUE', 'REGEXTEST', 'LET', 'LAMBDA']) {
      expect(names.has(n)).toBe(true);
    }
  });
  it('is sorted and unique', () => {
    const names = FUNCTION_CATALOG.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
  });
});

describe('suggestFunctions', () => {
  it('returns prefix matches with exact match first', () => {
    const s = suggestFunctions('sum');
    expect(s[0].name).toBe('SUM');
    expect(s.every((x) => x.name.startsWith('SUM'))).toBe(true);
  });
  it('carries category and signature hints', () => {
    const s = suggestFunctions('xlookup');
    expect(s[0]).toMatchObject({ name: 'XLOOKUP', category: 'Lookup & Reference' });
    expect(s[0].signature).toContain('XLOOKUP(');
  });
  it('returns [] for empty prefix', () => {
    expect(suggestFunctions('')).toEqual([]);
    expect(suggestFunctions('   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Autocomplete: range references
// ---------------------------------------------------------------------------

describe('suggestRangeRefs', () => {
  const cols = [
    { letter: 'A', header: 'Name', firstDataRow: 2, lastDataRow: 10 },
    { letter: 'B', header: 'Amount', firstDataRow: 2, lastDataRow: 10 },
    { letter: 'C', header: '', firstDataRow: 2, lastDataRow: 1 },
  ];
  it('suggests bounded data ranges labeled by header', () => {
    const s = suggestRangeRefs('', cols);
    expect(s.map((x) => x.ref)).toEqual(['A2:A10', 'B2:B10']);
    expect(s[1].label).toBe('B2:B10 — Amount');
  });
  it('filters on column-letter or header prefix', () => {
    expect(suggestRangeRefs('b', cols).map((x) => x.ref)).toEqual(['B2:B10']);
    expect(suggestRangeRefs('amo', cols).map((x) => x.ref)).toEqual(['B2:B10']);
  });
});

describe('rangeColumnsFromGrid', () => {
  it('builds column info from a used-range grid', () => {
    const grid = [
      [{ value: 'Name', denied: false }, { value: 'Amount', denied: false }],
      [{ value: 'a', denied: false }, { value: 1, denied: false }],
      [{ value: 'b', denied: false }, { value: null, denied: false }],
      [{ value: 'c', denied: false }, { value: 3, denied: false }],
    ];
    const cols = rangeColumnsFromGrid(grid, 0, 0);
    expect(cols).toEqual([
      { letter: 'A', header: 'Name', firstDataRow: 2, lastDataRow: 4 },
      { letter: 'B', header: 'Amount', firstDataRow: 2, lastDataRow: 4 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Formula-draft token analysis
// ---------------------------------------------------------------------------

describe('completionAtCaret', () => {
  it('detects function completion after = ( , and operators', () => {
    expect(completionAtCaret('=SU', 3)).toEqual({ kind: 'function', prefix: 'SU' });
    expect(completionAtCaret('=SUM(A1,MA', 10)).toEqual({ kind: 'function', prefix: 'MA' });
    expect(completionAtCaret('=1+IF', 5)).toEqual({ kind: 'function', prefix: 'IF' });
  });
  it('detects range completion for A1-style tokens', () => {
    expect(completionAtCaret('=SUM(A1', 7)).toEqual({ kind: 'range', prefix: 'A1' });
    expect(completionAtCaret('=A', 2)).toEqual({ kind: 'function', prefix: 'A' });
  });
  it('returns null inside string literals, after complete tokens, and for plain text', () => {
    expect(completionAtCaret('="ab', 4)).toBeNull();
    expect(completionAtCaret('=SUM(A1)', 8)).toBeNull();
    expect(completionAtCaret("='Sheet 1'!A", 11)).toBeNull();
    expect(completionAtCaret('hello', 5)).toBeNull();
  });
});

describe('autocompleteFormula', () => {
  const cols = [{ letter: 'A', header: 'Name', firstDataRow: 2, lastDataRow: 10 }];
  it('returns function suggestions for a name prefix', () => {
    const r = autocompleteFormula('=SU', 3, cols);
    expect(r?.kind).toBe('function');
    expect(r?.functions[0].name).toBe('SUBSTITUTE');
    expect(r?.functions.map((f) => f.name)).toContain('SUM');
  });
  it('offers ranges alongside short bare-letter prefixes', () => {
    const r = autocompleteFormula('=A', 2, cols);
    expect(r?.kind).toBe('function');
    expect(r?.functions.length).toBeGreaterThan(0);
    expect(r?.ranges.map((x) => x.ref)).toContain('A2:A10');
  });
  it('returns range suggestions for an A1 prefix', () => {
    const r = autocompleteFormula('=SUM(A1', 7, cols);
    expect(r?.kind).toBe('range');
    expect(r?.ranges[0].ref).toBe('A2:A10');
  });
});

// ---------------------------------------------------------------------------
// Formula suggestions
// ---------------------------------------------------------------------------

describe('suggestFormulasForSheet', () => {
  it('suggests SUM for a "Total"-adjacent numeric column via total-row rule', () => {
    const ctx = makeCtx([['Item', 'Amount'], ['a', 10], ['b', 20], ['c', 30]]);
    const proposals = suggestFormulasForSheet(ctx, 'Sheet1');
    const sum = proposals.find((p) => p.edits[0]?.kind === 'setFormula' && (p.edits[0] as { formula: string }).formula === '=SUM(B2:B4)');
    expect(sum).toBeDefined();
    expect(sum!.edits[0]).toMatchObject({ kind: 'setFormula', at: { row: 4, col: 1 } });
  });
  it('maps header keywords: Average -> AVERAGE, Count -> COUNTA', () => {
    const ctx = makeCtx([
      ['Region', 'Average Sales', 'Count'],
      ['n', 10, 'x'],
      ['s', 20, 'y'],
    ]);
    const proposals = suggestFormulasForSheet(ctx, 'Sheet1');
    const formulas = proposals.flatMap((p) =>
      p.edits.filter((e) => e.kind === 'setFormula').map((e) => (e as { formula: string }).formula),
    );
    expect(formulas).toContain('=AVERAGE(B2:B3)');
    expect(formulas).toContain('=COUNTA(C2:C3)');
  });
  it('suggests line totals for adjacent Qty/Price columns', () => {
    const ctx = makeCtx([
      ['Qty', 'Price'],
      [2, 5],
      [3, 7],
    ]);
    const proposals = suggestFormulasForSheet(ctx, 'Sheet1');
    const formulas = proposals.flatMap((p) =>
      p.edits.filter((e) => e.kind === 'setFormula').map((e) => (e as { formula: string }).formula),
    );
    expect(formulas).toContain('=A2*B2');
  });
  it('suggests a full-name formula for First/Last name columns', () => {
    const ctx = makeCtx([
      ['First', 'Last'],
      ['Ada', 'Lovelace'],
      ['Alan', 'Turing'],
    ]);
    const proposals = suggestFormulasForSheet(ctx, 'Sheet1');
    const formulas = proposals.flatMap((p) =>
      p.edits.filter((e) => e.kind === 'setFormula').map((e) => (e as { formula: string }).formula),
    );
    expect(formulas).toContain('=A2&" "&B2');
  });
  it('does not generate proposals for non-writable target cells', () => {
    const ctx = makeCtx([['Item', 'Amount'], ['a', 10], ['b', 20]], {
      authorize: (action, target) => !(action === 'cell.write' && target === 'Sheet1!B4'),
    });
    const proposals = suggestFormulasForSheet(ctx, 'Sheet1');
    const formulas = proposals.flatMap((p) =>
      p.edits.filter((e) => e.kind === 'setFormula').map((e) => (e as { formula: string }).formula),
    );
    expect(formulas).not.toContain('=SUM(B2:B3)');
  });
  it('returns [] for an empty sheet', () => {
    expect(suggestFormulasForSheet(makeCtx([]), 'Sheet1')).toEqual([]);
  });
});

describe('profileColumns', () => {
  it('detects numeric majorities and skips denied cells', () => {
    const grid: InferenceCell[][] = [
      [{ value: 'A', denied: false }, { value: 'B', denied: false }],
      [{ value: 1, denied: false }, { value: 'x', denied: false }],
      [{ value: 2, denied: false }, { value: 'y', denied: false }],
      [{ value: 3, denied: true }, { value: 'z', denied: false }],
    ];
    const cols = profileColumns('S', grid, 0, 0);
    expect(cols[0].numeric).toBe(true);
    expect(cols[0].values).toEqual([1, 2]);
    expect(cols[1].numeric).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cleanup proposals
// ---------------------------------------------------------------------------

describe('cleanupProposalsForSheet', () => {
  it('detects trailing whitespace', () => {
    const ctx = makeCtx([['Name'], ['Ada  '], [' Alan'], ['Grace']]);
    const proposals = cleanupProposalsForSheet(ctx, 'Sheet1');
    const p = proposals.find((x) => x.title.includes('trailing spaces'));
    expect(p).toBeDefined();
    expect(p!.edits).toHaveLength(2);
    expect(p!.bulk).toBe(true);
    expect(p!.preview[0]).toMatchObject({ before: 'Ada  ', after: 'Ada' });
  });
  it('detects mixed types: numeric text inside a numeric column', () => {
    const ctx = makeCtx([['Amount'], [10], [20], ['30'], [40]]);
    const proposals = cleanupProposalsForSheet(ctx, 'Sheet1');
    const p = proposals.find((x) => x.title.includes('mixed types'));
    expect(p).toBeDefined();
    expect(p!.edits).toHaveLength(1);
    expect(p!.edits[0]).toMatchObject({ kind: 'setValue', text: '30' });
  });
  it('standardizes inconsistent boolean spellings to the majority', () => {
    const ctx = makeCtx([['Active'], ['Yes'], ['Yes'], ['TRUE'], ['No']]);
    const proposals = cleanupProposalsForSheet(ctx, 'Sheet1');
    const p = proposals.find((x) => x.title.includes('boolean'));
    expect(p).toBeDefined();
    // True-words converge on the majority true spelling ('Yes'); the
    // false-word ('No') is already consistent and untouched.
    expect(p!.preview).toHaveLength(1);
    expect(p!.preview[0]).toMatchObject({ before: 'TRUE', after: 'Yes' });
  });
  it('detects duplicate rows (later copies proposed for deletion)', () => {
    const ctx = makeCtx([
      ['Name', 'Age'],
      ['Ada', 36],
      ['Alan', 41],
      ['Ada', 36],
    ]);
    const proposals = cleanupProposalsForSheet(ctx, 'Sheet1');
    const p = proposals.find((x) => x.title.includes('duplicate'));
    expect(p).toBeDefined();
    expect(p!.edits).toHaveLength(1);
    expect(p!.edits[0]).toMatchObject({ kind: 'deleteRow', at: { row: 3 } });
  });
  it('marks duplicate-row proposals non-reversible (structural delete)', () => {
    const ctx = makeCtx([
      ['Name', 'Age'],
      ['Ada', 36],
      ['Alan', 41],
      ['Ada', 36],
    ]);
    const proposals = cleanupProposalsForSheet(ctx, 'Sheet1');
    const dup = proposals.find((x) => x.title.includes('duplicate'));
    expect(dup!.reversible).toBe(false);
    expect(dup!.description).toContain('cannot be undone');
    for (const p of proposals) {
      if (p !== dup) expect(p.reversible).toBe(true);
    }
  });
  it('does not flag duplicates when a cell is denied (could hide a difference)', () => {
    const ctx = makeCtx(
      [
        ['Name', 'Age'],
        ['Ada', 36],
        ['Ada', 36],
      ],
      { denied: new Set(['2,1']) },
    );
    const proposals = cleanupProposalsForSheet(ctx, 'Sheet1');
    expect(proposals.find((x) => x.title.includes('duplicate'))).toBeUndefined();
  });
  it('filters edits on non-writable cells and notes the omission', () => {
    const ctx = makeCtx([['Name'], ['Ada  '], ['Bob  ']], {
      authorize: (action, target) => !(action === 'cell.write' && target === 'Sheet1!A2'),
    });
    const proposals = cleanupProposalsForSheet(ctx, 'Sheet1');
    const p = proposals.find((x) => x.title.includes('trailing spaces'));
    expect(p!.edits).toHaveLength(1);
    expect(p!.description).toContain('no write permission');
  });
  it('never rewrites formula cells', () => {
    const ctx = makeCtx([['A'], ['x  ']]);
    // mark the cell as a formula cell via a wrapped context
    const inner = ctx.read;
    const wrapped: InferenceContext = {
      ...ctx,
      read: (s, b) => inner(s, b).map((row) => row.map((c) => ({ ...c, formula: '=1+1' }))),
    };
    const proposals = cleanupProposalsForSheet(wrapped, 'Sheet1');
    expect(proposals.find((x) => x.title.includes('trailing spaces'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Proposal model
// ---------------------------------------------------------------------------

describe('proposal model', () => {
  const proposal: Proposal = {
    id: nextProposalId('cleanup'),
    kind: 'cleanup',
    title: 't',
    description: 'd',
    edits: [
      { kind: 'setValue', at: { sheet: 'S', row: 1, col: 0 }, text: 'a' },
      { kind: 'setValue', at: { sheet: 'S', row: 2, col: 0 }, text: 'b' },
      { kind: 'deleteRow', at: { sheet: 'S', row: 5, col: 0 } },
    ],
    preview: [
      { at: { sheet: 'S', row: 1, col: 0 }, before: 'a ', after: 'a' },
      { at: { sheet: 'S', row: 2, col: 0 }, before: 'b ', after: 'b' },
      { at: { sheet: 'S', row: 5, col: 0 }, before: 'row 6', after: '(row deleted)' },
    ],
    previewTotal: 3,
    confidence: 0.9,
    reversible: true,
    bulk: true,
  };

  it('selectProposalEdits supports selective apply', () => {
    const sel = selectProposalEdits(proposal, [0, 2]);
    expect(sel.edits).toHaveLength(2);
    expect(sel.edits[0]).toMatchObject({ at: { row: 1 } });
    expect(sel.edits[1]).toMatchObject({ kind: 'deleteRow' });
    expect(sel.preview).toHaveLength(2);
    expect(sel.description).toContain('2 of 3');
  });

  it('selectProposalEdits ignores out-of-range indices', () => {
    expect(selectProposalEdits(proposal, [7, -1]).edits).toHaveLength(0);
  });

  it('applyProposalEdits applies deleteRow edits bottom-up and reports results', () => {
    const order: number[] = [];
    const results = applyProposalEdits(proposal.edits, (edit) => {
      order.push(edit.at.row);
      return edit.at.row === 2 ? { ok: false, error: 'denied' } : { ok: true };
    });
    // setValue edits first (proposal order), then the deletion
    expect(order).toEqual([1, 2, 5]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].error).toBe('denied');
  });

  it('applyProposalEdits orders multiple deletions bottom-up', () => {
    const order: number[] = [];
    applyProposalEdits(
      [
        { kind: 'deleteRow', at: { sheet: 'S', row: 2, col: 0 } },
        { kind: 'deleteRow', at: { sheet: 'S', row: 7, col: 0 } },
      ],
      (edit) => {
        order.push(edit.at.row);
        return { ok: true };
      },
    );
    expect(order).toEqual([7, 2]);
  });
});
