/**
 * Defect D2 regression tests (Cycle 10 closure): undo/redo for grid edits
 * on ASYNC hosts.
 *
 * The packaged desktop app showed "Nothing to undo." after a grid edit
 * and Ctrl+Z never reverted the cell. Root cause (proven by the repro
 * this file codifies): UndoManager's synchronous paths assume a
 * synchronous host, but IpcEngineHost (desktop) and RemoteEngineHost
 * (gateway) return a PROMISE from execute() and serve view reads from a
 * read-through cache whose miss value is the EMPTY placeholder:
 *   - applyState read `.ok` off the Promise → undo()/redo() always
 *     reported failure even though the restore execute was dispatched;
 *   - readBefore captured the placeholder for uncached cells — notably
 *     the redo-state capture inside undo(), which runs right after the
 *     edit's cellsChanged invalidation evicted the cell — so redo would
 *     have restored a phantom empty value;
 *   - a background cache fill issued before an edit could land after it
 *     and resurrect the pre-edit value in the renderer's cache.
 *
 * These tests drive the REAL IpcEngineHost over a stateful mock IPC
 * bridge (the mock is the "main-process engine": it stores inputs,
 * emits cellsChanged + recalcComplete like the real one) through the
 * exact App commit flow — captureAsync BEFORE execute, then undoAsync /
 * redoAsync — and assert the engine-side store AND the renderer's view
 * both end at the right values, with truthful return values. A second
 * suite runs the same flow against a minimal promise-based fake host
 * shaped like RemoteEngineHost (gateway), proving the manager-level fix
 * is host-generic (undo on the gateway host is a routed edit: the fake's
 * execute IS its server, and it must receive the restore as an ordinary
 * setCell/setFormula through the same path).
 */
import { describe, expect, it } from 'vitest';
import type {
  CellRef,
  EngineEvent,
  TypedValue,
} from '@icecream-sheets/engine';
import { IpcEngineHost, type IpcEngineBridge } from '../services/ipcEngine';
import { UndoManager } from './undo';

const C10: CellRef = { sheet: 'Sheet1', row: 9, col: 2 };
const A1: CellRef = { sheet: 'Sheet1', row: 0, col: 0 };

interface StoredCell {
  value: TypedValue;
  formula?: string;
}

function tvOf(v: number | string | boolean | null): TypedValue {
  if (typeof v === 'number') return { kind: 'number', value: v };
  if (typeof v === 'string') return { kind: 'string', value: v };
  if (typeof v === 'boolean') return { kind: 'boolean', value: v };
  return { kind: 'null', value: null };
}

/** Stateful mock of the desktop main-process engine behind the bridge. */
function makeStatefulBridge(seed: Array<[CellRef, StoredCell]>) {
  const store = new Map<string, StoredCell>();
  const key = (r: CellRef) => `${r.sheet}!${r.row},${r.col}`;
  for (const [ref, cell] of seed) store.set(key(ref), cell);
  let eventCb: ((e: EngineEvent) => void) | null = null;
  const bridge: IpcEngineBridge = {
    execute: async (cmd) => {
      if (cmd.cmd === 'setCell') {
        store.set(key(cmd.ref), { value: tvOf(cmd.value as never) });
        eventCb?.({ type: 'cellsChanged', refs: [cmd.ref] });
        eventCb?.({ type: 'recalcComplete' });
        return { ok: true };
      }
      if (cmd.cmd === 'setFormula') {
        // The real engine would calc the formula; the mock stores a
        // marker computed value alongside the formula text.
        store.set(key(cmd.ref), { value: { kind: 'number', value: 2 }, formula: cmd.formula });
        eventCb?.({ type: 'cellsChanged', refs: [cmd.ref] });
        eventCb?.({ type: 'recalcComplete' });
        return { ok: true };
      }
      return { ok: true };
    },
    readCell: async (ref) => store.get(key(ref)) ?? { value: tvOf(null) },
    readRange: async (range) => {
      const out: TypedValue[][] = [];
      for (let r = range.startRow; r <= range.endRow; r++) {
        const row: TypedValue[] = [];
        for (let c = range.startCol; c <= range.endCol; c++) {
          row.push(store.get(key({ sheet: range.sheet, row: r, col: c }))?.value ?? tvOf(null));
        }
        out.push(row);
      }
      return out;
    },
    usedRange: async () => ({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 20, endCol: 5 }),
    snapshot: async () => ({ protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] }),
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
  return { bridge, store, key };
}

/** Read a cell through the renderer's view, letting fills settle. */
async function viewValue(host: IpcEngineHost, ref: CellRef): Promise<TypedValue> {
  host.getView().readCell(ref);
  await host.whenReadsIdle();
  return host.getView().readCell(ref).value;
}

