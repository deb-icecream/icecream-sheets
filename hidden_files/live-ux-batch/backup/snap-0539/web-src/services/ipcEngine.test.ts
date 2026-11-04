/**
 * Tests for the desktop renderer's IPC-backed engine host (Cycle 10 —
 * engine/view separation): IpcEngineHost over a mock window.icecream
 * bridge. Proves the SYNC-READ contract (Cycle 10 boot fix, mirroring
 * RemoteView): readCell/readRange/view reads return real TypedValues
 * synchronously from the read-through cache — never a Promise — with
 * the null placeholder on a cache miss, a deduped background IPC fill,
 * and a scoped cellsChanged event when the fill lands so the grid
 * repaints. (The previous async-cast contract is what crashed the
 * desktop boot: FormulaBar read `.value` off a Promise.) Also proves:
 * load/execute round-trips (writes stay async), the optimistic display
 * overlay, snapshot() as a sync cache read + snapshotAsync() pull,
 * event-scoped invalidation, engine-event fan-out, and timeout/dispose
 * behavior. The renderer never runs an engine: every fill crosses the
 * (mock) IPC bridge.
 */
import { describe, expect, it, vi } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import type {
  CellRef,
  EngineEvent,
  EngineLoadResult,
  TypedValue,
} from '@icecream-sheets/engine';
import { IpcEngineHost, type IpcEngineBridge } from './ipcEngine';

const A1: CellRef = { sheet: 'Sheet1', row: 0, col: 0 };
const B2: CellRef = { sheet: 'Sheet1', row: 1, col: 1 };

interface MockBridge extends IpcEngineBridge {
  emit(event: EngineEvent): void;
  calls: { execute: number; readCell: number; readRange: number; load: number; snapshot: number };
}

function makeBridge(overrides: Partial<IpcEngineBridge> = {}): MockBridge {
  let eventCb: ((event: EngineEvent) => void) | null = null;
  const calls = { execute: 0, readCell: 0, readRange: 0, load: 0, snapshot: 0 };
  const base: IpcEngineBridge = {
    execute: async () => {
      calls.execute += 1;
      return { ok: true };
    },
    readCell: async (ref) => {
      calls.readCell += 1;
      return { value: { kind: 'number', value: ref.row * 10 + ref.col } };
    },
    readRange: async (range) => {
      calls.readRange += 1;
      const out: TypedValue[][] = [];
      for (let r = range.startRow; r <= range.endRow; r++) {
        const row: TypedValue[] = [];
        for (let c = range.startCol; c <= range.endCol; c++) row.push({ kind: 'number', value: r * 10 + c });
        out.push(row);
      }
      return out;
    },
    usedRange: async () => ({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 9, endCol: 9 }),
    snapshot: async () => {
      calls.snapshot += 1;
      return { protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] };
    },
    protocolVersion: async () => 1,
    load: async () => {
      calls.load += 1;
      const result: EngineLoadResult = {
        sheets: [{ name: 'Data' }, { name: 'Calc' }],
        metadata: {},
      };
      return result;
    },
    newWorkbook: async () => undefined,
    setProtection: async () => undefined,
    onEngineEvent: (cb) => {
      eventCb = cb;
      return () => {
        eventCb = null;
      };
    },
    ...overrides,
  };
  return {
    ...base,
    calls,
    emit: (event) => eventCb?.(event),
  };
}

