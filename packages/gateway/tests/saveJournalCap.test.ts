/**
 * Item C regression — the 200k-op save-journal cap (SAVE_OPS_CAP).
 *
 * The save journal (engineSvc) derives the direct serializer's
 * changed-sheet set + planning class. Past 200,000 recorded ops the
 * journal is dropped and runDirectSave forces every sheet changed
 * with per-sheet setCell markers. The DEFECT this file pins: the
 * marker-only ops list erased the journal's structural history, and
 * the ops list is the serializer's ONLY signal that the sheet set
 * changed or setCalculationMode ran (the gateway builds parsedSheets
 * from LIVE sheet names, so the serializer's sheet-set comparison
 * cannot see it). An at-cap save therefore took the verbatim path
 * for a changed sheet set: an added sheet was silently LOST (its
 * part generated but never referenced by the verbatim workbook.xml)
 * and a deleted sheet silently RESURRECTED (its source part copied
 * verbatim), while the cheap package verification still passed.
 *
 * The fix: recordSaveJournalOp maintains a BOUNDED structural
 * summary (saveStructuralCmds — distinct cmds from the finite
 * SAVE_STRUCTURAL_CMDS set, never dropped at the cap) and
 * directSaveOps re-attaches it to the at-cap markers, so the at-cap
 * planning class is identical to the pre-cap plan.
 *
 * These tests unit-drive the EXACT production branch (the exported
 * recordSaveJournalOp / directSaveOps helpers runExecuteInternal and
 * runDirectSave call) past the real 200,000 cap, then feed the
 * resulting ops into the real serializer with gateway-shaped inputs
 * (parsedSheets keyed by live sheet names) and parse the output back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import type { EngineCommand } from '@icecream-sheets/engine';
import {
  serializeLiveWorkbook,
  verifyXlsxPackage,
  type DirectSaveCell,
  type DirectSaveInput,
  type DirectSaveParsedSheet,
} from '@icecream-sheets/service/save-node';
import {
  SAVE_OPS_CAP,
  SAVE_STRUCTURAL_CMDS,
  directSaveOps,
  recordSaveJournalOp,
  resetSaveJournal,
  type SaveJournalState,
} from '../src/services/engineSvc.js';

function freshJournal(): SaveJournalState {
  return { saveOps: [], saveWorkerEligible: true, saveStructuralCmds: new Set<string>() };
}

const setCellCmd = (sheet: string, value: number): EngineCommand =>
  ({ cmd: 'setCell', ref: { sheet, row: 0, col: 0 }, value }) as unknown as EngineCommand;

/** Drive the journal past the cap with cell edits (the drop fires on
 *  the record that arrives when the journal already holds the cap —
 *  op #200,001 from empty, earlier when history precedes it). */
function drivePastCap(journal: SaveJournalState, sheet: string): void {
  for (let i = 0; i <= SAVE_OPS_CAP; i++) {
    recordSaveJournalOp(journal, 'setCell', setCellCmd(sheet, i));
  }
  expect(journal.saveWorkerEligible).toBe(false);
}

// -- serializer fixtures (same shapes as tests/directSave.test.ts) ---

