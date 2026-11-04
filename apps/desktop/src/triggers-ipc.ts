/**
 * Trigger IPC wiring (desktop local-mode trigger hosting).
 *
 * Registers the triggers:* IPC channels against an injected ipcMain-like
 * object so the wiring is unit-testable without booting Electron (same
 * pattern as ./engine-ipc and ./auth-ipc). The channels mirror the
 * gateway automation contract minus fileId — main's TriggerHostManager
 * is already scoped to the currently open local file:
 *
 *   triggers:list       () → { events: string[], triggers: TriggerStatus[] }
 *   triggers:create     (TriggerSpecInit) → TriggerStatus
 *   triggers:remove     (id: string) → boolean (whether a spec was removed)
 *   triggers:setEnabled (id: string, enabled: boolean) → void
 *   triggers:grant      (id: string) → void (grant recorded as the local user)
 *
 * Error posture mirrors engine-ipc: malformed renderer input throws a
 * channel-prefixed Error (the invoke rejects and the renderer surfaces
 * it); manager errors (unknown trigger, invalid spec) propagate the
 * same way — never swallowed, never a fake success.
 */

import type { TriggerSpecInit } from '@icecream-sheets/service';
import type { TriggerHostManager, TriggerListResult, TriggerStatus } from './triggers';

export interface TriggersIpcMain {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function registerTriggersIpc(
  ipcMain: TriggersIpcMain,
  manager: TriggerHostManager,
): void {
  ipcMain.handle('triggers:list', (): TriggerListResult => manager.list());

  ipcMain.handle('triggers:create', (_event: unknown, init: unknown): TriggerStatus => {
    if (!isRecord(init) || typeof init['name'] !== 'string' || typeof init['event'] !== 'string') {
      throw new Error('triggers:create: expected a trigger spec init {name, event, ...}');
    }
    // Full spec validation lives in createTriggerSpec (via the host):
    // its error propagates to the renderer verbatim.
    return manager.create(init as unknown as TriggerSpecInit);
  });

  ipcMain.handle('triggers:remove', (_event: unknown, id: unknown): boolean => {
    if (typeof id !== 'string' || id === '') {
      throw new Error('triggers:remove: expected a trigger id string');
    }
    return manager.remove(id);
  });

  ipcMain.handle(
    'triggers:setEnabled',
    (_event: unknown, id: unknown, enabled: unknown): void => {
      if (typeof id !== 'string' || id === '' || typeof enabled !== 'boolean') {
        throw new Error('triggers:setEnabled: expected (id: string, enabled: boolean)');
      }
      manager.setEnabled(id, enabled);
    },
  );

  ipcMain.handle('triggers:grant', (_event: unknown, id: unknown): void => {
    if (typeof id !== 'string' || id === '') {
      throw new Error('triggers:grant: expected a trigger id string');
    }
    manager.grant(id);
  });
}