describe('IpcEngineHost — protocol round-trips', () => {
  it('loadIpc returns the load result and caches sheet names', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    const res = await host.loadIpc(new Uint8Array([1, 2, 3]), 'book.xlsx');
    expect(res.sheets.map((s) => s.name)).toEqual(['Data', 'Calc']);
    expect(host.sheetNames()).toEqual(['Data', 'Calc']);
    expect(bridge.calls.load).toBe(1);
    host.dispose();
  });

  it('loadIpc hands the bridge the SAME Uint8Array (binary transfer, no Array.from copy)', async () => {
    let seen: unknown = null;
    const bridge = makeBridge({
      load: async (bytes) => {
        seen = bytes;
        return { sheets: [{ name: 'Data' }], metadata: {} };
      },
    });
    const host = new IpcEngineHost(() => bridge);
    const bytes = new Uint8Array([9, 8, 7]);
    await host.loadIpc(bytes, 'book.xlsx');
    // Identity, not just equality: any per-byte conversion would have
    // produced a number[] (the P75-open renderer stall this guards).
    expect(seen).toBe(bytes);
    expect(seen).toBeInstanceOf(Uint8Array);
    host.dispose();
  });

  it('readRange is SYNC: placeholder matrix on miss, real values after the background fill', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    expect(host.hasCell(A1)).toBe(false); // UNLOADED, not empty
    const range = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const first = host.readRange(range);
    // Synchronous, correctly shaped, placeholder — NOT a Promise.
    expect(first).not.toBeInstanceOf(Promise);
    expect(first).toEqual([
      [{ kind: 'null', value: null }, { kind: 'null', value: null }],
      [{ kind: 'null', value: null }, { kind: 'null', value: null }],
    ]);
    expect(host.hasCell(B2)).toBe(false); // fill has not landed yet
    await host.whenReadsIdle();
    const second = host.readRange(range);
    expect(second[1]![1]).toEqual({ kind: 'number', value: 11 });
    expect(host.hasCell(B2)).toBe(true); // now LOADED
    expect(bridge.calls.readRange).toBe(1); // one deduped fill for both reads
    host.dispose();
  });

  it('readCell is SYNC: placeholder on miss, background fill + scoped event, then cache hits', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    const events: EngineEvent[] = [];
    host.subscribe((e) => events.push(e));
    const v1 = host.readCell(A1);
    expect(v1).not.toBeInstanceOf(Promise);
    expect(v1).toEqual({ kind: 'null', value: null }); // placeholder-on-miss
    expect(host.readCell(A1)).toEqual({ kind: 'null', value: null }); // deduped, still filling
    await host.whenReadsIdle();
    // The fill fired the scoped repaint event for exactly the filled ref.
    expect(events).toContainEqual({ type: 'cellsChanged', refs: [A1] });
    const v2 = host.readCell(A1);
    expect(v2).toEqual({ kind: 'number', value: 0 });
    expect(bridge.calls.readCell).toBe(1); // one IPC round-trip total
    host.dispose();
  });

  it('view reads are SYNC too (the FormulaBar/Grid surface that crashed the boot)', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    const view = host.getView();
    const cold = view.readCell(A1);
    expect(cold).not.toBeInstanceOf(Promise);
    expect(cold.value).toEqual({ kind: 'null', value: null }); // .value exists synchronously
    const coldRange = view.readRange({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
    expect(coldRange[0]![0]!.value).toEqual({ kind: 'null', value: null });
    await host.whenReadsIdle();
    expect(view.readCell(A1).value).toEqual({ kind: 'number', value: 0 });
    view.readCell(B2); // queues B2's own fill
    await host.whenReadsIdle();
    expect(view.readCell(B2).value).toEqual({ kind: 'number', value: 11 });
    expect(view.readRange({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 })[0]![0]!.value).toEqual({
      kind: 'number',
      value: 0,
    });
    host.dispose();
  });

  it('readCellAsync/readRangeAsync await the same fills', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    await expect(host.readCellAsync(A1)).resolves.toEqual({ value: { kind: 'number', value: 0 } });
    const values = await host.readRangeAsync({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(values[1]![1]).toEqual({ kind: 'number', value: 11 });
    host.dispose();
  });

  it('getUsedRange is SYNC: null on miss, cached range after the fill', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    expect(host.getView().usedRange('Sheet1')).toBeNull();
    await host.whenReadsIdle();
    expect(host.getView().usedRange('Sheet1')).toEqual({
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 9,
    });
    host.dispose();
  });

  it('snapshot() is a SYNC cache read; snapshotAsync pulls and caches the real snapshot', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    const cold = host.snapshot();
    expect(cold).not.toBeInstanceOf(Promise);
    expect(Array.isArray(cold.sheets)).toBe(true); // name-only fallback, never a Promise
    const pulled = await host.snapshotAsync();
    expect(pulled.sheets[0]!.name).toBe('Sheet1');
    expect(host.snapshot()).toBe(pulled); // cached: same object, no new pull
    expect(host.sheetNames()).toEqual(['Sheet1']);
    expect(bridge.calls.snapshot).toBe(1);
    host.dispose();
  });
});