function sourceBytes(): Uint8Array {
  return new XlsxAdapter().write({
    sheets: [
      { name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']] },
      { name: 'Other', rows: [['keep', 42]] },
    ],
    metadata: {},
    definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
  });
}

function cell(sheet: string, row: number, col: number, input: unknown): DirectSaveCell {
  const value =
    typeof input === 'number'
      ? { kind: 'number', value: input }
      : typeof input === 'string' && !input.startsWith('=')
        ? { kind: 'string', value: input }
        : input === '=A1+B1'
          ? { kind: 'number', value: 3 }
          : { kind: 'null', value: null };
  return { ref: { sheet, row, col }, input: input as never, value: value as never };
}

const baseBulk = (): DirectSaveCell[] => [
  cell('Data', 0, 0, 999),
  cell('Data', 0, 1, 2),
  cell('Data', 1, 0, '=A1+B1'),
  cell('Data', 1, 1, 'x'),
  cell('Other', 0, 0, 'keep'),
  cell('Other', 0, 1, 42),
];

describe('save journal cap (SAVE_OPS_CAP = 200,000)', () => {
  const tmpdirs: string[] = [];
  afterEach(() => {
    for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Serialize with gateway-shaped input: parsedSheets keyed by the
   *  LIVE sheet names (exactly what runDirectSave builds). */
  function serialize(liveSheetNames: string[], bulk: DirectSaveCell[], ops: DirectSaveInput['ops']) {
    const dir = mkdtempSync(join(tmpdir(), 'save-journal-cap-'));
    tmpdirs.push(dir);
    const out = join(dir, 'out.xlsx');
    const parsedSheets = new Map<string, DirectSaveParsedSheet>();
    for (const n of liveSheetNames) parsedSheets.set(n, {});
    const result = serializeLiveWorkbook({
      bulk,
      sheetNames: liveSheetNames,
      definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
      metadata: {},
      sourceBytes: sourceBytes(),
      parsedSheets,
      sheets: liveSheetNames.map((n) => ({ name: n, clientStyles: false, clientDims: false })),
      ops,
      outPath: out,
    });
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const back = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
    return { result, back };
  }

  it('journal accounting: cap drops the op list, summary stays bounded', () => {
    const journal = freshJournal();
    recordSaveJournalOp(journal, 'addSheet', { cmd: 'addSheet' } as unknown as EngineCommand);
    drivePastCap(journal, 'Data');
    // The op that crossed the cap dropped the list; post-cap cell ops
    // accumulate again but the journal stays marked incomplete.
    expect(journal.saveOps.length).toBeLessThanOrEqual(SAVE_OPS_CAP);
    expect(journal.saveStructuralCmds).toEqual(new Set(['addSheet']));
    // Boundedness: even hammering every structural cmd cannot grow
    // the summary past the finite cmd set.
    for (const cmd of SAVE_STRUCTURAL_CMDS) {
      recordSaveJournalOp(journal, cmd, { cmd } as unknown as EngineCommand);
    }
    expect(journal.saveStructuralCmds.size).toBe(SAVE_STRUCTURAL_CMDS.size);
  }, 60_000);

  it('pre-cap parity: an intact journal passes its ops through unchanged', () => {
    const journal = freshJournal();
    recordSaveJournalOp(journal, 'addSheet', { cmd: 'addSheet' } as unknown as EngineCommand);
    recordSaveJournalOp(journal, 'setCell', setCellCmd('Data', 5));
    expect(journal.saveWorkerEligible).toBe(true);
    expect(directSaveOps(journal, ['Data', 'Other', 'NewSheet'])).toEqual([
      { cmd: 'addSheet' },
      { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 } },
    ]);
  });

  it('at-cap addSheet: the added sheet SURVIVES the save (was: silently lost)', () => {
    const journal = freshJournal();
    recordSaveJournalOp(journal, 'addSheet', { cmd: 'addSheet' } as unknown as EngineCommand);
    drivePastCap(journal, 'Data');
    const live = ['Data', 'Other', 'NewSheet'];
    const ops = directSaveOps(journal, live);
    // Markers for every sheet PLUS the retained structural signal.
    expect(ops).toContainEqual({ cmd: 'addSheet' });
    expect(ops.filter((o) => o.cmd === 'setCell')).toHaveLength(3);
    const bulk = [...baseBulk(), cell('NewSheet', 0, 0, 'brand-new')];
    const { result, back } = serialize(live, bulk, ops);
    expect(result.mode).toBe('adapter-fallback');
    expect(result.fallbackReason).toBe('structural-op:addSheet');
    expect(back.sheets.map((s) => s.name)).toEqual(['Data', 'Other', 'NewSheet']);
    expect(back.sheets.find((s) => s.name === 'NewSheet')!.rows[0]![0]).toBe('brand-new');
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]![0]).toBe(999);
  }, 60_000);

  it('at-cap deleteSheet: the deleted sheet stays deleted (was: silently resurrected)', () => {
    const journal = freshJournal();
    recordSaveJournalOp(journal, 'deleteSheet', { cmd: 'deleteSheet' } as unknown as EngineCommand);
    drivePastCap(journal, 'Data');
    const live = ['Data'];
    const ops = directSaveOps(journal, live);
    expect(ops).toContainEqual({ cmd: 'deleteSheet' });
    const { result, back } = serialize(live, baseBulk().filter((c) => c.ref.sheet === 'Data'), ops);
    expect(result.mode).toBe('adapter-fallback');
    expect(back.sheets.map((s) => s.name)).toEqual(['Data']);
  }, 60_000);

  it('at-cap setCalculationMode: planning class matches the pre-cap plan', () => {
    const journal = freshJournal();
    recordSaveJournalOp(
      journal,
      'setCalculationMode',
      { cmd: 'setCalculationMode' } as unknown as EngineCommand,
    );
    drivePastCap(journal, 'Data');
    const live = ['Data', 'Other'];
    const { result, back } = serialize(live, baseBulk(), directSaveOps(journal, live));
    expect(result.mode).toBe('adapter-fallback');
    expect(result.fallbackReason).toBe('structural-op:setCalculationMode');
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]![0]).toBe(999);
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);
  }, 60_000);

  it('structural op AFTER the cap is retained too', () => {
    const journal = freshJournal();
    drivePastCap(journal, 'Data');
    recordSaveJournalOp(journal, 'renameSheet', { cmd: 'renameSheet' } as unknown as EngineCommand);
    const ops = directSaveOps(journal, ['DataRenamed', 'Other']);
    expect(journal.saveWorkerEligible).toBe(false);
    expect(ops).toContainEqual({ cmd: 'renameSheet' });
  }, 60_000);

  it('at-cap cell-only history: NO fallback — verbatim with every sheet regenerated, values exact', () => {
    const journal = freshJournal();
    drivePastCap(journal, 'Data');
    const live = ['Data', 'Other'];
    const ops = directSaveOps(journal, live);
    expect(ops).toEqual([
      { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 } },
      { cmd: 'setCell', ref: { sheet: 'Other', row: 0, col: 0 } },
    ]);
    const { result, back } = serialize(live, baseBulk(), ops);
    expect(result.mode).toBe('verbatim');
    expect(result.changedSheets).toEqual(['Data', 'Other']);
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]![0]).toBe(999);
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);
    expect(back.definedNames).toContainEqual({ name: 'Cost', ref: 'Data!$A$1', sheet: undefined });
  }, 60_000);

  it('resetSaveJournal (rehydrate shape) rebuilds the summary from the replayed ops', () => {
    const journal = freshJournal();
    drivePastCap(journal, 'Data');
    resetSaveJournal(journal, [
      { op: { cmd: 'renameSheet' } as unknown as EngineCommand },
      { op: setCellCmd('Data', 1) },
    ]);
    expect(journal.saveWorkerEligible).toBe(true);
    expect(journal.saveOps).toHaveLength(2);
    expect(journal.saveStructuralCmds).toEqual(new Set(['renameSheet']));
    // And a fresh reset (load) clears it entirely.
    resetSaveJournal(journal);
    expect(journal.saveStructuralCmds.size).toBe(0);
    expect(journal.saveOps).toEqual([]);
  }, 60_000);
});