describe('D2: undo/redo for grid edits over IpcEngineHost (desktop)', () => {
  it('edit → undo returns true, engine + view revert; redo reapplies', async () => {
    const { bridge, store, key } = makeStatefulBridge([[C10, { value: tvOf(0.1667) }]]);
    const host = new IpcEngineHost(() => bridge);
    const undo = new UndoManager();
    // Prime the renderer cache as the grid render would.
    await viewValue(host, C10);

    // App commitCell flow (async host): capture BEFORE execute.
    await undo.captureAsync(host as never, 'Sheet1', [{ row: 9, col: 2 }], 'Edit C10');
    expect(undo.canUndo()).toBe(true);
    await host.execute({ cmd: 'setCell', ref: C10, value: 0.5 });
    expect(store.get(key(C10))?.value).toEqual(tvOf(0.5));

    // Ctrl+Z — the packaged app reported "Nothing to undo." here.
    await expect(undo.undoAsync(host as never)).resolves.toBe(true);
    expect(store.get(key(C10))?.value).toEqual(tvOf(0.1667));
    // The grid must show the reverted value, not the stale edited one.
    await expect(viewValue(host, C10)).resolves.toEqual(tvOf(0.1667));
    expect(undo.canRedo()).toBe(true);

    // Ctrl+Y reapplies the edit (redo state must be the real 0.5, not
    // the placeholder the sync capture used to record).
    await expect(undo.redoAsync(host as never)).resolves.toBe(true);
    expect(store.get(key(C10))?.value).toEqual(tvOf(0.5));
    await expect(viewValue(host, C10)).resolves.toEqual(tvOf(0.5));
    host.dispose();
  });

  it('captureAsync records the REAL before-value for a cell never primed into the cache', async () => {
    const { bridge, store, key } = makeStatefulBridge([[A1, { value: tvOf(111) }]]);
    const host = new IpcEngineHost(() => bridge);
    const undo = new UndoManager();
    // No priming read: the sync capture would record the EMPTY
    // placeholder here and undo would clear the cell instead of
    // restoring 111.
    await undo.captureAsync(host as never, 'Sheet1', [{ row: 0, col: 0 }], 'Edit A1');
    await host.execute({ cmd: 'setCell', ref: A1, value: 222 });
    expect(store.get(key(A1))?.value).toEqual(tvOf(222));
    await expect(undo.undoAsync(host as never)).resolves.toBe(true);
    expect(store.get(key(A1))?.value).toEqual(tvOf(111));
    host.dispose();
  });

  it('formula edit undoes back to the previous value, redoes to the formula', async () => {
    const { bridge, store, key } = makeStatefulBridge([[A1, { value: tvOf(7) }]]);
    const host = new IpcEngineHost(() => bridge);
    const undo = new UndoManager();
    await viewValue(host, A1);
    await undo.captureAsync(host as never, 'Sheet1', [{ row: 0, col: 0 }], 'Edit A1');
    await host.execute({ cmd: 'setFormula', ref: A1, formula: '=1+1' });
    expect(store.get(key(A1))?.formula).toBe('=1+1');
    await expect(undo.undoAsync(host as never)).resolves.toBe(true);
    expect(store.get(key(A1))).toEqual({ value: tvOf(7) });
    await expect(undo.redoAsync(host as never)).resolves.toBe(true);
    expect(store.get(key(A1))?.formula).toBe('=1+1');
    host.dispose();
  });

  it('undoAsync on an empty stack returns false (the only "Nothing to undo." case)', async () => {
    const { bridge } = makeStatefulBridge([]);
    const host = new IpcEngineHost(() => bridge);
    const undo = new UndoManager();
    await expect(undo.undoAsync(host as never)).resolves.toBe(false);
    await expect(undo.redoAsync(host as never)).resolves.toBe(false);
    host.dispose();
  });
});

describe('D2: undo/redo against a promise-based host (gateway shape)', () => {
  // Minimal host with RemoteEngineHost's runtime shape: execute()
  // returns a Promise, view reads serve a cache that invalidates on
  // write, readCellAsync fetches the authoritative ("server") value.
  function makeGatewayLikeHost() {
    const server = new Map<string, StoredCell>();
    const cache = new Map<string, StoredCell>();
    const key = (r: CellRef) => `${r.sheet}!${r.row},${r.col}`;
    server.set(key(A1), { value: tvOf(10) });
    const host = {
      getView: () => ({
        readCell: (ref: CellRef) => cache.get(key(ref)) ?? { ref, value: tvOf(null) },
      }),
      readCellAsync: async (ref: CellRef) => {
        const cell = server.get(key(ref)) ?? { value: tvOf(null) };
        cache.set(key(ref), cell);
        return cell;
      },
      execute: async (cmd: { cmd: string; ref: CellRef; value?: unknown; formula?: string }) => {
        if (cmd.cmd === 'setCell') server.set(key(cmd.ref), { value: tvOf(cmd.value as never) });
        if (cmd.cmd === 'setFormula') {
          server.set(key(cmd.ref), { value: { kind: 'number', value: 3 }, formula: cmd.formula });
        }
        cache.delete(key(cmd.ref)); // routed ack invalidates the mirror entry
        return { ok: true };
      },
    };
    return { host, server, key };
  }

  it('undo is itself a routed edit: server ends reverted, redo reapplies', async () => {
    const { host, server, key } = makeGatewayLikeHost();
    const undo = new UndoManager();
    await undo.captureAsync(host as never, 'Sheet1', [{ row: 0, col: 0 }], 'Edit A1');
    await host.execute({ cmd: 'setCell', ref: A1, value: 99 });
    expect(server.get(key(A1))?.value).toEqual(tvOf(99));
    // The sync manager reported false here (Promise `.ok`); async is true.
    await expect(undo.undoAsync(host as never)).resolves.toBe(true);
    expect(server.get(key(A1))?.value).toEqual(tvOf(10));
    await expect(undo.redoAsync(host as never)).resolves.toBe(true);
    expect(server.get(key(A1))?.value).toEqual(tvOf(99));
  });
});
