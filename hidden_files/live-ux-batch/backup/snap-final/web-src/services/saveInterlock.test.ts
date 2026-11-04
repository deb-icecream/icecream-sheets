/**
 * Save / autosave interlock tests (Cycle 10 closure).
 *
 * THE REGRESSION: App's autosave (and manual save) were gated on
 * workbookLoaded / readOnly / saveState only. During a SERVER-routed
 * edit awaiting its ack, a save could fire and serialize provisional /
 * pre-edit state — and clear the dirty flag on top of it. Local-route
 * calc is synchronous (safe by construction); the async server route
 * (and the desktop IPC route) were the exposed windows.
 *
 * These tests drive the EXACT primitives App.tsx uses:
 *  - hosts expose `hasInFlightEdits()` / `whenEditsSettle()`
 *    (RemoteEngineHost: routed-edit tracker + OptimisticEditSession;
 *    IpcEngineHost: execute tracker),
 *  - save paths defer through `serializeWhenSettled(host, serialize)`
 *    (App routes this via awaitEditsSettled() inside
 *    ensureSaveSnapshot / the gateway save fns / both autosave timers /
 *    the manual-save handlers).
 *
 * Proof shape: a save scheduled WHILE an edit is in flight does NOT
 * serialize (spy silent across ticks), then DOES serialize immediately
 * after the edit settles, capturing the POST-edit state.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EngineHost,
  EngineWorkbook,
  type CellRef,
  type CommandResult,
  type EngineCommand,
  type TypedValue,
} from '@icecream-sheets/engine';
import { GatewayClient } from './gatewayClient';
import { RemoteEngineHost } from './remoteEngine';
import { IpcEngineHost, type IpcEngineBridge } from './ipcEngine';
import { OptimisticEditSession } from './routedEdit';
import {
  EditInFlightTracker,
  editFlightSourceOf,
  hasInFlightEdits,
  serializeWhenSettled,
  waitForEditsToSettle,
} from './saveInterlock';

const A1: CellRef = { sheet: 'Sales', row: 0, col: 0 };
const B1: CellRef = { sheet: 'Sales', row: 0, col: 1 };

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// EditInFlightTracker + OptimisticEditSession signals
// ---------------------------------------------------------------------------

describe('save interlock — tracker + session signals', () => {
  it('tracker: counts edits, settle waiters fire only when the LAST edit ends', async () => {
    const t = new EditInFlightTracker();
    expect(t.hasInFlightEdits()).toBe(false);
    await expect(t.whenEditsSettle()).resolves.toBeUndefined(); // idle: immediate

    const end1 = t.beginEdit();
    const end2 = t.beginEdit();
    expect(t.pendingCount).toBe(2);
    let settled = false;
    void t.whenEditsSettle().then(() => {
      settled = true;
    });
    end1();
    end1(); // idempotent: no underflow
    await tick();
    expect(t.pendingCount).toBe(1);
    expect(settled).toBe(false);
    end2();
    await tick();
    expect(t.pendingCount).toBe(0);
    expect(settled).toBe(true);
  });

  it('tracker: track() holds the count across resolve AND reject', async () => {
    const t = new EditInFlightTracker();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tracked = t.track(async () => {
      await gate;
      return 7;
    });
    expect(t.hasInFlightEdits()).toBe(true);
    release();
    await expect(tracked).resolves.toBe(7);
    expect(t.hasInFlightEdits()).toBe(false);
    await expect(
      t.track(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(t.hasInFlightEdits()).toBe(false);
  });

  it('session: pendingCount / subscribePending / whenSettled follow begin→confirm', async () => {
    const session = new OptimisticEditSession();
    const seen: number[] = [];
    const off = session.subscribePending(() => seen.push(session.pendingCount));
    const op = session.begin({
      ref: A1,
      displayValue: { kind: 'number', value: 5 } as TypedValue,
      dependents: [B1],
      previousValue: { kind: 'number', value: 1 } as TypedValue,
      state: 'awaiting-server',
    });
    expect(session.pendingCount).toBe(1);
    let settled = false;
    void session.whenSettled().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    session.confirm(op.opId);
    await tick();
    expect(session.pendingCount).toBe(0);
    expect(settled).toBe(true);
    expect(seen).toEqual([1, 0]);
    off();
  });

  it('hosts without an async edit path are no-ops (local host is synchronous)', async () => {
    const local = new EngineHost(new EngineWorkbook({ Sheet1: [[1]] }));
    expect(editFlightSourceOf(local)).toBeNull();
    expect(hasInFlightEdits(local)).toBe(false);
    await expect(waitForEditsToSettle(local)).resolves.toBeUndefined();
    const serialize = vi.fn(() => 'bytes');
    await expect(serializeWhenSettled(local, serialize)).resolves.toBe('bytes');
    expect(serialize).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Gateway host: the autosave regression (server-routed edit in flight)
// ---------------------------------------------------------------------------

const LOAD = {
  ok: true,
  sheets: ['Sales'],
  file: { sheets: [{ name: 'Sales', formats: { codes: [], columns: {} } }], metadata: {} },
  columnCounts: { Sales: [2] },
};

/** A fake engine-service transport backed by a REAL engine (the server). */
function gatedServerTransport(server: EngineHost, gate: Promise<void>, fail = false) {
  return {
    loadXlsx: vi.fn(async () => LOAD),
    reset: vi.fn(async () => undefined),
    sheetNames: vi.fn(async () => ['Sales']),
    execute: vi.fn(async (cmd: EngineCommand): Promise<CommandResult> => {
      await gate; // the edit is IN FLIGHT until the test releases this
      if (fail) return { ok: false, error: 'Denied by policy' };
      return server.execute(cmd);
    }),
    readCell: vi.fn(async (ref: CellRef) => {
      const cell = server.getView().readCell(ref);
      return { value: cell.value, ...(cell.formula ? { formula: cell.formula } : {}) };
    }),
    readRange: vi.fn(
      async (range: { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number }) => {
        const values: TypedValue[][] = [];
        const formulas: Array<string | null>[] = [];
        for (let r = range.startRow; r <= range.endRow; r++) {
          const vRow: TypedValue[] = [];
          const fRow: Array<string | null> = [];
          for (let c = range.startCol; c <= range.endCol; c++) {
            const cell = server.getView().readCell({ sheet: range.sheet, row: r, col: c });
            vRow.push(cell.value);
            fRow.push(cell.formula ?? null);
          }
          values.push(vRow);
          formulas.push(fRow);
        }
        return { values, formulas };
      },
    ),
    readSheet: vi.fn(async () => []),
    usedRange: vi.fn(async (sheet: string) => server.getView().usedRange(sheet)),
    snapshot: vi.fn(async () => server.snapshot()),
    events: vi.fn(async () => []),
  };
}

