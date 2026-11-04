/**
 * TriggerSupervisor tests (triggers program, post-pivot design):
 * authorization + CRUD over an injected record source and memory
 * provider; the attach lifecycle driven by engine session handles
 * (onOpen once per session incl. across a supervisor restart, session
 * change, close); live firing against a REAL EngineHost including the
 * loop-safety and multi-write/read semantics the pivot restored; and
 * the prod fail-closed posture.
 *
 * The fake submitOp mimics engineSvc's composition (apply the command
 * to the session host, stamped); the REAL composition (sequencer +
 * journal + revision) is proven end-to-end in automationSvc.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost, type EngineCommand } from '@icecream-sheets/engine';
import type { Persistence } from '@icecream-sheets/service';
import type { FileRegistryRecord } from '../src/deploy/fileRegistry.js';
import {
  TriggerSupervisor,
  type TriggerPersistenceProvider,
} from '../src/services/triggerSupervisor.js';
import type { EngineSessionHandle } from '../src/services/engineSvc.js';

const NOW = 1_800_000_000_000;
const FILE = 'file-sup-1';

function rec(over: Partial<FileRegistryRecord> = {}): FileRegistryRecord {
  return {
    fileId: FILE,
    sessionId: 'sess-1',
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://127.0.0.1:9',
    leaseExpiry: NOW + 600_000,
    ownershipEpoch: 1,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: NOW,
    creatorPrincipal: 'user:alice',
    participants: { 'user:bob': 'editor', 'user:eve': 'viewer' },
    ...over,
  } as FileRegistryRecord;
}

/** Shared-backing memory provider: two supervisors over it simulate a restart. */
function memoryProvider() {
  const backing = new Map<string, string>();
  let flushCount = 0;
  const provider: TriggerPersistenceProvider = {
    forScope: async () => {
      const persistence: Persistence = {
        load: (k) => backing.get(k) ?? null,
        save: (k, v) => void backing.set(k, v),
        clear: (k) => void backing.delete(k),
      };
      return {
        persistence,
        flush: async () => {
          flushCount += 1;
        },
      };
    },
  };
  return { provider, backing, flushes: () => flushCount };
}

const WRITE_PERMS = [
  { action: 'cell.write', target: 'Sheet1!1,0' },
  { action: 'cell.read', target: 'Sheet1!0,0' },
];

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A session handle whose submitOp applies to a real EngineHost. */
function makeHandle(sessionId: string, fileId: string | null = FILE) {
  const host = new EngineHost();
  let revision = 0;
  const submitted: EngineCommand[] = [];
  const handle: EngineSessionHandle = {
    sessionId,
    fileId,
    host,
    submitOp: async (cmd: EngineCommand, principal: string) => {
      submitted.push(cmd);
      const res = host.execute({ ...cmd, auth: { principal } } as EngineCommand);
      return { ok: res.ok, ...(res.ok ? {} : { error: res.error }), revision: ++revision };
    },
  };
  return { handle, host, submitted };
}

function makeSupervisor(over: Partial<ConstructorParameters<typeof TriggerSupervisor>[0]> = {}) {
  const mem = memoryProvider();
  const sup = new TriggerSupervisor({
    records: [rec()],
    persistenceProvider: mem.provider,
    nowMs: () => NOW,
    log: () => undefined,
    ...over,
  });
  return { sup, mem };
}

describe('TriggerSupervisor authorization', () => {
  it('creator is editor, participants keep their roles, role-less participants are viewers, strangers get null', async () => {
    const roleless = {
      ...rec(),
      fileId: 'file-roleless',
      participants: [{ principal: 'user:carol' }],
    } as unknown as FileRegistryRecord;
    const { sup } = makeSupervisor({ records: [rec(), roleless] });
    expect(await sup.authorizeFile('user:alice', FILE)).toBe('editor');
    expect(await sup.authorizeFile('user:bob', FILE)).toBe('editor');
    expect(await sup.authorizeFile('user:eve', FILE)).toBe('viewer');
    expect(await sup.authorizeFile('user:mallory', FILE)).toBeNull();
    expect(await sup.authorizeFile('user:carol', 'file-roleless')).toBe('viewer');
    expect(await sup.authorizeFile('user:alice', 'file-nope')).toBeNull();
    expect(await sup.fileKnown(FILE)).toBe(true);
    expect(await sup.fileKnown('file-nope')).toBe(false);
  });
});

