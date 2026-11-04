/**
 * Direct-save tests (direct-save pass + Excel save sequence addendum):
 * the desktop main process serializes the LIVE EngineHost through the
 * shared streaming serializer (service/save-node), and the destination
 * write is temp-in-destination-dir → verify → atomic rename.
 *
 * Covers:
 *  - the save-op journal + E1 defined-name merge + extras sanitizing /
 *    sheet-meta forwarding (pure helpers);
 *  - the engine-load save base (source bytes only for xlsx-family,
 *    parsed per-sheet records, reset);
 *  - saveToDestinationAtomically with stub serializers (success,
 *    mid-write throw, verify failure: destination byte-identical, no
 *    temp left behind);
 *  - FORCED-FAILURE EVIDENCE (addendum item 3): the REAL shared
 *    serializer with ICECREAM_SAVE_FAULT_INJECT=midwrite — the save
 *    fails, the pre-existing destination stays byte-identical, no temp
 *    file remains; with the env cleared the same save succeeds and the
 *    output parses back.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineHost, EngineWorkbook } from '@icecream-sheets/engine';
import {
  buildDesktopSheetMetas,
  clearDesktopSaveOps,
  getDesktopSaveOps,
  mergeDefinedNames,
  noteDesktopSaveOp,
  sanitizeDesktopSheetStyles,
  saveToDestinationAtomically,
  serializeDesktopWorkbook,
  tempPathForDestination,
} from '../src/direct-save.js';
import {
  buildWorkbookFromBytes,
  getDesktopSaveBase,
  resetDesktopSaveBase,
} from '../src/engine-load.js';

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'icecream-direct-save-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function leftoverTemps(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes('.icecream-tmp-'));
}

describe('direct-save — op journal', () => {
  beforeEach(() => clearDesktopSaveOps());

  it('journals ops in order, copies refs, and clears', () => {
    noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 } });
    noteDesktopSaveOp({ cmd: 'addSheet' });
    const ops = getDesktopSaveOps();
    expect(ops).toEqual([
      { cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 } },
      { cmd: 'addSheet' },
    ]);
    // The returned journal is a copy: mutating it must not leak back.
    ops.push({ cmd: 'deleteSheet' });
    expect(getDesktopSaveOps()).toHaveLength(2);
    clearDesktopSaveOps();
    expect(getDesktopSaveOps()).toEqual([]);
  });
});

describe('direct-save — mergeDefinedNames (E1 semantics)', () => {
  it('earlier lists win; later lists add only missing names (case-insensitive, scope-keyed)', () => {
    const merged = mergeDefinedNames(
      [{ name: 'Rate', ref: 'S!$A$1' }],
      [
        { name: 'RATE', ref: 'S!$B$2' },
        { name: 'Other', ref: 'S!$C$3' },
        { name: 'Rate', ref: 'S!$D$4', sheet: 0 },
      ],
    );
    expect(merged).toEqual([
      { name: 'Rate', ref: 'S!$A$1' },
      { name: 'Other', ref: 'S!$C$3' },
      { name: 'Rate', ref: 'S!$D$4', sheet: 0 },
    ]);
  });

  it('drops malformed entries instead of failing', () => {
    const merged = mergeDefinedNames(
      [{ name: 7 as never, ref: 'S!$A$1' }, { name: 'Ok', ref: 'S!$A$1' }, null as never],
      undefined,
    );
    expect(merged).toEqual([{ name: 'Ok', ref: 'S!$A$1' }]);
  });
});

describe('direct-save — extras sanitizing + sheet-meta forwarding', () => {
  it('sanitizeDesktopSheetStyles drops malformed entries entry-by-entry', () => {
    expect(sanitizeDesktopSheetStyles(null)).toBeNull();
    expect(sanitizeDesktopSheetStyles('nope')).toBeNull();
    const out = sanitizeDesktopSheetStyles({
      S: { '0:0': { bold: true }, bad: { bold: true }, '1:1': 'nope', '2:2': { italic: true } },
      T: 'nope',
    });
    expect(out).toEqual({ S: { '0:0': { bold: true }, '2:2': { italic: true } } });
  });

  it('buildDesktopSheetMetas forwards only client-reported state (gateway handoff shape)', () => {
    const metas = buildDesktopSheetMetas(['A', 'B'], {
      sheetStyles: { A: { '0:0': { bold: true } } },
      sheetDims: { B: { colWidths: { '0': 42 }, hiddenRows: [3] } },
    });
    expect(metas).toEqual([
      { name: 'A', clientStyles: true, styles: { '0:0': { bold: true } }, clientDims: false },
      {
        name: 'B',
        clientStyles: false,
        clientDims: true,
        dims: { colWidths: { '0': 42 }, hiddenRows: [3] },
      },
    ]);
  });
});

describe('direct-save — tempPathForDestination', () => {
  it('places the temp file in the destination directory', () => {
    const dest = join(tmpdir(), 'some', 'book.xlsx');
    const tmp = tempPathForDestination(dest);
    expect(dirname(tmp)).toBe(dirname(dest));
    expect(basename(tmp)).toContain('.icecream-tmp-');
    expect(basename(tmp)).toContain('book.xlsx');
  });
});

describe('saveToDestinationAtomically — stub serializers', () => {
  let t: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    t = makeTempDir();
  });
  afterEach(() => t.cleanup());

  it('success: verified temp is atomically renamed over the destination', async () => {
    const dest = join(t.dir, 'book.xlsx');
    writeFileSync(dest, 'OLD BYTES');
    const result = await saveToDestinationAtomically(
      (tempPath) => {
        writeFileSync(tempPath, 'NEW BYTES');
        return { mode: 'verbatim' as const };
      },
      dest,
      { verify: () => ({ ok: true }) },
    );
    expect(result).toEqual({ mode: 'verbatim' });
    expect(readFileSync(dest, 'utf8')).toBe('NEW BYTES');
    expect(leftoverTemps(t.dir)).toEqual([]);
  });

  it('mid-write throw: destination byte-identical, no temp left', async () => {
    const dest = join(t.dir, 'book.xlsx');
    const original = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
    writeFileSync(dest, original);
    await expect(
      saveToDestinationAtomically(
        (tempPath) => {
          writeFileSync(tempPath, 'PARTIAL');
          throw new Error('injected save fault (midwrite)');
        },
        dest,
        { verify: () => ({ ok: true }) },
      ),
    ).rejects.toThrow('injected save fault (midwrite)');
    expect(readFileSync(dest)).toEqual(original);
    expect(leftoverTemps(t.dir)).toEqual([]);
  });

  it('verify failure ({ok:false} and throwing forms): destination untouched, no temp left', async () => {
    const dest = join(t.dir, 'book.xlsx');
    writeFileSync(dest, 'KEEP ME');
    await expect(
      saveToDestinationAtomically(
        (tempPath) => {
          writeFileSync(tempPath, 'GARBAGE');
          return 1;
        },
        dest,
        { verify: () => ({ ok: false, error: 'not a package' }) },
      ),
    ).rejects.toThrow('verification failed');
    expect(readFileSync(dest, 'utf8')).toBe('KEEP ME');
    await expect(
      saveToDestinationAtomically(
        (tempPath) => {
          writeFileSync(tempPath, 'GARBAGE');
          return 1;
        },
        dest,
        {
          verify: () => {
            throw new Error('verify exploded');
          },
        },
      ),
    ).rejects.toThrow('verify exploded');
    expect(readFileSync(dest, 'utf8')).toBe('KEEP ME');
    expect(leftoverTemps(t.dir)).toEqual([]);
  });
});

describe('engine-load — desktop save base', () => {
  it(
    'retains source bytes + parsed sheets for xlsx, sourceBytes null for csv, and resets',
    { timeout: 60_000 },
    async () => {
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const bytes = new XlsxAdapter().write({
        sheets: [
          {
            name: 'Data',
            rows: [[1, 2]],
            styles: { '0:0': { bold: true } },
            colWidths: { '0': 33 },
          },
        ],
        metadata: { 'test.meta': 'x' },
      });
      await buildWorkbookFromBytes(bytes, 'book.xlsx');
      let base = getDesktopSaveBase();
      expect(base.sourceBytes).toBeInstanceOf(Uint8Array);
      expect(base.sourceBytes?.length).toBe(bytes.length);
      // The base metadata is the ADAPTER READ's metadata verbatim
      // (whatever the round-trip produced — not the write-side input).
      expect(base.metadata).toEqual(new XlsxAdapter().read(bytes).metadata);
      expect(base.parsedSheets.get('Data')?.styles).toEqual({ '0:0': { bold: true } });
      expect(base.parsedSheets.get('Data')?.colWidths).toEqual({ '0': 33 });

      await buildWorkbookFromBytes(new TextEncoder().encode('a,b\n1,2\n'), 'data.csv');
      base = getDesktopSaveBase();
      expect(base.sourceBytes).toBeNull();

      resetDesktopSaveBase();
      base = getDesktopSaveBase();
      expect(base.sourceBytes).toBeNull();
      expect(base.parsedSheets.size).toBe(0);
      expect(base.metadata).toEqual({});
    },
  );
});

describe('direct-save — REAL serializer + fault injection (Excel sequence)', () => {
  let t: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    t = makeTempDir();
    resetDesktopSaveBase();
    clearDesktopSaveOps();
    delete process.env.ICECREAM_SAVE_FAULT_INJECT;
  });
  afterEach(() => {
    delete process.env.ICECREAM_SAVE_FAULT_INJECT;
    t.cleanup();
  });

  function makeHost(): EngineHost {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1, 2], [3, '=A1+B1']] }));
    const res = host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 99,
    });
    expect(res.ok).toBe(true);
    noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 } });
    return host;
  }

  it(
    'ICECREAM_SAVE_FAULT_INJECT=midwrite: save fails, destination byte-identical, no temp left; cleared env: save succeeds and parses back',
    { timeout: 60_000 },
    async () => {
      const host = makeHost();
      const dest = join(t.dir, 'book.xlsx');
      const original = Buffer.from('PRE-EXISTING DESTINATION BYTES — must survive a failed save');
      writeFileSync(dest, original);

      // Phase 1: fault injected — the shared serializer throws mid-write.
      process.env.ICECREAM_SAVE_FAULT_INJECT = 'midwrite';
      await expect(
        saveToDestinationAtomically(
          (tempPath) => serializeDesktopWorkbook(host, {}, tempPath),
          dest,
        ),
      ).rejects.toThrow('injected save fault (midwrite)');
      expect(readFileSync(dest)).toEqual(original);
      expect(leftoverTemps(t.dir)).toEqual([]);
      expect(existsSync(dest)).toBe(true);

      // Phase 2: fault cleared — the same sequence succeeds, replaces
      // the destination, and the output is a parseable workbook holding
      // the live model's post-edit state.
      delete process.env.ICECREAM_SAVE_FAULT_INJECT;
      const result = await saveToDestinationAtomically(
        (tempPath) => serializeDesktopWorkbook(host, {}, tempPath),
        dest,
      );
      expect(result.mode).toBe('verbatim');
      expect(result.bytes).toBeGreaterThan(0);
      expect(leftoverTemps(t.dir)).toEqual([]);
      const saved = readFileSync(dest);
      expect(saved.equals(original)).toBe(false);
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const data = new XlsxAdapter().read(new Uint8Array(saved));
      const sheet = data.sheets.find((s) => s.name === 'Sheet1');
      expect(sheet).toBeDefined();
      expect(sheet!.rows[0]![0]).toBe(99);
      expect(sheet!.rows[1]![1]).toBe('=A1+B1');
    },
  );

  it(
    'serializeDesktopWorkbook surfaces the serializer mode + stats for a blank workbook',
    { timeout: 60_000 },
    async () => {
      const host = makeHost();
      const out = join(t.dir, 'out.xlsx');
      const result = await serializeDesktopWorkbook(host, {}, out);
      expect(result.mode).toBe('verbatim');
      expect(result.changedSheets).toContain('Sheet1');
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.serializeMs).toBeGreaterThanOrEqual(0);
    },
  );
});