async function makeGatewayHost(fail = false) {
  const server = new EngineHost(new EngineWorkbook({ Sales: [[1, '=A1+1']] }));
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const transport = gatedServerTransport(server, gate, fail);
  const host = new RemoteEngineHost(new GatewayClient('http://gateway.test'), 60000, transport as never);
  await host.loadXlsxAsync('QQ==');
  return { server, host, release };
}

/** What App's save does once deferred: pull the snapshot, read values. */
function serializeFromHost(host: RemoteEngineHost) {
  return async (): Promise<{ a1Input: unknown; b1Value: TypedValue }> => {
    const snap = await host.snapshotAsync();
    const sheet = snap.sheets.find((s) => s.name === 'Sales')!;
    const a1 = sheet.cells.find((c) => c.ref.row === 0 && c.ref.col === 0);
    // B1 is a dependent the server route never computed locally, so it
    // is not in the sync cache — queue its read, wait for the batched
    // fill to land, then read the value the server holds NOW (post-ack).
    host.readCell(B1);
    await host.whenReadsIdle();
    return { a1Input: a1?.input, b1Value: host.readCell(B1) };
  };
}

describe('save interlock — gateway host (RemoteEngineHost)', () => {
  it('AUTOSAVE REGRESSION: a save scheduled during an in-flight server-routed edit does NOT serialize until the edit settles — then serializes the POST-edit state', async () => {
    const { host, release } = await makeGatewayHost();
    // No mirror installed → every edit routes to the server (flag ON
    // shape): the async window this interlock exists for.
    const edit = host.executeRoutedAsync({ cmd: 'setCell', ref: A1, value: 5 });
    expect(host.hasInFlightEdits()).toBe(true);
    expect(host.getOptimisticSession().hasPending()).toBe(true);
    expect(host.getOptimisticSession().optimisticValue(A1)).toEqual({ kind: 'number', value: 5 });

    // The autosave timer fires NOW, mid-flight: schedule the save the
    // way App does (defer through the interlock, then serialize).
    const serialize = vi.fn(serializeFromHost(host));
    const save = serializeWhenSettled(host, serialize);
    await tick(30);
    // Not serialized: no snapshot pull, no bytes — and nothing was
    // marked clean (the save promise is still pending, dirty intact).
    expect(serialize).not.toHaveBeenCalled();

    // The ack lands: the edit settles…
    release();
    const outcome = await edit;
    expect(outcome.result.ok).toBe(true);
    expect(host.hasInFlightEdits()).toBe(false);

    // …and the deferred save fires immediately after settle, with the
    // post-edit state (A1 = 5, dependent B1 recalculated to 6).
    const savedState = await save;
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(savedState.a1Input).toBe(5);
    expect(savedState.b1Value).toEqual({ kind: 'number', value: 6 });
    host.dispose();
  });

  it('MANUAL SAVE: a save requested mid-flight defers the same way (not dropped, not early)', async () => {
    const { host, release } = await makeGatewayHost();
    const edit = host.executeRoutedAsync({ cmd: 'setCell', ref: A1, value: 9 });
    expect(host.hasInFlightEdits()).toBe(true);
    // The user hits Save during the flight: same deferral primitive.
    const serialize = vi.fn(serializeFromHost(host));
    const manualSave = serializeWhenSettled(host, serialize);
    await tick(30);
    expect(serialize).not.toHaveBeenCalled();
    release();
    await edit;
    const savedState = await manualSave;
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(savedState.a1Input).toBe(9);
    expect(savedState.b1Value).toEqual({ kind: 'number', value: 10 });
    host.dispose();
  });

  it('a REJECTED edit still releases the deferred save — serializing the confirmed (rolled-back) state', async () => {
    const { host, release } = await makeGatewayHost(/* fail */ true);
    const edit = host.executeRoutedAsync({ cmd: 'setCell', ref: A1, value: 5 });
    const serialize = vi.fn(serializeFromHost(host));
    const save = serializeWhenSettled(host, serialize);
    await tick(30);
    expect(serialize).not.toHaveBeenCalled();
    release();
    const outcome = await edit;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    // The save was deferred, not dropped: it runs after the rollback
    // and captures the last CONFIRMED state (A1 = 1, B1 = 2).
    const savedState = await save;
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(savedState.a1Input).toBe(1);
    expect(savedState.b1Value).toEqual({ kind: 'number', value: 2 });
    host.dispose();
  });

  it('whenEditsSettle also covers structural commands (never in the session)', async () => {
    const { host, release } = await makeGatewayHost();
    const structural = host.executeRoutedAsync({ cmd: 'addSheet', name: 'Extra' });
    // The session holds no op for a structural command, yet the host
    // tracker still reports the edit in flight.
    expect(host.getOptimisticSession().hasPending()).toBe(false);
    expect(host.hasInFlightEdits()).toBe(true);
    let settled = false;
    void host.whenEditsSettle().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    release();
    await structural;
    await tick();
    expect(settled).toBe(true);
    expect(host.hasInFlightEdits()).toBe(false);
    host.dispose();
  });

  it('no edit in flight → saves proceed immediately (normal path unimpeded)', async () => {
    const { host } = await makeGatewayHost();
    expect(host.hasInFlightEdits()).toBe(false);
    const serialize = vi.fn(serializeFromHost(host));
    const savedState = await serializeWhenSettled(host, serialize);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(savedState.a1Input).toBe(1);
    host.dispose();
  });
});