describe('IpcEngineHost — fill-notification coalescing (Cycle 10 closure)', () => {
  it('merges simultaneous fill landings into ONE cellsChanged with the union of refs', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    const events: EngineEvent[] = [];
    host.subscribe((e) => events.push(e));
    // Three independent fills queued in the same turn (one cell, one
    // more cell, one range covering both plus two more).
    host.readCell(A1);
    host.readCell(B2);
    host.readRange({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    await host.whenReadsIdle();
    const changed = events.filter((e) => e.type === 'cellsChanged');
    // Without coalescing this was three events (three full App renders
    // in the packaged app); the batch must be exactly one, carrying
    // every filled ref exactly once.
    expect(changed).toHaveLength(1);
    const refs = (changed[0] as { refs: CellRef[] }).refs;
    expect(new Set(refs.map((r) => `${r.row},${r.col}`))).toEqual(new Set(['0,0', '0,1', '1,0', '1,1']));
    host.dispose();
  });

  it('an immediate emit (optimistic edit) flushes the pending fill batch first, preserving order', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    const events: EngineEvent[] = [];
    host.subscribe((e) => events.push(e));
    host.readCell(A1); // fill lands async, notification coalesced
    await host.whenReadsIdle(); // (flush point — batch delivered here)
    expect(events).toHaveLength(1);
    await host.execute({ cmd: 'setCell', ref: B2, value: 5 });
    // The optimistic emit is immediate and synchronous in effect: it is
    // the LAST event, after the fill batch.
    expect(events[events.length - 1]).toEqual({ type: 'cellsChanged', refs: [B2] });
    host.dispose();
  });
});

describe('IpcEngineHost — optimistic display', () => {
  it('paints the typed value BEFORE the engine replies, then settles', async () => {
    let resolveExecute: ((v: { ok: true }) => void) | null = null;
    const bridge = makeBridge({
      execute: () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveExecute = resolve;
        }),
    });
    const host = new IpcEngineHost(() => bridge);
    const events: EngineEvent[] = [];
    host.subscribe((e) => events.push(e));
    const p = host.execute({ cmd: 'setCell', ref: A1, value: 42 }) as unknown as Promise<{ ok: boolean }>;
    // The overlay is synchronous: the typed cell shows 42 immediately,
    // and a scoped cellsChanged fires for exactly that ref.
    expect(host.optimisticEntry(A1)?.value).toEqual({ kind: 'number', value: 42 });
    expect(events).toEqual([{ type: 'cellsChanged', refs: [A1] }]);
    const shown = host.readCell(A1);
    expect(shown).toEqual({ kind: 'number', value: 42 });
    expect(bridge.calls.readCell).toBe(0); // no IPC needed for the overlay
    resolveExecute!({ ok: true });
    await expect(p).resolves.toEqual({ ok: true });
    host.dispose();
  });

  it('drops the overlay when the engine denies the edit', async () => {
    const bridge = makeBridge({
      execute: async () => ({ ok: false, error: 'Denied by policy' }),
    });
    const host = new IpcEngineHost(() => bridge);
    const res = (await host.execute({ cmd: 'setCell', ref: A1, value: 42 })) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(host.optimisticEntry(A1)).toBeUndefined();
    host.dispose();
  });

  it('formula edits overlay the formula text (value pending, not stale)', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    await host.execute({ cmd: 'setFormula', ref: A1, formula: '=1+1' });
    expect(host.optimisticEntry(A1)?.formula).toBe('=1+1');
    host.dispose();
  });
});

