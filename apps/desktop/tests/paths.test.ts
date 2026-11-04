/**
 * Regression tests for renderer path resolution.
 *
 * The packaged app once shipped with the web UI inside app.asar while the
 * lookup probed paths WITHOUT the `app.asar` segment — every install showed
 * the "Web UI not built" fallback. These tests pin the asar-aware layout.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { findLaunchFilePath, resolveRendererIndex } from '../src/paths.js';

let scratch: string | null = null;
afterEach(() => {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

function makeTree(indexRel: string): string {
  scratch = mkdtempSync(join(tmpdir(), 'icecream-paths-'));
  const indexAbs = join(scratch, indexRel);
  mkdirSync(join(indexAbs, '..'), { recursive: true });
  writeFileSync(indexAbs, '<html></html>');
  return scratch;
}

describe('resolveRendererIndex', () => {
  it('finds the web UI inside app.asar in a packaged app', () => {
    // Packaged layout: <resources>/app.asar/web/dist/index.html
    const resourcesPath = makeTree(join('app.asar', 'web', 'dist', 'index.html'));
    const found = resolveRendererIndex({
      distDir: join(resourcesPath, 'app.asar', 'dist'),
      resourcesPath,
    });
    expect(found).toBe(join(resourcesPath, 'app.asar', 'web', 'dist', 'index.html'));
  });

  it('returns null when the web build is genuinely missing', () => {
    const resourcesPath = makeTree(join('app.asar', 'dist', 'main.js'));
    const found = resolveRendererIndex({
      distDir: join(resourcesPath, 'app.asar', 'dist'),
      resourcesPath,
    });
    expect(found).toBeNull();
  });

  it('finds the dev workspace layout without a resourcesPath', () => {
    // apps/desktop/dist -> apps/web/dist/index.html
    const root = makeTree(join('apps', 'web', 'dist', 'index.html'));
    const found = resolveRendererIndex({
      distDir: join(root, 'apps', 'desktop', 'dist'),
    });
    expect(found).toBe(join(root, 'apps', 'web', 'dist', 'index.html'));
  });
});

describe('findLaunchFilePath', () => {
  it('finds the workbook in a packaged Windows argv', () => {
    // C:\app\icecream.exe "C:\Users\u\report.xlsx"
    const found = findLaunchFilePath([
      'C:\\app\\icecream.exe',
      'C:\\Users\\u\\report.xlsx',
    ]);
    expect(found).toBe('C:\\Users\\u\\report.xlsx');
  });

  it('skips the project dir in a dev launch (electron . file.xlsx)', () => {
    const found = findLaunchFilePath([
      '/usr/bin/electron',
      '.',
      '/home/u/report.ods',
    ]);
    expect(found).toBe('/home/u/report.ods');
  });

  it('skips flags and takes the first spreadsheet file', () => {
    const found = findLaunchFilePath([
      '/app/icecream',
      '--remote-debugging-port=9222',
      '/tmp/a.csv',
      '/tmp/b.xlsx',
    ]);
    expect(found).toBe('/tmp/a.csv');
  });

  it('matches extensions case-insensitively', () => {
    expect(findLaunchFilePath(['/app/x', '/tmp/R.XLSX'])).toBe('/tmp/R.XLSX');
  });

  it('returns undefined when no workbook path is present', () => {
    expect(findLaunchFilePath(['/app/x'])).toBeUndefined();
    expect(findLaunchFilePath(['/app/x', '.'])).toBeUndefined();
    expect(findLaunchFilePath(['/app/x', '/tmp/notes.txt'])).toBeUndefined();
  });
});