// ---------------------------------------------------------------------------
// Desktop host: the same interlock over the IPC execute round-trip
// ---------------------------------------------------------------------------

describe('save interlock — desktop host (IpcEngineHost)', () => {
  it('AUTOSAVE (desktop): serialization defers while an IPC edit is in flight, then runs with the post-edit state', async () => {
    // The "main process" workbook state: only the gated execute mutates it.
    let mainA1 = 1;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const bridge: IpcEngineBridge = {
      execute: async (cmd: EngineCommand) => {
        await gate; // IPC round-trip in flight until released
        if (cmd.cmd === 'setCell' && typeof cmd.value === 'number') mainA1 = cmd.value;
        return { ok: true };
      },
      readCell: async () => ({ value: { kind: 'number', value: mainA1 } }),
      readRange: async () => [],
      usedRange: async () => null,
      snapshot: async () => ({ protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] }),
      protocolVersion: async () => 1,
      load: async () => ({ sheets: [], metadata: {} }),
      newWorkbook: async () => undefined,
      setProtection: async () => undefined,
      onEngineEvent: () => () => undefined,
    };
    const host = new IpcEngineHost(() => bridge);
    const A1_DESKTOP: CellRef = { sheet: 'Sheet1', row: 0, col: 0 };
    const edit = host.execute({ cmd: 'setCell', ref: A1_DESKTOP, value: 42 }) as unknown as Promise<CommandResult>;
    expect(host.hasInFlightEdits()).toBe(true);
    expect(host.editInFlightCount).toBe(1);
    // The optimistic display is already up — exactly the state a naive
    // autosave would have serialized mid-flight.
    expect(host.optimisticEntry(A1_DESKTOP)?.value).toEqual({ kind: 'number', value: 42 });

    const serialize = vi.fn(() => mainA1);
    const save = serializeWhenSettled(host, serialize);
    await tick(30);
    expect(serialize).not.toHaveBeenCalled();

    release();
    await edit;
    expect(host.hasInFlightEdits()).toBe(false);
    // Deferred save fires right after settle, with the post-edit state.
    await expect(save).resolves.toBe(42);
    expect(serialize).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});
