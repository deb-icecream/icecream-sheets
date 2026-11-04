/**
 * Routing-integration tests (Cycle 10 Phase 3): routeEditRecalc wired
 * into a real edit pipeline — routing table end-to-end against a real
 * mirror + a fake authoritative server, the optimistic-display lifecycle
 * (protocol §7), and the fail-safe-to-server cases.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EngineHost,
  EngineWorkbook,
  computeAckChecksum,
  normalizeHybridRecalcConfig,
  type CellInput,
  type CellRef,
  type CommandResult,
  type EditAck,
  type EngineCommand,
  type TypedValue,
} from '@icecream-sheets/engine';
import {
  executeRoutedEdit,
  OptimisticEditSession,
  refKey,
  resolveHybridThresholds,
  type RoutedEditDeps,
} from './routedEdit';

const A1: CellRef = { sheet: 'Sheet1', row: 0, col: 0 };

function mirror(rows: CellInput[][]): EngineHost {
  return new EngineHost(new EngineWorkbook({ Sheet1: rows }));
}

function serverHost(rows: CellInput[][]): { host: EngineHost; execute: (c: EngineCommand) => Promise<CommandResult> } {
  const host = new EngineHost(new EngineWorkbook({ Sheet1: rows }));
  return { host, execute: async (c) => host.execute(c) };
}

/** Authoritative ack values: read straight from the fake server engine. */
function ackReader(server: EngineHost) {
  return async (refs: CellRef[]): Promise<Map<string, TypedValue>> => {
    const out = new Map<string, TypedValue>();
    for (const ref of refs) out.set(refKey(ref), server.getView().readCell(ref).value);
    return out;
  };
}

function baseDeps(m: EngineHost, server: ReturnType<typeof serverHost>, total: number | null): RoutedEditDeps {
  return {
    mirror: m,
    totalCellCount: total,
    thresholds: normalizeHybridRecalcConfig({}),
    serverExecute: server.execute,
    fetchAckValues: ackReader(server.host),
    readConfirmedValue: (ref) => m.getView().readCell(ref).value,
    online: true,
    mirrorInSync: true,
    session: new OptimisticEditSession(),
  };
}

describe('routed edits — happy paths', () => {
  it('tiny set routes local: mirror recalcs provisionally, server confirms', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const deps = baseDeps(m, server, 2);
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.decision?.route).toBe('local');
    expect(out.decision?.reason).toBe('tiny-set-local');
    expect(out.result.ok).toBe(true);
    expect(out.divergedCells).toEqual([]);
    // The mirror recalced locally AND the server saw the write-through op.
    expect(m.getView().readCell({ sheet: 'Sheet1', row: 0, col: 1 }).value).toEqual({ kind: 'number', value: 6 });
    expect(server.host.getView().readCell({ sheet: 'Sheet1', row: 0, col: 1 }).value).toEqual({ kind: 'number', value: 6 });
    expect(deps.session!.baseRev).toBe(1);
  });

  it('no-mirror never consults the mirror: every edit goes to the server', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const spy = vi.spyOn(m, 'execute');
    const deps = baseDeps(m, server, 6000);
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.decision?.route).toBe('server');
    expect(out.decision?.reason).toBe('no-mirror');
    expect(spy).not.toHaveBeenCalled();
    expect(server.host.getView().readCell(A1).value).toEqual({ kind: 'number', value: 5 });
  });

  it('a mirror built for a big workbook still fails safe (derived from the CURRENT count)', async () => {
    // Mirror exists as an object, but totalCellCount (the server
    // workbook's) says flag ON → the policy must not touch it.
    const m = mirror([[1]]);
    const server = serverHost([[1]]);
    const spy = vi.spyOn(m, 'measureCalcChain');
    const out = await executeRoutedEdit(baseDeps(m, server, 9000), { cmd: 'setCell', ref: A1, value: 2 });
    expect(out.decision?.reason).toBe('no-mirror');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('routed edits — fail-safes', () => {
  it('missing mirror → no-local-engine; unknown count → no-mirror', async () => {
    const server = serverHost([[1]]);
    const deps = baseDeps(mirror([[1]]), server, 10);
    deps.mirror = null;
    let out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 3 });
    expect(out.decision?.reason).toBe('no-local-engine');
    deps.mirror = mirror([[1]]);
    deps.totalCellCount = null;
    out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 4 });
    expect(out.decision?.reason).toBe('no-mirror');
  });

  it('structural edits route to the server (no optimistic display)', async () => {
    const m = mirror([[1]]);
    const server = serverHost([[1]]);
    const out = await executeRoutedEdit(baseDeps(m, server, 2), { cmd: 'addSheet', name: 'S2' });
    expect(out.decision?.reason).toBe('structural-edit');
    expect(out.decision?.optimisticDisplay).toBe(false);
    expect(out.result.ok).toBe(true);
    expect(server.host.sheetNames()).toContain('S2');
  });

  it('an in-flight edit forces the next edit to the server', async () => {
    const m = mirror([[1]]);
    const server = serverHost([[1]]);
    const session = new OptimisticEditSession();
    session.begin({
      ref: A1,
      displayValue: { kind: 'number', value: 2 } as TypedValue,
      dependents: [],
      previousValue: { kind: 'number', value: 1 } as TypedValue,
      state: 'awaiting-server',
    });
    const deps = baseDeps(m, server, 2);
    deps.session = session;
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 3 });
    expect(out.decision?.route).toBe('server');
    expect(out.decision?.reason).toBe('edit-in-flight');
  });

  it('unreproducible dependents beat the tiny hatch (volatile formula)', async () => {
    const m = mirror([[1, '=A1+NOW()']]);
    const server = serverHost([[1, '=A1+NOW()']]);
    const out = await executeRoutedEdit(baseDeps(m, server, 2), { cmd: 'setCell', ref: A1, value: 7 });
    expect(out.decision?.route).toBe('server');
    expect(out.decision?.reason).toBe('unreproducible-dependents');
    expect(out.result.ok).toBe(true);
  });

  it('mirror out of sync → server', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const deps = baseDeps(m, server, 2);
    deps.mirrorInSync = false;
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 8 });
    expect(out.decision?.reason).toBe('mirror-out-of-sync');
  });
});