describe('IpcEngineHost — engine events (main → renderer)', () => {
  it('fans events out untouched and invalidates exactly the named refs', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    host.readCell(A1);
    host.readCell(B2);
    await host.whenReadsIdle();
    expect(bridge.calls.readCell).toBe(2);
    expect(host.hasCell(A1)).toBe(true);
    expect(host.hasCell(B2)).toBe(true);
    const seen: EngineEvent[] = [];
    host.subscribe((e) => seen.push(e));
    bridge.emit({ type: 'cellsChanged', refs: [A1] });
    expect(seen).toEqual([{ type: 'cellsChanged', refs: [A1] }]);
    expect(host.hasCell(A1)).toBe(false); // invalidated → will re-stream
    expect(host.hasCell(B2)).toBe(true); // untouched ref keeps its value (scoped)
    host.dispose();
  });

  it('sheetAdded/sheetRemoved keep the name cache live; recalcComplete settles overlays', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    await host.loadIpc(new Uint8Array([0]), 'b.xlsx');
    bridge.emit({ type: 'sheetAdded', name: 'New' });
    expect(host.sheetNames()).toEqual(['Data', 'Calc', 'New']);
    bridge.emit({ type: 'sheetRemoved', name: 'Calc' });
    expect(host.sheetNames()).toEqual(['Data', 'New']);
    await host.execute({ cmd: 'setCell', ref: A1, value: 7 });
    expect(host.optimisticEntry(A1)).toBeDefined();
    bridge.emit({ type: 'recalcComplete' });
    expect(host.optimisticEntry(A1)).toBeUndefined();
    host.dispose();
  });
});

