import { describe, expect, it } from 'vitest';
import {
  applyRelativeRefs,
  deleteMacro,
  getUseRelativeReferences,
  isRelativeRef,
  loadMacros,
  renameMacro,
  resolveRelativeRef,
  saveMacro,
  setUseRelativeReferences,
  RELATIVE_SHEET_MARKER,
} from './macros';
import { createActionLog } from '@icecream-sheets/service';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

function sampleLog() {
  const log = createActionLog('Test');
  log.actions.push({ kind: 'setCell', ref: { sheet: 'Sheet1', row: 5, col: 3 }, value: 'x' });
  return log;
}

describe('macro library', () => {
  it('saves, renames, deletes', () => {
    const s = memStore();
    const log = sampleLog();
    let macros = saveMacro({ name: 'M1', script: '// s', log, relativeRefs: false }, s);
    expect(macros.length).toBe(1);
    const id = macros[0].id;
    macros = renameMacro(id, 'Renamed', s);
    expect(macros[0].name).toBe('Renamed');
    macros = deleteMacro(id, s);
    expect(macros).toEqual([]);
    expect(loadMacros(s)).toEqual([]);
  });
  it('upserts by id when editing', () => {
    const s = memStore();
    const log = sampleLog();
    const [first] = saveMacro({ name: 'M1', script: 'a', log, relativeRefs: false }, s);
    const macros = saveMacro({ id: first.id, name: 'M1b', script: 'b', log, relativeRefs: true }, s);
    expect(macros.length).toBe(1);
    expect(macros[0].script).toBe('b');
    expect(macros[0].relativeRefs).toBe(true);
  });
});

describe('useRelativeReferences toggle', () => {
  it('persists the toggle', () => {
    const s = memStore();
    expect(getUseRelativeReferences(s)).toBe(false);
    setUseRelativeReferences(true, s);
    expect(getUseRelativeReferences(s)).toBe(true);
  });
});

describe('applyRelativeRefs', () => {
  it('rewrites refs as offsets from the anchor', () => {
    const out = applyRelativeRefs(sampleLog(), { sheet: 'Sheet1', row: 5, col: 3 });
    const ref = (out.actions[0] as { ref: { sheet: string; row: number; col: number } }).ref;
    expect(ref.sheet).toBe(RELATIVE_SHEET_MARKER);
    expect(ref.row).toBe(0);
    expect(ref.col).toBe(0);
    expect(isRelativeRef(ref)).toBe(true);
  });
  it('resolves against the run-time anchor', () => {
    const ref = { sheet: RELATIVE_SHEET_MARKER, row: 2, col: -1 };
    expect(resolveRelativeRef(ref, { sheet: 'S', row: 10, col: 10 })).toEqual({ sheet: 'S', row: 12, col: 9 });
  });
  it('leaves absolute refs alone', () => {
    const ref = { sheet: 'S', row: 1, col: 1 };
    expect(resolveRelativeRef(ref, { sheet: 'X', row: 9, col: 9 })).toBe(ref);
  });
});