describe('optimistic display lifecycle (protocol §7)', () => {
  const longChain: CellInput[][] = [[1, '=A1+1', '=B1+1', '=C1+1']];
  const thresholds = normalizeHybridRecalcConfig({ tinySetThreshold: 1, chainLengthThreshold: 2 });

  it('server route: typed input shows immediately, ack confirms, server wins on disagreement', async () => {
    const m = mirror(longChain);
    const server = serverHost(longChain);
    const session = new OptimisticEditSession();
    let release!: (cmd: EngineCommand) => void;
    const gate = new Promise<CommandResult>((resolve) => {
      release = (cmd) => resolve(server.host.execute(cmd));
    });
    const deps = baseDeps(m, server, 4);
    deps.thresholds = thresholds;
    deps.session = session;
    deps.serverExecute = (cmd) => gate.then(() => (cmd.cmd === 'setCell' ? { ok: true } : { ok: true }));
    // Divergence on the edited cell: the "server" values 999, not the typed 5.
    deps.fetchAckValues = async () => new Map([[refKey(A1), { kind: 'number', value: 999 } as TypedValue]]);
    const pending = executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // While the op is in flight the typed value is displayed provisionally.
    expect(session.optimisticValue(A1)).toEqual({ kind: 'number', value: 5 });
    expect(session.isStale({ sheet: 'Sheet1', row: 0, col: 1 })).toBe(true);
    release({ cmd: 'setCell', ref: A1, value: 5 });
    const out = await pending;
    expect(out.decision?.reason).toBe('chain-long');
    expect(out.result.ok).toBe(true);
    expect(out.divergedCells?.length).toBe(1);
    expect(out.ackValues?.get(refKey(A1))).toEqual({ kind: 'number', value: 999 });
    expect(session.optimisticValue(A1)).toBeUndefined();
    expect(session.baseRev).toBe(1);
  });

  it('local route: dependents expose provisional values during flight (issue #66)', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const session = new OptimisticEditSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = baseDeps(m, server, 2);
    deps.session = session;
    deps.serverExecute = async (cmd) => {
      await gate;
      return server.host.execute(cmd);
    };
    const B1 = { sheet: 'Sheet1', row: 0, col: 1 };
    const pending = executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    await new Promise((r) => setTimeout(r, 0));
    // While the write-through is still in flight, the edited cell AND
    // its dependent read back the locally computed provisional values —
    // this is the read surface the grid paints from.
    expect(session.optimisticValue(A1)).toEqual({ kind: 'number', value: 5 });
    expect(session.optimisticValue(B1)).toEqual({ kind: 'number', value: 6 });
    release();
    const out = await pending;
    expect(out.decision?.reason).toBe('tiny-set-local');
    expect(out.divergedCells).toEqual([]);
    // Settled: no provisional state lingers.
    expect(session.optimisticValue(B1)).toBeUndefined();
  });

  it('rejection rolls back visibly (rollbackValue = last confirmed)', async () => {
    const m = mirror(longChain);
    const server = serverHost(longChain);
    const session = new OptimisticEditSession();
    const deps = baseDeps(m, server, 4);
    deps.thresholds = thresholds;
    deps.session = session;
    deps.serverExecute = async () => ({ ok: false, error: 'Denied by policy' });
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.result.ok).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(out.rollbackValue).toEqual({ kind: 'number', value: 1 });
    expect(session.hasPending()).toBe(false);
  });

  it('a failed write-through on a local route rolls the mirror back too', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const session = new OptimisticEditSession();
    const deps = baseDeps(m, server, 2);
    deps.session = session;
    deps.serverExecute = async () => ({ ok: false, error: 'gateway 503' });
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.result.ok).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(m.getView().readCell(A1).value).toEqual({ kind: 'number', value: 1 });
    expect(m.getView().readCell({ sheet: 'Sheet1', row: 0, col: 1 }).value).toEqual({
      kind: 'number',
      value: 2,
    });
  });

  it('offline long chain defers: queued, no transport call', async () => {
    const m = mirror(longChain);
    const server = serverHost(longChain);
    const exec = vi.fn(async (_c: EngineCommand): Promise<CommandResult> => ({ ok: true }));
    const deps = baseDeps(m, server, 4);
    deps.thresholds = thresholds;
    deps.online = false;
    deps.serverExecute = exec;
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.decision?.reason).toBe('offline-deferred-long');
    expect(out.queued).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('routed edits — measurement cache (closure (a))', () => {
  it('repeat value edits to the same ref hit the measurement cache; a formula change invalidates', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const deps = baseDeps(m, server, 2);
    // First value edit: measurement runs (miss) and is cached.
    await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    const after1 = m.calcChainCacheStats();
    expect(after1.misses).toBeGreaterThan(0);
    // Second value edit to the SAME ref: cache hit — no re-measurement.
    await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 6 });
    const after2 = m.calcChainCacheStats();
    expect(after2.hits).toBeGreaterThan(after1.hits);
    expect(after2.misses).toBe(after1.misses);
    // A formula change anywhere bumps the graph version → next edit misses.
    m.execute({ cmd: 'setFormula', ref: { sheet: 'Sheet1', row: 0, col: 1 }, formula: '=A1+10' });
    await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 7 });
    const after3 = m.calcChainCacheStats();
    expect(after3.misses).toBeGreaterThan(after2.misses);
  });
});

