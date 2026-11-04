/**
 * Tests for SessionTriggerHost (hosting core) and the additive
 * TriggerRuntime options (workbookId + onRunReport).
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import { memoryPersistence } from '../src/index.js';
import { createTriggerStore, createTriggerSpec } from '../src/index.js';
import {
  SessionTriggerHost,
  TriggerRuntime,
  type RunReport,
} from '../src/automation/node.js';

const WRITE_PERMS = [
  { action: 'cell.write', target: 'Sheet1!1,0' },
  { action: 'cell.read', target: 'Sheet1!0,0' },
];

function edit(host: EngineHost, row = 0, col = 0, value: unknown = 1) {
  host.execute({
    cmd: 'setCell',
    ref: { sheet: 'Sheet1', row, col },
    value: value as never,
    auth: { principal: 'user' },
  });
}

// ---------------------------------------------------------------------------
// TriggerRuntime additive options (deliverable 1)
// ---------------------------------------------------------------------------

describe('TriggerRuntime workbookId + onRunReport', () => {
  it('(a) a workbook-scoped spec fires from a real host edit via the subscription', () => {
    const host = new EngineHost();
    const reports: RunReport[] = [];
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      workbookId: 'wb-42',
      onRunReport: (r) => reports.push(r),
    });
    const spec = rt.addTrigger(
      createTriggerSpec({
        name: 'wb-scoped',
        event: 'onEdit',
        workbookId: 'wb-42',
        script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 99);',
        permissions: WRITE_PERMS,
      }),
    );
    rt.grantTriggerPermissions(spec.id, 'user');
    edit(host, 0, 0, 5);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 99,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.ok).toBe(true);
    expect(reports[0]!.triggerId).toBe(spec.id);
    rt.dispose();
  });

  it('(a) a workbook-scoped spec for a different workbook does not fire via the subscription', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      workbookId: 'wb-42',
    });
    const spec = rt.addTrigger(
      createTriggerSpec({
        name: 'other-wb',
        event: 'onEdit',
        workbookId: 'wb-other',
        script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 99);',
        permissions: WRITE_PERMS,
      }),
    );
    rt.grantTriggerPermissions(spec.id, 'user');
    edit(host, 0, 0, 5);
    // Cell stays empty (blank).
    const cell = host.readCell({ sheet: 'Sheet1', row: 0, col: 1 });
    expect(cell.kind).not.toBe('number');
    rt.dispose();
  });

  it('(a) fireOpen/fireEdit default workbookId to the runtime workbookId', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      workbookId: 'wb-7',
    });
    const open = rt.addTrigger(
      createTriggerSpec({
        name: 'opener',
        event: 'onOpen',
        workbookId: 'wb-7',
        script: 'api.notify("hi");',
        permissions: [{ action: 'ui.notify', target: 'workbook' }],
      }),
    );
    rt.grantTriggerPermissions(open.id, 'user');
    const reports = rt.fireOpen();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.ok).toBe(true);
    // Explicit mismatched id still filters out.
    expect(rt.fireOpen('wb-nope')).toHaveLength(0);
    rt.dispose();
  });

  it('(b) onRunReport observes subscription-driven runs and grant refusals', () => {
    const host = new EngineHost();
    const reports: RunReport[] = [];
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      onRunReport: (r) => reports.push(r),
    });
    const spec = rt.addTrigger(
      createTriggerSpec({
        name: 'guarded',
        event: 'onEdit',
        script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 7);',
        permissions: WRITE_PERMS,
      }),
    );
    // Ungranted: subscription fire is refused and observed.
    edit(host, 0, 0, 1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.ok).toBe(false);
    expect(reports[0]!.error).toMatch(/not been granted/);
    // Granted: subscription fire succeeds and is observed.
    rt.grantTriggerPermissions(spec.id, 'user');
    edit(host, 0, 0, 2);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.ok).toBe(true);
    rt.dispose();
  });

  it('(b) onRunReport observes tick-path runs', () => {
    const host = new EngineHost();
    const reports: RunReport[] = [];
    let now = new Date('2026-10-22T10:00:00Z');
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      now: () => now,
      onRunReport: (r) => reports.push(r),
    });
    const spec = rt.addTrigger(
      createTriggerSpec({
        name: 'ticker',
        event: 'onInterval',
        intervalMs: 60_000,
        script: 'api.notify("tick");',
        permissions: [{ action: 'ui.notify', target: 'workbook' }],
      }),
    );
    rt.grantTriggerPermissions(spec.id, 'user');
    const tickReports = rt.tick(now);
    expect(tickReports).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.triggerId).toBe(spec.id);
    expect(reports[0]!.ok).toBe(true);
    rt.dispose();
  });

  it('(b) a throwing onRunReport observer never breaks firing or the fan-out', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      onRunReport: () => {
        throw new Error('observer boom');
      },
    });
    const spec = rt.addTrigger(
      createTriggerSpec({
        name: 'resilient',
        event: 'onEdit',
        script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 3);',
        permissions: WRITE_PERMS,
      }),
    );
    rt.grantTriggerPermissions(spec.id, 'user');
    expect(() => edit(host, 0, 0, 1)).not.toThrow();
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 3,
    });
    // Direct fire path is also safe.
    expect(() => rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }])).not.toThrow();
    rt.dispose();
  });
});

// ---------------------------------------------------------------------------
// SessionTriggerHost
// ---------------------------------------------------------------------------

describe('SessionTriggerHost', () => {
  it('attach + granted trigger fires on a real EngineHost edit', () => {
    const persistence = memoryPersistence();
    const sh = new SessionTriggerHost({ persistence, scope: 'file-1' });
    const created = sh.create({
      name: 'stamp',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 42);',
      permissions: WRITE_PERMS,
    });
    expect(created.workbookId).toBe('file-1');
    expect(created.granted).toBe(false);
    expect(created.lastRun).toBeNull();
    sh.grant(created.id, 'user');
    expect(sh.isGranted(created.id)).toBe(true);
    expect(sh.isGranted(created)).toBe(true);

    const host = new EngineHost();
    sh.attach(host);
    expect(sh.attached).toBe(true);
    edit(host, 0, 0, 10);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 42,
    });
    const [status] = sh.list();
    expect(status!.granted).toBe(true);
    expect(status!.lastRun).not.toBeNull();
    expect(status!.lastRun!.ok).toBe(true);
    expect(typeof status!.lastRun!.durationMs).toBe('number');
    expect(typeof status!.lastRun!.at).toBe('string');
    sh.detach();
    expect(sh.attached).toBe(false);
  });

  it('ungranted trigger is refused and the refusal reaches lastRun', () => {
    const persistence = memoryPersistence();
    const sh = new SessionTriggerHost({ persistence, scope: 'file-2' });
    const created = sh.create({
      name: 'noguard',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 42);',
      permissions: WRITE_PERMS,
    });
    const host = new EngineHost();
    sh.attach(host);
    edit(host, 0, 0, 10);
    const cell = host.readCell({ sheet: 'Sheet1', row: 0, col: 1 });
    expect(cell.kind).not.toBe('number');
    const [status] = sh.list();
    expect(status!.id).toBe(created.id);
    expect(status!.granted).toBe(false);
    expect(status!.lastRun).not.toBeNull();
    expect(status!.lastRun!.ok).toBe(false);
    expect(status!.lastRun!.error).toMatch(/not been granted/);
    sh.detach();
  });

  it('grant persists across detach + a brand-new host over the same persistence+scope', () => {
    const persistence = memoryPersistence();
    const sh1 = new SessionTriggerHost({ persistence, scope: 'file-3' });
    const created = sh1.create({
      name: 'persisted',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 11);',
      permissions: WRITE_PERMS,
    });
    sh1.grant(created.id, 'alice');
    // Grant records are persisted under the scoped grants key.
    const raw = persistence.load('file-3::icecream-sheets.trigger-grants.v1');
    expect(raw).not.toBeNull();
    const records = JSON.parse(raw!) as Array<{ triggerId: string; grantedBy: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.triggerId).toBe(created.id);
    expect(records[0]!.grantedBy).toBe('alice');

    const host1 = new EngineHost();
    sh1.attach(host1);
    sh1.detach();

    // Brand-new host, same persistence + scope, fresh engine: no re-grant.
    const sh2 = new SessionTriggerHost({ persistence, scope: 'file-3' });
    expect(sh2.isGranted(created.id)).toBe(true);
    expect(sh2.list()[0]!.granted).toBe(true);
    const host2 = new EngineHost();
    sh2.attach(host2);
    edit(host2, 0, 0, 1);
    expect(host2.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 11,
    });
    sh2.detach();
  });

  it('grant throws on unknown id (mirrors runtime)', () => {
    const sh = new SessionTriggerHost({ persistence: memoryPersistence(), scope: 'file-x' });
    expect(() => sh.grant('nope', 'user')).toThrow(/unknown trigger/);
  });

  it('scope isolation: two scopes share one persistence without leaking', () => {
    const persistence = memoryPersistence();
    const a = new SessionTriggerHost({ persistence, scope: 'scope-a' });
    const b = new SessionTriggerHost({ persistence, scope: 'scope-b' });
    const ca = a.create({
      name: 'only-a',
      event: 'onEdit',
      script: 'api.notify("a");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    b.create({
      name: 'only-b',
      event: 'onEdit',
      script: 'api.notify("b");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    expect(a.list().map((t) => t.name)).toEqual(['only-a']);
    expect(b.list().map((t) => t.name)).toEqual(['only-b']);
    a.grant(ca.id, 'user');
    expect(a.isGranted(ca.id)).toBe(true);
    expect(b.list()[0]!.granted).toBe(false);
    // Underlying keys are prefixed per scope.
    expect(persistence.load('scope-a::icecream-sheets.triggers.v1')).not.toBeNull();
    expect(persistence.load('scope-b::icecream-sheets.triggers.v1')).not.toBeNull();
  });

  it('create/list/remove/setEnabled while detached persist across instances', () => {
    const persistence = memoryPersistence();
    const sh1 = new SessionTriggerHost({ persistence, scope: 'file-detached' });
    expect(sh1.attached).toBe(false);
    const t1 = sh1.create({
      name: 'one',
      event: 'onEdit',
      script: 'api.notify("1");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    const t2 = sh1.create({
      name: 'two',
      event: 'onOpen',
      script: 'api.notify("2");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    // Defaults: workbookId = scope.
    expect(t1.workbookId).toBe('file-detached');
    expect(t2.workbookId).toBe('file-detached');
    sh1.setEnabled(t1.id, false);
    sh1.grant(t2.id, 'user');

    const sh2 = new SessionTriggerHost({ persistence, scope: 'file-detached' });
    const listed = sh2.list();
    expect(listed).toHaveLength(2);
    expect(listed.find((t) => t.id === t1.id)!.enabled).toBe(false);
    expect(listed.find((t) => t.id === t2.id)!.enabled).toBe(true);
    expect(listed.find((t) => t.id === t2.id)!.granted).toBe(true);

    // setEnabled unknown throws while detached.
    expect(() => sh2.setEnabled('missing', true)).toThrow(/unknown trigger/);

    // create validates via createTriggerSpec.
    expect(() =>
      sh2.create({ name: '', event: 'onEdit', script: 'x' }),
    ).toThrow(/name must be a non-empty/);
    expect(() =>
      sh2.create({ name: 'bad', event: 'onInterval', script: 'x' }),
    ).toThrow(/intervalMs/);

    // remove drops the spec, its grants and persists.
    expect(sh2.remove(t2.id)).toBe(true);
    expect(sh2.remove(t2.id)).toBe(false);
    const sh3 = new SessionTriggerHost({ persistence, scope: 'file-detached' });
    expect(sh3.list().map((t) => t.name)).toEqual(['one']);
    expect(sh3.isGranted(t2.id)).toBe(false);
  });

  it('setEnabled works while attached (via runtime) and disable stops firing', () => {
    const persistence = memoryPersistence();
    const sh = new SessionTriggerHost({ persistence, scope: 'file-toggle' });
    const created = sh.create({
      name: 'toggle',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 5);',
      permissions: WRITE_PERMS,
    });
    sh.grant(created.id, 'user');
    const host = new EngineHost();
    sh.attach(host);
    expect(() => sh.setEnabled('missing', true)).toThrow(/unknown trigger/);
    sh.setEnabled(created.id, false);
    edit(host, 0, 0, 1);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 }).kind).not.toBe('number');
    sh.setEnabled(created.id, true);
    edit(host, 0, 0, 2);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 5,
    });
    sh.detach();
    // Persisted enabled state survives.
    const sh2 = new SessionTriggerHost({ persistence, scope: 'file-toggle' });
    expect(sh2.list()[0]!.enabled).toBe(true);
  });

  it('detach stops firing', () => {
    const persistence = memoryPersistence();
    const sh = new SessionTriggerHost({ persistence, scope: 'file-detach' });
    const created = sh.create({
      name: 'detachable',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 8);',
      permissions: WRITE_PERMS,
    });
    sh.grant(created.id, 'user');
    const host = new EngineHost();
    sh.attach(host);
    edit(host, 0, 0, 1);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 8,
    });
    sh.detach();
    // Clear the target cell directly, then edit again: no fire.
    host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 1 },
      value: null,
      auth: { principal: 'user' },
    });
    edit(host, 0, 0, 2);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 }).kind).not.toBe('number');
    expect(sh.fireOpen()).toEqual([]);
  });

  it('workbookId-scoped spec fires via subscription through the host (regression for workbookId)', () => {
    const persistence = memoryPersistence();
    const sh = new SessionTriggerHost({ persistence, scope: 'wb-host-1' });
    // create() defaults workbookId to scope, so this spec IS workbook-scoped.
    const created = sh.create({
      name: 'scoped-fire',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:2,col:2}, 77);',
      permissions: [{ action: 'cell.write', target: 'Sheet1!2,2' }],
    });
    expect(created.workbookId).toBe('wb-host-1');
    sh.grant(created.id, 'user');
    const host = new EngineHost();
    sh.attach(host);
    edit(host, 3, 3, 1);
    expect(host.readCell({ sheet: 'Sheet1', row: 2, col: 2 })).toEqual({
      kind: 'number',
      value: 77,
    });
    expect(sh.list()[0]!.lastRun!.ok).toBe(true);
    sh.detach();
  });

  it('fireOpen fires onOpen triggers for the scope when attached', () => {
    const persistence = memoryPersistence();
    const sh = new SessionTriggerHost({ persistence, scope: 'file-open' });
    const created = sh.create({
      name: 'welcome',
      event: 'onOpen',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:0}, 1);',
      permissions: WRITE_PERMS,
    });
    sh.grant(created.id, 'user');
    expect(sh.fireOpen()).toEqual([]);
    const host = new EngineHost();
    sh.attach(host);
    const reports = sh.fireOpen();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.ok).toBe(true);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 1,
    });
    expect(sh.list()[0]!.lastRun!.ok).toBe(true);
    sh.detach();
  });

  it('attach detaches any previous runtime', () => {
    const persistence = memoryPersistence();
    const sh = new SessionTriggerHost({ persistence, scope: 'file-reattach' });
    const created = sh.create({
      name: 're',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 6);',
      permissions: WRITE_PERMS,
    });
    sh.grant(created.id, 'user');
    const host1 = new EngineHost();
    const host2 = new EngineHost();
    sh.attach(host1);
    sh.attach(host2);
    // Old host no longer fires.
    edit(host1, 0, 0, 1);
    expect(host1.readCell({ sheet: 'Sheet1', row: 0, col: 1 }).kind).not.toBe('number');
    // New host fires.
    edit(host2, 0, 0, 1);
    expect(host2.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 6,
    });
    sh.detach();
  });
});

describe('SessionTriggerHost late failure + cross-process refresh', () => {
  it('noteLateRunFailure corrects an ok last-run entry; unknown ids are ignored', () => {
    const sh = new SessionTriggerHost({ persistence: memoryPersistence(), scope: 'wb-late' });
    const created = sh.create({
      name: 'writer',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 6);',
      permissions: WRITE_PERMS,
    });
    sh.grant(created.id, 'user');
    const engine = new EngineHost();
    sh.attach(engine);
    edit(engine, 0, 0, 1);
    expect(sh.lastRunFor(created.id)?.ok).toBe(true);
    sh.noteLateRunFailure(created.id, 'op rejected by the engine');
    const corrected = sh.lastRunFor(created.id);
    expect(corrected?.ok).toBe(false);
    expect(corrected?.error).toBe('op rejected by the engine');
    // Unknown id: silently ignored (no entry created).
    sh.noteLateRunFailure('trigger-nope', 'x');
    expect(sh.lastRunFor('trigger-nope')).toBeNull();
    sh.detach();
  });

  it('recordRunFailure creates a last-run failure for a trigger that never ran (tick self-open failures)', () => {
    const sh = new SessionTriggerHost({ persistence: memoryPersistence(), scope: 'wb-tickfail' });
    const created = sh.create({
      name: 'timed',
      event: 'onAtTime',
      atTimeIso: new Date(Date.now() + 60_000).toISOString(),
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 6);',
      permissions: WRITE_PERMS,
    });
    expect(sh.lastRunFor(created.id)).toBeNull();
    sh.recordRunFailure(created.id, 'tick self-open refused by the engine (status 500)');
    const run = sh.lastRunFor(created.id);
    expect(run?.ok).toBe(false);
    expect(run?.error).toContain('refused by the engine');
    // And it corrects an existing entry in place, like the late path.
    sh.recordRunFailure(created.id, 'tick: did not fire within the window');
    expect(sh.lastRunFor(created.id)?.error).toContain('did not fire');
  });

  it('refreshFromStore picks up specs + grants written through another host over the same persistence', () => {
    const shared = memoryPersistence();
    const a = new SessionTriggerHost({ persistence: shared, scope: 'wb-refresh' });
    const b = new SessionTriggerHost({ persistence: shared, scope: 'wb-refresh' });
    const engine = new EngineHost();
    b.attach(engine);
    // Populate B's store cache first (this is what makes it go stale).
    expect(b.list()).toEqual([]);
    // A (another "process") creates + grants while B is attached.
    const created = a.create({
      name: 'from-a',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 6);',
      permissions: WRITE_PERMS,
    });
    a.grant(created.id, 'user');
    // B's cached store does not see it until refresh.
    expect(b.list().map((t) => t.id)).not.toContain(created.id);
    b.refreshFromStore();
    expect(b.list().map((t) => t.id)).toContain(created.id);
    expect(b.isGranted(created.id)).toBe(true);
    // And the refreshed grant lets it actually fire on B's engine.
    edit(engine, 0, 0, 1);
    expect(engine.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 6,
    });
    b.detach();
  });
});
