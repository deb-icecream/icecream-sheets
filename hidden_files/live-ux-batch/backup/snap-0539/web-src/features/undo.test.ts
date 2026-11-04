/**
 * UndoManager named-range hooks: structural ops (insert/delete rows/cols)
 * and name edits capture the store's definitions; undo/redo restore them.
 */
import { describe, expect, it } from 'vitest';
import { UndoManager } from './undo';
import type { NamedRangeDef } from '@icecream-sheets/service';
import type { EngineHost } from '@icecream-sheets/engine';

function def(name: string, startRow: number, endRow: number): NamedRangeDef {
  return {
    id: `nr:${name}`,
    name,
    scope: { kind: 'workbook' },
    ref: { sheet: 'Sheet1', startRow, startCol: 0, endRow, endCol: 0 },
    createdBy: 'owner',
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
}

/** In-memory stand-in for the NamedRangeStore + App refresh. */
function makeNamesWorld() {
  let defs: NamedRangeDef[] = [def('Data', 0, 9)];
  let refreshes = 0;
  const hooks = {
    snapshotNames: (): NamedRangeDef[] =>
      defs.map((d) => ({ ...d, ref: d.ref ? { ...d.ref } : null })),
    restoreNames: (next: NamedRangeDef[]): void => {
      defs = next.map((d) => ({ ...d, ref: d.ref ? { ...d.ref } : null }));
      refreshes++;
    },
  };
  return {
    hooks,
    get: () => defs,
    set: (next: NamedRangeDef[]) => {
      defs = next;
    },
    refreshCount: () => refreshes,
  };
}

// undo()/redo() with no captured cells never touch the host.
const dummyHost = {
  getView: () => ({
    readCell: () => ({ value: { kind: 'null' as const }, formula: undefined }),
  }),
  execute: () => ({ ok: true }),
} as unknown as EngineHost;

describe('UndoManager named-range hooks', () => {
  it('restores shifted defs on undo after a structural op', () => {
    const world = makeNamesWorld();
    const mgr = new UndoManager();
    mgr.setNamesHooks(world.hooks);

    // Simulate: insert a row at 0 -> the tracked range shifts down by 1.
    mgr.capture(dummyHost, 'Sheet1', [], 'Insert row', true);
    world.set([def('Data', 1, 10)]);

    expect(mgr.undo(dummyHost)).toBe(true);
    const restored = world.get();
    expect(restored).toHaveLength(1);
    expect(restored[0].ref?.startRow).toBe(0);
    expect(restored[0].ref?.endRow).toBe(9);
    expect(world.refreshCount()).toBeGreaterThan(0);
  });

  it('redo re-applies the post-op defs', () => {
    const world = makeNamesWorld();
    const mgr = new UndoManager();
    mgr.setNamesHooks(world.hooks);

    mgr.capture(dummyHost, 'Sheet1', [], 'Insert row', true);
    world.set([def('Data', 1, 10)]);

    expect(mgr.undo(dummyHost)).toBe(true);
    expect(mgr.redo(dummyHost)).toBe(true);
    const redone = world.get();
    expect(redone[0].ref?.startRow).toBe(1);
    expect(redone[0].ref?.endRow).toBe(10);
  });

  it('captureNamesOnly covers define/delete name edits', () => {
    const world = makeNamesWorld();
    const mgr = new UndoManager();
    mgr.setNamesHooks(world.hooks);

    // Define a new name, then undo/redo it.
    mgr.captureNamesOnly('Define name Total');
    world.set([def('Data', 0, 9), def('Total', 10, 10)]);
    expect(world.get()).toHaveLength(2);

    expect(mgr.undo(dummyHost)).toBe(true);
    expect(world.get().map((d) => d.name)).toEqual(['Data']);

    expect(mgr.redo(dummyHost)).toBe(true);
    expect(world.get().map((d) => d.name)).toEqual(['Data', 'Total']);
  });

  it('undo restores a deleted name', () => {
    const world = makeNamesWorld();
    const mgr = new UndoManager();
    mgr.setNamesHooks(world.hooks);

    // Snapshot BEFORE the delete; undo must bring the name back.
    mgr.captureNamesOnly('Delete name Data');
    world.set([]);

    expect(world.get()).toHaveLength(0);
    expect(mgr.undo(dummyHost)).toBe(true);
    const restored = world.get();
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe('Data');
    expect(restored[0].ref?.startRow).toBe(0);
    expect(restored[0].ref?.endRow).toBe(9);
    // Redo re-applies the deletion.
    expect(mgr.redo(dummyHost)).toBe(true);
    expect(world.get()).toHaveLength(0);
  });

  it('entries captured without names leave the store alone', () => {
    const world = makeNamesWorld();
    const mgr = new UndoManager();
    mgr.setNamesHooks(world.hooks);

    mgr.capture(dummyHost, 'Sheet1', [], 'Edit cell'); // no names flag
    world.set([def('Data', 5, 5)]);

    expect(mgr.undo(dummyHost)).toBe(true);
    // The store edit is NOT reverted — this entry never captured names.
    expect(world.get()[0].ref?.startRow).toBe(5);
  });

  it('is a no-op without registered hooks', () => {
    const mgr = new UndoManager();
    mgr.captureNamesOnly('Define name X'); // must not throw
    mgr.capture(dummyHost, 'Sheet1', [], 'Edit', true); // must not throw
    expect(mgr.canUndo()).toBe(true);
    expect(mgr.undo(dummyHost)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #21: format actions are undoable. The app registers format-store
// hooks (snapshot = the immutable store reference); captureFormatsOnly is
// called BEFORE each format mutation, and undo/redo restore the store.
// ---------------------------------------------------------------------------
import { createFormatStore, setFormat, type FormatStore } from './formatting';

function makeFormatsWorld() {
  let store: FormatStore = createFormatStore();
  let restores = 0;
  const hooks = {
    snapshotFormats: (): FormatStore => store,
    restoreFormats: (next: FormatStore): void => {
      store = next;
      restores++;
    },
  };
  return {
    hooks,
    get: () => store,
    applyPercent: (sheet: string, row: number, col: number) => {
      store = setFormat(store, sheet, row, col, { numberFormat: 'Percentage' });
    },
    restoreCount: () => restores,
  };
}

describe('UndoManager format hooks (issue #21)', () => {
  it('undo reverts a format change; redo reapplies it', () => {
    const world = makeFormatsWorld();
    const um = new UndoManager();
    um.setFormatsHooks(world.hooks);
    um.captureFormatsOnly('Format cells');
    world.applyPercent('Sheet1', 1, 1);
    expect(world.get().cells.get('Sheet1:1:1')?.numberFormat).toBe('Percentage');
    expect(um.undo(dummyHost)).toBe(true);
    expect(world.get().cells.get('Sheet1:1:1')).toBeUndefined();
    expect(um.redo(dummyHost)).toBe(true);
    expect(world.get().cells.get('Sheet1:1:1')?.numberFormat).toBe('Percentage');
  });

  it('a format entry undoes before the value entry beneath it (LIFO)', () => {
    const world = makeFormatsWorld();
    const um = new UndoManager();
    um.setFormatsHooks(world.hooks);
    um.capture(dummyHost, 'Sheet1', [{ row: 0, col: 0 }], 'Typing');
    um.captureFormatsOnly('Format cells');
    world.applyPercent('Sheet1', 0, 0);
    expect(um.undoLabel()).toBe('Format cells');
    expect(um.undo(dummyHost)).toBe(true);
    expect(world.get().cells.get('Sheet1:0:0')).toBeUndefined();
    expect(um.undoLabel()).toBe('Typing');
    expect(um.canUndo()).toBe(true);
  });

  it('captureFormatsOnly without hooks is a no-op (manager stays empty)', () => {
    const um = new UndoManager();
    um.captureFormatsOnly('Format cells');
    expect(um.canUndo()).toBe(false);
  });
});
