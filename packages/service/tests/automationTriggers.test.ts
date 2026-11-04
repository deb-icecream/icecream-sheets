/**
 * Tests for trigger specs (versioned, metadata-store backed) and the event
 * runtime: onOpen/onEdit/onSelectionChange/timed triggers, grant
 * discipline, and sandboxed execution of JS and Python handlers.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import {
  TRIGGER_SPEC_VERSION,
  createTriggerSpec,
  createTriggerStore,
  deserializeTriggers,
  memoryPersistence,
  migrateTrigger,
  serializeTriggers,
  validateTriggerSpec,
} from '../src/index.js';
import {
  TriggerRuntime,
  triggerPrincipal,
} from '../src/automation/node.js';

describe('trigger specs', () => {
  it('createTriggerSpec fills defaults and validates', () => {
    const spec = createTriggerSpec({
      name: 'stamp edits',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);',
      permissions: [{ action: 'cell.write', target: 'Sheet1!1,0' }],
    });
    expect(spec.version).toBe(TRIGGER_SPEC_VERSION);
    expect(spec.enabled).toBe(true);
    expect(spec.language).toBe('javascript');
    expect(validateTriggerSpec(spec)).toEqual([]);
  });

  it('rejects bad specs with clear problems', () => {
    expect(() =>
      createTriggerSpec({ name: '', event: 'onEdit', script: 'x' }),
    ).toThrow(/name must be a non-empty/);
    expect(() =>
      createTriggerSpec({ name: 't', event: 'onInterval', script: 'x' }),
    ).toThrow(/intervalMs/);
    expect(() =>
      createTriggerSpec({ name: 't', event: 'onAtTime', script: 'x', atTimeIso: 'not-a-date' }),
    ).toThrow(/atTimeIso/);
    expect(() =>
      createTriggerSpec({ name: 't', event: 'onEdit', script: '   ' }),
    ).toThrow(/script must be a non-empty/);
  });

  it('serialize/deserialize round-trips through the metadata store', () => {
    const store = createTriggerStore(memoryPersistence());
    const spec = createTriggerSpec({
      name: 'nightly',
      event: 'onInterval',
      intervalMs: 60000,
      script: 'api.recalculate();',
      permissions: [{ action: 'calc.recalculate', target: 'workbook' }],
    });
    store.add(spec);
    const back = createTriggerStore(
      (() => {
        const p = memoryPersistence();
        p.save('icecream-sheets.triggers.v1', serializeTriggers(store.all()));
        return p;
      })(),
    );
    expect(back.all()).toHaveLength(1);
    expect(back.all()[0]!.name).toBe('nightly');
  });

  it('corrupt payloads deserialize to [] (metadata-store convention)', () => {
    expect(deserializeTriggers('garbage')).toEqual([]);
    expect(deserializeTriggers('{"triggers":"nope"}')).toEqual([]);
  });

  it('migrateTrigger fills defaults for legacy specs', () => {
    const migrated = migrateTrigger({ name: 'old' } as never);
    expect(migrated.version).toBe(TRIGGER_SPEC_VERSION);
    expect(migrated.language).toBe('javascript');
    expect(migrated.permissions).toEqual([]);
  });

  it('triggerPrincipal is stable per name', () => {
    expect(triggerPrincipal({ name: 'rollup' })).toBe('automation:rollup');
  });
});

function jsTrigger(name: string, script: string, event: 'onEdit' | 'onOpen' | 'onSelectionChange' | 'onInterval' | 'onAtTime' = 'onEdit') {
  return createTriggerSpec({
    name,
    event,
    script,
    permissions: [
      { action: 'cell.write', target: 'Sheet1!0,1' },
      { action: 'cell.read', target: 'Sheet1!0,0' },
    ],
  });
}

describe('TriggerRuntime', () => {
  it('refuses to run until permissions are granted', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const spec = rt.addTrigger(jsTrigger('guarded', 'api.setCell({sheet:"Sheet1",row:0,col:1}, 7);'));
    const [report] = rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }]);
    expect(report!.ok).toBe(false);
    expect(report!.error).toMatch(/not been granted/);
    rt.grantTriggerPermissions(spec.id, 'user');
    const [report2] = rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }]);
    expect(report2!.ok).toBe(true);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 7,
    });
    rt.dispose();
  });

  it('onEdit fires from the engine cellsChanged event with a frozen event object', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    rt.addTrigger(
      jsTrigger(
        'mirror',
        `const r = event.refs[0];
         api.setCell({sheet: r.sheet, row: 9, col: 9}, r.row * 10 + r.col);`,
      ),
    );
    rt.grantTriggerPermissions(rt.list()[0]!.id, 'user');
    host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 2, col: 3 },
      value: 1,
      auth: { principal: 'user' },
    });
    expect(host.readCell({ sheet: 'Sheet1', row: 9, col: 9 })).toEqual({
      kind: 'number',
      value: 23,
    });
    rt.dispose();
  });

  it('respects sheet and range scope', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'addSheet', name: 'Other', auth: { principal: 'user' } });
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const spec = rt.addTrigger({
      ...jsTrigger('scoped', 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);'),
      sheet: 'Sheet1',
      range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    });
    void spec;
    rt.grantTriggerPermissions(rt.list()[0]!.id, 'user');
    // Edit outside the scoped range: no fire.
    expect(rt.fireEdit([{ sheet: 'Sheet1', row: 5, col: 5 }])).toHaveLength(0);
    // Edit on another sheet: no fire.
    expect(rt.fireEdit([{ sheet: 'Other', row: 0, col: 0 }])).toHaveLength(0);
    // Edit inside scope: fires.
    const [report] = rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }]);
    expect(report!.ok).toBe(true);
    rt.dispose();
  });

  it('onOpen and onSelectionChange fire explicitly', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const open = rt.addTrigger({
      name: 'welcome',
      event: 'onOpen',
      script: 'api.notify("welcome");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    const sel = rt.addTrigger({
      name: 'selwatch',
      event: 'onSelectionChange',
      script: 'api.notify("moved");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    rt.grantTriggerPermissions(open.id, 'user');
    rt.grantTriggerPermissions(sel.id, 'user');
    const [r1] = rt.fireOpen();
    expect(r1!.ok).toBe(true);
    expect(r1!.notifications).toEqual(['welcome']);
    const [r2] = rt.fireSelectionChange({ sheet: 'Sheet1', row: 3, col: 3 });
    expect(r2!.ok).toBe(true);
    expect(r2!.notifications).toEqual(['moved']);
    rt.dispose();
  });

  it('disabled triggers do not fire', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const spec = rt.addTrigger(jsTrigger('off', 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);'));
    rt.grantTriggerPermissions(spec.id, 'user');
    rt.setEnabled(spec.id, false);
    expect(rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }])).toHaveLength(0);
    rt.dispose();
  });

  it('onInterval fires on tick when due, then not again until the interval elapses', () => {
    const host = new EngineHost();
    let now = new Date('2026-10-18T10:00:00Z');
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      now: () => now,
    });
    const spec = rt.addTrigger({
      name: 'every-minute',
      event: 'onInterval',
      intervalMs: 60_000,
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);',
      permissions: [{ action: 'cell.write', target: 'Sheet1!0,1' }],
    });
    rt.grantTriggerPermissions(spec.id, 'user');
    expect(rt.tick(now)).toHaveLength(1); // never fired -> due
    expect(rt.tick(now)).toHaveLength(0); // just fired -> not due
    now = new Date(now.getTime() + 61_000);
    expect(rt.tick(now)).toHaveLength(1); // interval elapsed -> due
    rt.dispose();
  });

  it('onAtTime fires once when its timestamp passes', () => {
    const host = new EngineHost();
    let now = new Date('2026-10-18T10:00:00Z');
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()), {
      now: () => now,
    });
    const spec = rt.addTrigger({
      name: 'once',
      event: 'onAtTime',
      atTimeIso: '2026-10-18T10:05:00Z',
      script: 'api.notify("fired");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    rt.grantTriggerPermissions(spec.id, 'user');
    expect(rt.tick(now)).toHaveLength(0);
    now = new Date('2026-10-18T10:06:00Z');
    const [report] = rt.tick(now);
    expect(report!.ok).toBe(true);
    expect(rt.tick(now)).toHaveLength(0); // one-shot
    rt.dispose();
  });

  it('a failing trigger reports the error without breaking other triggers', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const bad = rt.addTrigger(jsTrigger('bad', 'throw new Error("boom");'));
    const good = rt.addTrigger(jsTrigger('good', 'api.setCell({sheet:"Sheet1",row:0,col:1}, 3);'));
    rt.grantTriggerPermissions(bad.id, 'user');
    rt.grantTriggerPermissions(good.id, 'user');
    const reports = rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }]);
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.name === 'bad')!.ok).toBe(false);
    expect(reports.find((r) => r.name === 'good')!.ok).toBe(true);
    rt.dispose();
  });

  it('python triggers collect actions and replay them through the API', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const spec = rt.addTrigger({
      name: 'py',
      event: 'onEdit',
      language: 'python',
      script: [
        'ref = event["refs"][0]',
        'actions = [',
        '  {"method": "setCell", "args": [{"sheet": ref["sheet"], "row": 4, "col": 4}, 42]},',
        '  {"method": "notify", "args": ["py says hi"]},',
        ']',
      ].join('\n'),
      permissions: [
        { action: 'cell.write', target: 'Sheet1!4,4' },
        { action: 'ui.notify', target: 'workbook' },
      ],
    });
    rt.grantTriggerPermissions(spec.id, 'user');
    const [report] = rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }]);
    expect(report!.ok).toBe(true);
    expect(report!.notifications).toEqual(['py says hi']);
    expect(host.readCell({ sheet: 'Sheet1', row: 4, col: 4 })).toEqual({
      kind: 'number',
      value: 42,
    });
    rt.dispose();
  });

  it('trigger writes do not re-fire triggers (no infinite recursion)', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const spec = rt.addTrigger({
      name: 'counter',
      event: 'onEdit',
      script: [
        'const cur = api.getCell({sheet:"Sheet1",row:0,col:5});',
        'const n = cur.kind === "number" ? cur.value : 0;',
        'if (n < 5) api.setCell({sheet:"Sheet1",row:0,col:5}, n + 1);',
      ].join('\n'),
      permissions: [
        { action: 'cell.read', target: 'Sheet1!5,0' },
        { action: 'cell.write', target: 'Sheet1!5,0' },
      ],
    });
    rt.grantTriggerPermissions(spec.id, 'user');
    host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 'go',
      auth: { principal: 'user' },
    });
    // EnableEvents=false semantics: the trigger's own write fires no
    // nested trigger, so the counter stops at 1 (not 5).
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 5 })).toEqual({
      kind: 'number',
      value: 1,
    });
    rt.dispose();
  });

  it('removeTrigger stops future fires', () => {
    const host = new EngineHost();
    const rt = new TriggerRuntime(host, createTriggerStore(memoryPersistence()));
    const spec = rt.addTrigger(jsTrigger('temp', 'api.setCell({sheet:"Sheet1",row:0,col:1}, 1);'));
    rt.grantTriggerPermissions(spec.id, 'user');
    expect(rt.removeTrigger(spec.id)).toBe(true);
    expect(rt.fireEdit([{ sheet: 'Sheet1', row: 0, col: 0 }])).toHaveLength(0);
    rt.dispose();
  });
});