describe('routed edits — checksum ack (closure (b))', () => {
  const B1: CellRef = { sheet: 'Sheet1', row: 0, col: 1 };

  /** A serverExecute that behaves like the real engine service: applies
   *  the op and attaches a checksum ack over the pre-edit affected set. */
  function ackingServer(server: EngineHost, corrupt = false) {
    let rev = 0;
    return async (c: EngineCommand): Promise<CommandResult> => {
      if (c.cmd !== 'setCell' && c.cmd !== 'setFormula') return server.execute(c);
      const affected = [c.ref, ...server.measureCalcChain(c.ref).cells];
      const result = server.execute(c);
      if (!result.ok) return result;
      const values = new Map<string, TypedValue>();
      for (const ref of affected) values.set(refKey(ref), server.getView().readCell(ref).value);
      const ack: EditAck = {
        revision: ++rev,
        changedCellCount: affected.length,
        checksum: corrupt ? '0000000000000000' : computeAckChecksum(affected, values),
      };
      return { ...result, ack } as CommandResult;
    };
  }

  it('checksum match → confirmed with NO ack value fetch', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const deps = baseDeps(m, server, 2);
    deps.serverExecute = ackingServer(server.host);
    const fetchSpy = vi.fn(ackReader(server.host));
    deps.fetchAckValues = fetchSpy;
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.decision?.route).toBe('local');
    expect(out.ackChecksumVerified).toBe(true);
    expect(out.ack?.changedCellCount).toBe(2); // A1 + B1
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.divergedCells).toEqual([]);
    expect(deps.session!.baseRev).toBe(1);
  });

  it('checksum mismatch → full value fetch and server-wins resolution', async () => {
    // Genuine divergence: the server's B1 formula differs from the mirror's.
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+100']]);
    const deps = baseDeps(m, server, 2);
    deps.serverExecute = ackingServer(server.host);
    const fetchSpy = vi.fn(ackReader(server.host));
    deps.fetchAckValues = fetchSpy;
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.ackChecksumVerified).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Server wins: B1's ack value (105) is what the caller seeds.
    expect(out.divergedCells).toEqual([B1]);
    expect(out.ackValues?.get(refKey(B1))).toEqual({ kind: 'number', value: 105 });
    expect(deps.session!.divergences).toHaveLength(1);
  });

  it('corrupt checksum from the server → falls back to the value fetch, values confirm', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const deps = baseDeps(m, server, 2);
    deps.serverExecute = ackingServer(server.host, /* corrupt */ true);
    const fetchSpy = vi.fn(ackReader(server.host));
    deps.fetchAckValues = fetchSpy;
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.ackChecksumVerified).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.divergedCells).toEqual([]); // values actually agree
  });

  it('no ack offered (older server) → value fetch path, unchanged', async () => {
    const m = mirror([[1, '=A1+1']]);
    const server = serverHost([[1, '=A1+1']]);
    const deps = baseDeps(m, server, 2);
    const fetchSpy = vi.fn(ackReader(server.host));
    deps.fetchAckValues = fetchSpy;
    const out = await executeRoutedEdit(deps, { cmd: 'setCell', ref: A1, value: 5 });
    expect(out.ack).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.divergedCells).toEqual([]);
  });
});

describe('resolveHybridThresholds', () => {
  it('defaults to 5000; settings field wins; canonical env wins over settings', () => {
    expect(resolveHybridThresholds({}).mtCellCountThreshold).toBe(5000);
    expect(resolveHybridThresholds({ settingsMtThreshold: 8000 }).mtCellCountThreshold).toBe(8000);
    expect(
      resolveHybridThresholds({ settingsMtThreshold: 8000, env: { ICECREAM_MT_CELL_COUNT_THRESHOLD: '2500' } }).mtCellCountThreshold,
    ).toBe(2500);
  });
});