describe('TriggerSupervisor CRUD (detached)', () => {
  it('create/list/grant/enable/remove round-trip, flushing after each mutation', async () => {
    const { sup, mem } = makeSupervisor();
    const created = await sup.createForFile(FILE, {
      name: 'stamp',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);',
      permissions: WRITE_PERMS,
    });
    expect(created.granted).toBe(false);
    expect(mem.flushes()).toBeGreaterThan(0);
    const before = mem.flushes();

    const granted = await sup.grantForFile(FILE, created.id, 'user:alice');
    expect(granted.granted).toBe(true);
    const disabled = await sup.setEnabledForFile(FILE, created.id, false);
    expect(disabled.enabled).toBe(false);
    expect(mem.flushes()).toBeGreaterThan(before + 1);

    await expect(sup.grantForFile(FILE, 'trigger-nope', 'user:alice')).rejects.toThrow(
      /unknown trigger/,
    );
    expect(await sup.removeForFile(FILE, created.id)).toBe(true);
    expect(await sup.listForFile(FILE)).toEqual([]);
    await sup.stop();
  });

  it('propagates store flush failures at the mutation boundary', async () => {
    const failing: TriggerPersistenceProvider = {
      forScope: async () => ({
        persistence: { load: () => null, save: () => undefined, clear: () => undefined },
        flush: async () => {
          throw new Error('firestore write unavailable');
        },
      }),
    };
    const sup = new TriggerSupervisor({
      records: [rec()],
      persistenceProvider: failing,
      log: () => undefined,
    });
    await expect(
      sup.createForFile(FILE, {
        name: 'x',
        event: 'onEdit',
        script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);',
        permissions: WRITE_PERMS,
      }),
    ).rejects.toThrow(/firestore write unavailable/);
    await sup.stop();
  });
});

describe('TriggerSupervisor attach lifecycle', () => {
  it('fires onOpen ONCE per session (incl. across a supervisor restart), re-fires on session change, detaches on close', async () => {
    const mem = memoryProvider();
    const deps = {
      records: [rec()],
      persistenceProvider: mem.provider,
      nowMs: () => NOW,
      log: () => undefined,
    };
    const sup1 = new TriggerSupervisor(deps);
    const created = await sup1.createForFile(FILE, {
      name: 'opener',
      event: 'onOpen',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 99);',
      permissions: WRITE_PERMS,
    });
    await sup1.grantForFile(FILE, created.id, 'user:alice');

    const s1 = makeHandle('sess-1');
    await sup1.noteSessionReady(s1.handle);
    await tick();
    expect(sup1.attachedSessionFor(FILE)).toBe('sess-1');
    expect(s1.submitted).toHaveLength(1);
    expect(s1.host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 99,
    });

    // Same session reported again: no re-fire.
    await sup1.noteSessionReady(s1.handle);
    await tick();
    expect(s1.submitted).toHaveLength(1);

    // A NEW supervisor (restart) over the same store: still no re-fire.
    const sup2 = new TriggerSupervisor(deps);
    await sup2.noteSessionReady(s1.handle);
    await tick();
    expect(s1.submitted).toHaveLength(1);
    expect(sup2.attachedSessionFor(FILE)).toBe('sess-1');

    // Session change: re-fires against the new session's host.
    const s2 = makeHandle('sess-2');
    await sup2.noteSessionReady(s2.handle);
    await tick();
    expect(s2.submitted).toHaveLength(1);
    expect(sup2.attachedSessionFor(FILE)).toBe('sess-2');

    // Close: detach.
    await sup2.noteSessionClosed('sess-2');
    expect(sup2.attachedSessionFor(FILE)).toBeNull();
    await sup1.stop();
    await sup2.stop();
  });

  it('a live onEdit trigger fires on host edits with full read + multi-write semantics, and self-writes do not loop', async () => {
    const { sup } = makeSupervisor();
    const counter = await sup.createForFile(FILE, {
      name: 'counter',
      event: 'onEdit',
      script: [
        'const cur = api.getCell({sheet:"Sheet1",row:0,col:5});',
        'const n = cur.kind === "number" ? cur.value : 0;',
        'if (n < 5) {',
        '  api.setCell({sheet:"Sheet1",row:0,col:5}, n + 1);',
        '  api.setCell({sheet:"Sheet1",row:0,col:6}, n + 100);',
        '}',
      ].join('\n'),
      permissions: [
        { action: 'cell.read', target: 'Sheet1!5,0' },
        { action: 'cell.write', target: 'Sheet1!5,0' },
        { action: 'cell.write', target: 'Sheet1!6,0' },
      ],
    });
    await sup.grantForFile(FILE, counter.id, 'user:alice');

    const s1 = makeHandle('sess-live');
    await sup.noteSessionReady(s1.handle);
    // A user edit on the session host fires the trigger exactly once:
    // both writes land (multi-write runs to completion), the read saw
    // the pre-run value, and the trigger's own writes — applied
    // through submitOp while the wrapper's filter is up — do NOT
    // re-fire it (the counter stops at 1, not 5).
    s1.host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 'go',
      auth: { principal: 'user:bob' },
    });
    await tick(120);
    expect(s1.host.readCell({ sheet: 'Sheet1', row: 0, col: 5 })).toEqual({
      kind: 'number',
      value: 1,
    });
    expect(s1.host.readCell({ sheet: 'Sheet1', row: 0, col: 6 })).toEqual({
      kind: 'number',
      value: 100,
    });
    const status = (await sup.listForFile(FILE)).find((t) => t.id === counter.id);
    expect(status?.lastRun?.ok).toBe(true);
    await sup.stop();
  });

  it('ignores handles without a fileId', async () => {
    const { sup } = makeSupervisor();
    const s = makeHandle('sess-nofile', null);
    await sup.noteSessionReady(s.handle);
    expect(sup.attachedSessionFor(FILE)).toBeNull();
    await sup.stop();
  });
});

