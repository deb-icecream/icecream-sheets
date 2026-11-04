/**
 * Drift tests for the versioned function registry (design-docs/platform-shell.md §5).
 *
 * - The registry is generated from the actual HyperFormula plugin
 *   registrations (built-ins + every engine plugin batch), never from a
 *   hand-maintained name list.
 * - Every curated-metadata key (category/signature/description) refers to an
 *   actually-registered function — stale curation fails here.
 * - The checked-in apps/web/src/features/functionList.ts is byte-identical
 *   to fresh generator output — regenerate with
 *   `node scripts/gen-function-list.mjs` (from packages/engine) instead of
 *   hand-editing.
 *
 * The generator runs against packages/engine/dist, so `npm run build` must
 * precede `npm test` (the dist-freshness test below enforces this).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HyperFormula } from 'hyperformula';
import {
  FUNCTION_REGISTRY_VERSION,
  getFunctionRegistry,
  getRegistryMetadataKeys,
  getRegistryPluginVersions,
} from '../src/function-registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(pkgDir, '..', '..');
const checkedIn = resolve(repoRoot, 'apps/web/src/features/functionList.ts');
const generator = resolve(pkgDir, 'scripts/gen-function-list.mjs');
const distRegistry = resolve(pkgDir, 'dist/function-registry.js');
const srcRegistry = resolve(pkgDir, 'src/function-registry.ts');

describe('function registry (platform-shell §5)', () => {
  it('dist is fresh (rebuild before testing)', () => {
    expect(existsSync(distRegistry), 'dist/function-registry.js missing — run npm run build first').toBe(true);
    const srcTime = statSync(srcRegistry).mtimeMs;
    const distTime = statSync(distRegistry).mtimeMs;
    expect(
      distTime >= srcTime,
      'dist/function-registry.js is older than src — run npm run build first',
    ).toBe(true);
  });

  it('enumerates the actual plugin registrations', () => {
    const entries = getFunctionRegistry();
    expect(entries.length).toBeGreaterThan(500);
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort()); // sorted by name
    expect(new Set(names).size).toBe(names.length); // unique
    for (const e of entries) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(e.version) && e.version >= 1).toBe(true);
      expect(e.category.length).toBeGreaterThan(0);
      expect(e.signature.startsWith(`${e.name}(`)).toBe(true);
      expect(typeof e.description).toBe('string');
      // Internal functions are excluded by rule, not by list.
      expect(e.name.startsWith('ICE')).toBe(false);
      expect(e.name).not.toBe('VERSION');
    }
    // Spot-check: built-ins, engine batches, aliases, HF.* operators.
    for (const n of [
      'SUM',
      'XLOOKUP',
      'FORECAST.ETS',
      'CUBEVALUE',
      'STOCKHISTORY',
      'CONCAT',
      'IMPORTDATA',
      'HF.ADD',
      'OFFSET',
      'GROUPBY',
      'PIVOTBY',
      'ODDFPRICE',
    ]) {
      expect(names, `expected registered function '${n}'`).toContain(n);
    }
  });

  it('curated metadata keys all refer to registered functions', () => {
    const registered = new Set(getFunctionRegistry().map((e) => e.name));
    const keys = getRegistryMetadataKeys();
    for (const [table, ks] of Object.entries(keys) as Array<[string, string[]]>) {
      expect(ks.length).toBeGreaterThan(0);
      for (const k of ks) {
        expect(registered.has(k), `${table} key '${k}' is not a registered function`).toBe(true);
      }
    }
  });

  it('registry version is a positive integer', () => {
    expect(Number.isInteger(FUNCTION_REGISTRY_VERSION) && FUNCTION_REGISTRY_VERSION >= 1).toBe(true);
  });

  it('every versioned plugin class is actually registered (no stale version entries)', () => {
    const hf = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' });
    const live = new Set<string>();
    for (const n of hf.getRegisteredFunctionNames()) {
      try {
        const plugin = hf.getFunctionPlugin(n);
        if (plugin) live.add(plugin.name);
      } catch {
        // VERSION and other meta-functions have no plugin class.
      }
    }
    for (const { className, version } of getRegistryPluginVersions()) {
      expect(live.has(className), `versioned plugin class '${className}' is not registered`).toBe(true);
      expect(Number.isInteger(version) && version >= 1).toBe(true);
    }
  });

  it('checked-in functionList.ts matches fresh generator output (no drift)', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'fn-list-'));
    const out = resolve(tmp, 'functionList.ts');
    try {
      execFileSync(process.execPath, [generator, '--out', out], { cwd: pkgDir });
    } catch (e) {
      throw new Error(
        `gen-function-list.mjs failed (run 'npm run build' in packages/engine first): ${(e as Error).message}`,
      );
    }
    const fresh = readFileSync(out, 'utf8');
    const disk = readFileSync(checkedIn, 'utf8');
    expect(fresh).toBe(disk);
    expect(disk).toContain(
      `export const FUNCTION_LIST_VERSION = ${FUNCTION_REGISTRY_VERSION} as const;`,
    );
  });
});