describe('IpcEngineHost — E3: edited formula cell display refresh (W10 R2 formula leg)', () => {
  // Bridge backed by a REAL EngineHost — the packaged main process.
  // Crucially, a real setCell/setFormula execute emits cellsChanged
  // ONLY: no recalcComplete follows an ordinary edit (protocol.ts
  // executeInner emits recalcComplete only for explicit recalcs and
  // workbook swaps). The undoAsync mock emits recalcComplete after
  // every edit, which is why this defect survived that suite.
  function makeRealBridge() {
    const main = new EngineHost();
    main.execute({ cmd: 'setCell', ref: C9, value: 0.0833333333333333 });
    main.execute({ cmd: 'setFormula', ref: C13, formula: '=C9*1595314.6' });
    let eventCb: ((e: EngineEvent) => void) | null = null;
    main.subscribe((e) => eventCb?.(e));
    const bridge: IpcEngineBridge = {
      execute: async (cmd) => main.execute(cmd),
      readCell: async (ref) => {
        const cell = main.getView().readCell(ref);
        return cell.formula !== undefined
          ? { value: cell.value, formula: cell.formula }
          : { value: cell.value };
      },
      readRange: async (range) => main.readRange(range),
      usedRange: async (sheet) => main.getUsedRange(sheet),
      snapshot: async () => main.snapshot(),
      protocolVersion: async () => 1,
      load: async () => ({ sheets: [{ name: 'Sheet1' }], metadata: {} }),
      newWorkbook: async () => undefined,
      setProtection: async () => undefined,
      onEngineEvent: (cb) => {
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
    };
    return { bridge, main };
  }

  const C9: CellRef = { sheet: 'Sheet1', row: 8, col: 2 };
  const C13: CellRef = { sheet: 'Sheet1', row: 12, col: 2 };

  it('formula→formula edit: the edited cell cached display value updates after execute + fill cycle', async () => {
    const { bridge, main } = makeRealBridge();
    const host = new IpcEngineHost(() => bridge);
    // Prime the renderer cache as the grid render would (W10: C13
    // displayed 132,942.8834 before the edit — same shape here).
    host.readCell(C13);
    await host.whenReadsIdle();
    const before = host.getView().readCell(C13).value;
    expect(before.kind).toBe('number');
    if (before.kind !== 'number') throw new Error('unreachable');
    expect(before.value).toBeCloseTo(132942.88, 2);

    // The W10 edit: MONTHLY C13 := =C9*100 → 8.3333…
    await host.execute({ cmd: 'setFormula', ref: C13, formula: '=C9*100' });
    expect(main.getView().readCell(C13).value).toEqual({ kind: 'number', value: 8.33333333333333 });
    // Grid repaint reads + fill cycle: the display must follow the
    // engine. Before the fix it stayed at the pre-edit value forever
    // (the setFormula overlay holds the OLD value and only a
    // recalcComplete — which a plain edit never emits — cleared it).
    host.readCell(C13);
    await host.whenReadsIdle();
    expect(host.getView().readCell(C13).value).toEqual({ kind: 'number', value: 8.33333333333333 });
    expect(host.getView().readCell(C13).formula).toBe('=C9*100');
    expect(host.optimisticEntry(C13)).toBeUndefined();

    // Undo leg (restore execute, as UndoManager issues it): the display
    // reverts too — and redo reapplies. Both are formula→formula edits.
    await host.execute({ cmd: 'setFormula', ref: C13, formula: '=C9*1595314.6' });
    host.readCell(C13);
    await host.whenReadsIdle();
    const reverted = host.getView().readCell(C13).value;
    expect(reverted.kind).toBe('number');
    if (reverted.kind === 'number') expect(reverted.value).toBeCloseTo(132942.88, 2);
    await host.execute({ cmd: 'setFormula', ref: C13, formula: '=C9*100' });
    host.readCell(C13);
    await host.whenReadsIdle();
    expect(host.getView().readCell(C13).value).toEqual({ kind: 'number', value: 8.33333333333333 });
    host.dispose();
  });

  it('a stale pre-mutation cell fill is still DROPPED, and a fresh fill is re-issued (W8 guard intact)', async () => {
    // Manually-clocked bridge: the first readCell hangs until the test
    // releases it with the PRE-mutation payload; later reads serve the
    // store. The edit emits cellsChanged only (real main behavior).
    let releaseStale: ((v: { value: TypedValue }) => void) | null = null;
    let readCalls = 0;
    const store = new Map<string, { value: TypedValue; formula?: string }>();
    store.set('0,0', { value: { kind: 'number', value: 5 } });
    let eventCb: ((e: EngineEvent) => void) | null = null;
    const bridge = makeBridge({
      execute: async (cmd) => {
        if (cmd.cmd === 'setFormula') {
          store.set(`${cmd.ref.row},${cmd.ref.col}`, { value: { kind: 'number', value: 2 }, formula: cmd.formula });
          eventCb?.({ type: 'cellsChanged', refs: [cmd.ref] });
        }
        return { ok: true };
      },
      readCell: async (ref) => {
        readCalls += 1;
        if (readCalls === 1) {
          return new Promise<{ value: TypedValue }>((resolve) => {
            releaseStale = resolve;
          });
        }
        return store.get(`${ref.row},${ref.col}`) ?? { value: { kind: 'null', value: null } };
      },
      onEngineEvent: (cb) => {
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
    });
    const host = new IpcEngineHost(() => bridge);
    host.readCell(A1); // queues the (soon-stale) fill, epoch 0
    await host.execute({ cmd: 'setFormula', ref: A1, formula: '=1+1' });
    // The pre-mutation fill lands LATE, carrying the old value 5.
    releaseStale!({ value: { kind: 'number', value: 5 } });
    await host.whenReadsIdle();
    await host.whenReadsIdle(); // the re-issued fill settles behind it
    // Guard intact: 5 was never served. Re-issue worked: the display is
    // the post-edit value, fetched by a second read.
    expect(readCalls).toBeGreaterThanOrEqual(2);
    expect(host.readCell(A1)).toEqual({ kind: 'number', value: 2 });
    expect(host.getView().readCell(A1).formula).toBe('=1+1');
    host.dispose();
  });

  it('a stale pre-mutation RANGE fill drops only the edited cell, which is then re-filled singly', async () => {
    let releaseRange: ((v: TypedValue[][]) => void) | null = null;
    let rangeCalls = 0;
    const cellReads: CellRef[] = [];
    const store = new Map<string, TypedValue>([
      ['0,0', { kind: 'number', value: 5 }],
      ['0,1', { kind: 'number', value: 6 }],
    ]);
    let eventCb: ((e: EngineEvent) => void) | null = null;
    const bridge = makeBridge({
      execute: async (cmd) => {
        if (cmd.cmd === 'setFormula') {
          store.set(`${cmd.ref.row},${cmd.ref.col}`, { kind: 'number', value: 2 });
          eventCb?.({ type: 'cellsChanged', refs: [cmd.ref] });
        }
        return { ok: true };
      },
      readRange: async () => {
        rangeCalls += 1;
        return new Promise<TypedValue[][]>((resolve) => {
          releaseRange = resolve;
        });
      },
      readCell: async (ref) => {
        cellReads.push(ref);
        return { value: store.get(`${ref.row},${ref.col}`) ?? { kind: 'null', value: null } };
      },
      onEngineEvent: (cb) => {
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
    });
    const host = new IpcEngineHost(() => bridge);
    const range = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 1 };
    host.readRange(range); // queues the range fill (epochs captured)
    await host.execute({ cmd: 'setFormula', ref: A1, formula: '=1+1' });
    // The range fill lands late with BOTH pre-edit values.
    releaseRange!([[{ kind: 'number', value: 5 }, { kind: 'number', value: 6 }]]);
    await host.whenReadsIdle();
    await host.whenReadsIdle();
    expect(rangeCalls).toBe(1);
    // The untouched neighbour took the range fill; the edited cell was
    // dropped from it (never served the stale 5) and re-filled singly.
    expect(cellReads).toContainEqual(A1);
    const values = host.readRange(range);
    expect(values[0]![0]).toEqual({ kind: 'number', value: 2 });
    expect(values[0]![1]).toEqual({ kind: 'number', value: 6 });
    host.dispose();
  });
});

describe('IpcEngineHost — failure behavior', () => {
  it('a hung read fill fails soft: sync placeholder, cell stays unloaded, no throw into render', async () => {
    const bridge = makeBridge({ readCell: () => new Promise(() => undefined) });
    const host = new IpcEngineHost(() => bridge, 25);
    // The sync read itself can never hang or throw — it placeholders.
    expect(host.readCell(A1)).toEqual({ kind: 'null', value: null });
    // The background fill times out (25ms) and is swallowed; the cell
    // remains UNLOADED so a later read re-queues instead of serving junk.
    await new Promise((r) => setTimeout(r, 75));
    expect(host.hasCell(A1)).toBe(false);
    host.dispose();
  });

  it('times out a hung snapshotAsync instead of hanging forever', async () => {
    const bridge = makeBridge({ snapshot: () => new Promise(() => undefined) });
    const host = new IpcEngineHost(() => bridge, 25);
    await expect(host.snapshotAsync()).rejects.toThrow('timed out');
    host.dispose();
  });

  it('loadIpc uses the long load bound, not the interactive timeout (P95-class loads exceed 30s)', async () => {
    // Interactive timeout is 25ms here; the load resolves at 75ms. With the
    // interactive bound this rejected (the packaged-app P95 defect: load
    // abandoned at 30s while the main process finished it); with the load
    // bound it must resolve.
    const bridge = makeBridge({
      load: async () => {
        await new Promise((r) => setTimeout(r, 75));
        return { sheets: [{ name: 'Big' }] } as unknown as EngineLoadResult;
      },
    });
    const host = new IpcEngineHost(() => bridge, 25);
    const res = await host.loadIpc(new Uint8Array([1]), 'big.xlsx');
    expect(res.sheets.map((s) => s.name)).toEqual(['Big']);
    host.dispose();
  });

  it('dispose detaches the bridge event feed', async () => {
    const bridge = makeBridge();
    const host = new IpcEngineHost(() => bridge);
    const seen: EngineEvent[] = [];
    host.subscribe((e) => seen.push(e));
    host.dispose();
    bridge.emit({ type: 'recalcComplete' });
    expect(seen).toEqual([]);
  });

  it('throws a clear error when the desktop bridge is missing', () => {
    const host = new IpcEngineHost(() => null);
    expect(() => host.execute({ cmd: 'recalculate' })).toThrow('not running on desktop');
    host.dispose();
  });

  it('reads fail soft (sync placeholder) when the desktop bridge is missing', () => {
    const host = new IpcEngineHost(() => null);
    expect(host.readCell(A1)).toEqual({ kind: 'null', value: null });
    expect(host.getView().readCell(A1).value).toEqual({ kind: 'null', value: null });
    expect(host.readRange({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toEqual([
      [{ kind: 'null', value: null }],
    ]);
    host.dispose();
  });
});

describe('IpcEngineHost — issue #43: formula resolution for the formula bar', () => {
  it('readCellAsync resolves the formula for a bulk-filled cell (values-only fill), once', async () => {
    // The desktop defect shape: the bulk readRange bridge returns VALUES
    // ONLY, so after the grid's bulk fill the sync view knows A3's value
    // but not its formula — the formula bar showed "35". A single-cell
    // bridge read knows the formula; readCellAsync must consult it even
    // on a value-cache hit, exactly once per invalidation epoch.
    let cellReads = 0;
    const A3: CellRef = { sheet: 'Sheet1', row: 2, col: 0 };
    const bridge = makeBridge({
      readCell: async () => {
        cellReads += 1;
        return { value: { kind: 'number', value: 35 } as TypedValue, formula: 'SUM(A1:A2)' };
      },
      readRange: async (range) => {
        const out: TypedValue[][] = [];
        for (let r = range.startRow; r <= range.endRow; r++) {
          const row: TypedValue[] = [];
          for (let c = range.startCol; c <= range.endCol; c++) row.push({ kind: 'number', value: 35 });
          out.push(row);
        }
        return out;
      },
    });
    const host = new IpcEngineHost(() => bridge);
    // Bulk fill (what the grid does on open): value lands, formula doesn't.
    await host.readRangeAsync({ sheet: 'Sheet1', startRow: 2, startCol: 0, endRow: 2, endCol: 0 });
    expect(cellReads).toBe(0); // bulk path never touches single-cell reads
    const syncCell = host.getView().readCell(A3);
    expect(syncCell.value).toEqual({ kind: 'number', value: 35 });
    expect(syncCell.formula).toBeUndefined(); // the defect, pinned
    // The async read resolves the formula despite the value-cache hit...
    await expect(host.readCellAsync(A3)).resolves.toEqual({
      value: { kind: 'number', value: 35 },
      formula: 'SUM(A1:A2)',
    });
    expect(cellReads).toBe(1);
    // ...and the sync view now carries it too (formula bar tick re-seed).
    expect(host.getView().readCell(A3).formula).toBe('SUM(A1:A2)');
    // Resolved: a second async read is cache-cheap, no new bridge call.
    await expect(host.readCellAsync(A3)).resolves.toEqual({
      value: { kind: 'number', value: 35 },
      formula: 'SUM(A1:A2)',
    });
    expect(cellReads).toBe(1);
    // An engine cellsChanged invalidates the resolution: next read refetches.
    bridge.emit({ type: 'cellsChanged', refs: [A3] });
    await expect(host.readCellAsync(A3)).resolves.toEqual({
      value: { kind: 'number', value: 35 },
      formula: 'SUM(A1:A2)',
    });
    expect(cellReads).toBe(2);
    host.dispose();
  });

  it('readCellAsync confirms a plain value cell has no formula (and caches that)', async () => {
    let cellReads = 0;
    const bridge = makeBridge({
      readCell: async () => {
        cellReads += 1;
        return { value: { kind: 'number', value: 10 } as TypedValue };
      },
    });
    const host = new IpcEngineHost(() => bridge);
    await expect(host.readCellAsync(A1)).resolves.toEqual({ value: { kind: 'number', value: 10 } });
    await expect(host.readCellAsync(A1)).resolves.toEqual({ value: { kind: 'number', value: 10 } });
    expect(cellReads).toBe(1); // absence resolved once, then cached
    host.dispose();
  });
});
