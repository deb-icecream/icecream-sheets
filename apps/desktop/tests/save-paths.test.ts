/**
 * Unit tests for the save-path hardening helpers
 * (apps/desktop/src/save-paths.ts, GAP-10).
 *
 * The main process must never write to an arbitrary path handed over by
 * the renderer: a `suggestedPath` is honored only inside the directory of
 * the last file the user explicitly picked or saved.
 */
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPathInsideDir,
  resolveSaveTarget,
  trustedDirOf,
} from '../src/save-paths.js';

describe('trustedDirOf', () => {
  it('returns the resolved parent directory of a user-picked file', () => {
    const picked = join('home', 'user', 'docs', 'report.xlsx');
    expect(trustedDirOf(picked)).toBe(resolve('home', 'user', 'docs'));
  });
});

describe('isPathInsideDir', () => {
  const trusted = resolve('home', 'user', 'docs');

  it('accepts a file directly inside the trusted dir', () => {
    expect(isPathInsideDir(join(trusted, 'report.xlsx'), trusted)).toBe(true);
  });

  it('accepts a file in a nested subdirectory', () => {
    expect(
      isPathInsideDir(join(trusted, 'sub', 'report.xlsx'), trusted),
    ).toBe(true);
  });

  it('rejects a sibling directory with a prefix-similar name', () => {
    // "/docs-evil/x.xlsx" must not pass because "/docs" is a prefix.
    const evil = trusted + '-evil';
    expect(isPathInsideDir(join(evil, 'x.xlsx'), trusted)).toBe(false);
  });

  it('rejects ../ traversal out of the trusted dir', () => {
    expect(isPathInsideDir(join(trusted, '..', 'etc', 'passwd'), trusted)).toBe(
      false,
    );
  });

  it('rejects absolute paths elsewhere on disk', () => {
    expect(isPathInsideDir('/tmp/evil.xlsx', trusted)).toBe(false);
  });

  it('rejects everything when there is no trusted dir yet', () => {
    expect(isPathInsideDir(join(trusted, 'report.xlsx'), null)).toBe(false);
  });
});

describe('resolveSaveTarget', () => {
  const trusted = resolve('home', 'user', 'docs');

  it('writes directly for a suggested path inside the trusted dir', () => {
    const inside = join(trusted, 'report.xlsx');
    expect(resolveSaveTarget(inside, trusted)).toEqual({
      mode: 'direct',
      path: inside,
    });
  });

  it('falls back to the dialog when the suggested path escapes the trusted dir', () => {
    expect(resolveSaveTarget('/tmp/evil.xlsx', trusted)).toEqual({
      mode: 'dialog',
    });
  });

  it('falls back to the dialog when there is no trusted dir yet', () => {
    expect(resolveSaveTarget(join(trusted, 'report.xlsx'), null)).toEqual({
      mode: 'dialog',
    });
  });

  it('falls back to the dialog when no suggested path is given (Save As)', () => {
    expect(resolveSaveTarget(undefined, trusted)).toEqual({ mode: 'dialog' });
  });
});
