import { describe, expect, it } from 'vitest';
import {
  addEditRange,
  clearSessionUnlocks,
  createEditRange,
  hashRangePassword,
  isRangeUnlockedForSession,
  loadEditRanges,
  removeEditRange,
  unlockRangeForSession,
  verifyEditRangePassword,
} from './editRanges';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('editRanges', () => {
  it('hashes deterministically with salt', () => {
    expect(hashRangePassword('pw', 'salt')).toBe(hashRangePassword('pw', 'salt'));
    expect(hashRangePassword('pw', 'salt')).not.toBe(hashRangePassword('pw', 'other'));
  });
  it('creates an entry with hashed password', () => {
    const e = createEditRange('Sheet1', 'B2:D10', 'Inputs', 'secret');
    expect(e.passwordHash).not.toContain('secret');
    expect(verifyEditRangePassword(e, 'secret')).toBe(true);
    expect(verifyEditRangePassword(e, 'wrong')).toBe(false);
  });
  it('rejects blank range or password', () => {
    expect(() => createEditRange('S', '', 't', 'pw')).toThrow();
    expect(() => createEditRange('S', 'A1', 't', '')).toThrow();
  });
  it('persists add/remove', () => {
    const s = memStore();
    const e = createEditRange('Sheet1', 'A1', 't', 'pw');
    addEditRange(e, s);
    expect(loadEditRanges(s).length).toBe(1);
    removeEditRange(e.id, s);
    expect(loadEditRanges(s)).toEqual([]);
  });
  it('tracks session unlocks in memory only', () => {
    clearSessionUnlocks();
    expect(isRangeUnlockedForSession('x')).toBe(false);
    unlockRangeForSession('x');
    expect(isRangeUnlockedForSession('x')).toBe(true);
    clearSessionUnlocks();
    expect(isRangeUnlockedForSession('x')).toBe(false);
  });
});