describe('TriggerSupervisor prod posture', () => {
  it('TRIGGER_STORE=prod without GCP_PROJECT_ID fails closed: prodBrokenReason set, nothing attached, no fallback', async () => {
    const sup = new TriggerSupervisor({
      records: [rec()],
      env: { TRIGGER_STORE: 'prod' },
      nowMs: () => NOW,
      log: () => undefined,
    });
    await expect(
      sup.createForFile(FILE, {
        name: 'x',
        event: 'onOpen',
        script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);',
        permissions: WRITE_PERMS,
      }),
    ).rejects.toThrow(/TRIGGER_STORE=prod/);
    expect(sup.prodBrokenReason).toMatch(/TRIGGER_STORE=prod/);
    await sup.noteSessionReady(makeHandle('sess-1').handle);
    expect(sup.attachedSessionFor(FILE)).toBeNull();
    await sup.stop();
  });
});

describe('TriggerSupervisor onOpen greeting marker', () => {
  it('an attach with NO onOpen trigger does not burn the greeting: an onOpen trigger created afterwards still fires at the next attach of the same session', async () => {
    const { sup } = makeSupervisor();
    const s1 = makeHandle('sess-greet');
    // Attach first (no triggers exist yet): the greeting must NOT be
    // recorded — nothing ran.
    await sup.noteSessionReady(s1.handle);
    await sup.noteSessionClosed('sess-greet');
    // Create + grant the onOpen trigger while detached.
    const created = await sup.createForFile(FILE, {
      name: 'late-greeter',
      event: 'onOpen',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 42);',
      permissions: WRITE_PERMS,
    });
    await sup.grantForFile(FILE, created.id, 'user:alice');
    // Re-attach the SAME session: the greeter fires now.
    await sup.noteSessionReady(s1.handle);
    await tick();
    expect(s1.submitted).toHaveLength(1);
    // And a third attach of the same session does not re-fire.
    await sup.noteSessionClosed('sess-greet');
    await sup.noteSessionReady(s1.handle);
    await tick();
    expect(s1.submitted).toHaveLength(1);
    await sup.stop();
  });
});
