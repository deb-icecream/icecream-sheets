/**
 * Desktop trigger hosting tests: TriggerHostManager against a REAL
 * EngineHost + a real temp directory (file-backed persistence), plus the
 * triggers:* IPC registration against a fake ipcMain.
 *
 * Proves: a granted onEdit trigger fires from a real engine edit and its
 * write lands in the model; grants persist across a manager restart with
 * no re-grant; setScope isolates specs per file path; the untitled
 * scope works; onOpen fires on re-scope; the IPC channels delegate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineHost } from '@icecream-sheets/engine';
import {
  DESKTOP_TRIGGER_EVENTS,
  TriggerHostManager,
  UNTITLED_TRIGGER_SCOPE,
} from '../src/triggers.js';
import { registerTriggersIpc, type TriggersIpcMain } from '../src/triggers-ipc.js';

const WRITE_PERMS = [
  { action: 'cell.write', target: 'Sheet1!1,0' },
  { action: 'cell.read', target: 'Sheet1!0,0' },
];

const managers: TriggerHostManager[] = [];
const dirs: string[] = [];

function makeManager(host: EngineHost) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icecream-triggers-'));
  dirs.push(dir);
  const manager = new TriggerHostManager({ host, dir });
  managers.push(manager);
  return { manager, dir };
}

function edit(host: EngineHost, row = 0, col = 0, value: unknown = 1) {
  host.execute({
    cmd: 'setCell',
    ref: { sheet: 'Sheet1', row, col },
    value: value as never,
    auth: { principal: 'user' },
  });
}

afterEach(() => {
  while (managers.length) managers.pop()!.dispose();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('TriggerHostManager', () => {
  it('starts in the untitled scope and lists the fireable events', () => {
    const host = new EngineHost();
    const { manager } = makeManager(host);
    expect(manager.scope).toBe(UNTITLED_TRIGGER_SCOPE);
    const listed = manager.list();
    expect(listed.events).toEqual([...DESKTOP_TRIGGER_EVENTS]);
    expect(listed.events).toEqual(['onOpen', 'onEdit', 'onInterval', 'onAtTime']);
    expect(listed.triggers).toEqual([]);
  });

  it('a granted onEdit trigger fires on a real engine edit and its write lands in the model', () => {
    const host = new EngineHost();
    const { manager, dir } = makeManager(host);
    const created = manager.create({
      name: 'stamp',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 42);',
      permissions: WRITE_PERMS,
    });
    expect(created.granted).toBe(false);
    expect(created.workbookId).toBe(UNTITLED_TRIGGER_SCOPE);
    // Ungranted: the edit is refused by the runtime (no write).
    edit(host, 0, 0, 10);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 }).kind).not.toBe('number');
    manager.grant(created.id);
    expect(manager.list().triggers[0]!.granted).toBe(true);
    // Specs + grants are real files on disk under the manager's dir.
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
    edit(host, 0, 0, 11);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 42,
    });
    expect(manager.list().triggers[0]!.lastRun!.ok).toBe(true);
  });

  it('grant persists across a manager restart (new manager, same dir + scope, no re-grant)', () => {
    const host = new EngineHost();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icecream-triggers-'));
    dirs.push(dir);
    const fileScope = path.join(dir, 'book.xlsx');

    const first = new TriggerHostManager({ host, dir });
    managers.push(first);
    first.setScope(fileScope);
    const created = first.create({
      name: 'persisted',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 11);',
      permissions: WRITE_PERMS,
    });
    first.grant(created.id);
    // Simulate an app restart: the old manager is gone entirely.
    first.dispose();
    managers.pop();

    const second = new TriggerHostManager({ host, dir });
    managers.push(second);
    second.setScope(fileScope);
    expect(second.scope).toBe(fileScope);
    const listed = second.list();
    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0]!.id).toBe(created.id);
    expect(listed.triggers[0]!.granted).toBe(true);
    // No re-grant: a real edit fires it against the same engine host.
    edit(host, 0, 0, 1);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 11,
    });
  });

  it('setScope to a different path isolates specs (and returning restores them)', () => {
    const host = new EngineHost();
    const { manager, dir } = makeManager(host);
    const scopeA = path.join(dir, 'a.xlsx');
    const scopeB = path.join(dir, 'b.xlsx');

    manager.setScope(scopeA);
    manager.create({
      name: 'only-a',
      event: 'onEdit',
      script: 'api.notify("a");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    manager.setScope(scopeB);
    expect(manager.list().triggers).toEqual([]);
    manager.create({
      name: 'only-b',
      event: 'onEdit',
      script: 'api.notify("b");',
      permissions: [{ action: 'ui.notify', target: 'workbook' }],
    });
    expect(manager.list().triggers.map((t) => t.name)).toEqual(['only-b']);
    manager.setScope(scopeA);
    expect(manager.list().triggers.map((t) => t.name)).toEqual(['only-a']);
    // And the untitled scope is its own isolated scope too.
    manager.setScope(null);
    expect(manager.scope).toBe(UNTITLED_TRIGGER_SCOPE);
    expect(manager.list().triggers).toEqual([]);
  });

  it('re-scoping fires onOpen for the new scope (persisted spec + grant re-applied)', () => {
    const host = new EngineHost();
    const { manager, dir } = makeManager(host);
    const scope = path.join(dir, 'open.xlsx');
    manager.setScope(scope);
    const created = manager.create({
      name: 'welcome',
      event: 'onOpen',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:0}, 7);',
      permissions: WRITE_PERMS,
    });
    manager.grant(created.id);
    // The trigger was created after this scope attached, so it has not
    // fired yet. Re-opening the same file (setScope again) attaches a
    // fresh host, re-applies the persisted grant and fires onOpen.
    manager.setScope(scope);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 7,
    });
    expect(manager.list().triggers[0]!.lastRun!.ok).toBe(true);
  });

  it('setEnabled + remove delegate to the current scope host', () => {
    const host = new EngineHost();
    const { manager } = makeManager(host);
    const created = manager.create({
      name: 'toggle',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 5);',
      permissions: WRITE_PERMS,
    });
    manager.grant(created.id);
    manager.setEnabled(created.id, false);
    edit(host, 0, 0, 1);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 }).kind).not.toBe('number');
    manager.setEnabled(created.id, true);
    edit(host, 0, 0, 2);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({
      kind: 'number',
      value: 5,
    });
    expect(manager.remove(created.id)).toBe(true);
    expect(manager.remove(created.id)).toBe(false);
    expect(manager.list().triggers).toEqual([]);
    expect(() => manager.grant('missing')).toThrow(/unknown trigger/);
  });
});

describe('registerTriggersIpc', () => {
  it('registers the five channels and delegates to the manager', async () => {
    const host = new EngineHost();
    const { manager } = makeManager(host);
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain: TriggersIpcMain = {
      handle: (channel, handler) => handlers.set(channel, handler),
    };
    registerTriggersIpc(ipcMain, manager);
    for (const ch of [
      'triggers:list',
      'triggers:create',
      'triggers:remove',
      'triggers:setEnabled',
      'triggers:grant',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

    const created = call('triggers:create', {
      name: 'via-ipc',
      event: 'onEdit',
      script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 9);',
      permissions: WRITE_PERMS,
    }) as { id: string; granted: boolean };
    expect(created.granted).toBe(false);
    call('triggers:grant', created.id);
    const listed = call('triggers:list') as {
      events: string[];
      triggers: { granted: boolean }[];
    };
    expect(listed.events).toEqual(['onOpen', 'onEdit', 'onInterval', 'onAtTime']);
    expect(listed.triggers[0]!.granted).toBe(true);
    call('triggers:setEnabled', created.id, false);
    expect(
      (call('triggers:list') as { triggers: { enabled: boolean }[] }).triggers[0]!.enabled,
    ).toBe(false);
    expect(call('triggers:remove', created.id)).toBe(true);
    expect((call('triggers:list') as { triggers: unknown[] }).triggers).toEqual([]);
    // Malformed input is a channel error, not a fake success.
    expect(() => call('triggers:create', { name: 1 })).toThrow(/triggers:create/);
    expect(() => call('triggers:grant', '')).toThrow(/triggers:grant/);
    expect(() => call('triggers:setEnabled', created.id, 'yes')).toThrow(/triggers:setEnabled/);
  });
});
