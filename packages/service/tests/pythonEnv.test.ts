/**
 * Tests for the pinned Python environment manager
 * (packages/service/src/python/env.ts, node-only).
 *
 * Hermetic tests provision a venv with EMPTY requirements (no network).
 * The full pinned-stack test (real pip install of numpy/pandas/matplotlib
 * + a pandas/matplotlib run) is gated on ICECREAM_PROVISION_PYENV=1 so the
 * default suite stays fast and offline-safe.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PINNED_PYTHON_REQUIREMENTS,
  PinnedPythonEnv,
  defaultPythonEnvRoot,
  pythonEnvFingerprint,
  systemPythonVersion,
} from '../src/python/index.js';

const PROVISION_HEAVY = process.env.ICECREAM_PROVISION_PYENV === '1';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'icecream-pyenv-test-'));
}

describe('pythonEnvFingerprint', () => {
  it('is deterministic and content-addressed', () => {
    const a = pythonEnvFingerprint(['numpy==1.26.4'], '3.12.3');
    expect(pythonEnvFingerprint(['numpy==1.26.4'], '3.12.3')).toBe(a);
    // Requirement order does not matter (canonicalized).
    expect(pythonEnvFingerprint(['b==2', 'a==1'], '3.12.3')).toBe(
      pythonEnvFingerprint(['a==1', 'b==2'], '3.12.3'),
    );
    // Content changes the address.
    expect(pythonEnvFingerprint(['numpy==1.26.5'], '3.12.3')).not.toBe(a);
    expect(pythonEnvFingerprint(['numpy==1.26.4'], '3.11.0')).not.toBe(a);
  });
});

describe('PinnedPythonEnv', () => {
  it('exposes the pinned data-science stack', () => {
    expect(PINNED_PYTHON_REQUIREMENTS).toContain('numpy==1.26.4');
    expect(PINNED_PYTHON_REQUIREMENTS).toContain('pandas==2.2.3');
    expect(PINNED_PYTHON_REQUIREMENTS).toContain('matplotlib==3.8.4');
  });

  it('systemPythonVersion parses python3 --version', () => {
    expect(systemPythonVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('envDir is content-addressed (different reqs -> different dirs)', () => {
    const root = tmpRoot();
    try {
      const a = new PinnedPythonEnv(root, ['numpy==1.26.4']);
      const b = new PinnedPythonEnv(root, ['numpy==1.26.5']);
      expect(a.envDir('3.12.3')).not.toBe(b.envDir('3.12.3'));
      expect(a.envDir('3.12.3')).toBe(
        join(root, pythonEnvFingerprint(['numpy==1.26.4'], '3.12.3')),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('run() before provision() is a clear error, never a silent fallback', () => {
    const root = tmpRoot();
    try {
      const env = new PinnedPythonEnv(root, []);
      expect(env.isProvisioned()).toBe(false);
      const r = env.run('result = 1', []);
      expect('error' in r).toBe(true);
      if ('error' in r) expect(r.error).toMatch(/not provisioned/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provisions a venv (empty requirements) and runs stdlib code in it', () => {
    const root = tmpRoot();
    try {
      const env = new PinnedPythonEnv(root, []);
      const marker = env.provision();
      expect(env.isProvisioned()).toBe(true);
      expect(marker.requirements).toEqual([]);
      expect(marker.fingerprint).toBe(env.fingerprint());
      // Provisioning is idempotent.
      expect(env.provision().provisionedAt).toBe(marker.provisionedAt);

      const ok = env.run('import statistics\nresult = statistics.mean([1, 2, 3])', []);
      expect(ok).toEqual({ value: 2 });

      const blocked = env.run('import os\nresult = 1', []);
      expect('error' in blocked).toBe(true);

      // The venv is a real interpreter install: binary + pip exist on disk,
      // and pip freeze runs inside it (empty for the empty-requirements env).
      expect(existsSync(env.venvPython())).toBe(true);
      expect(env.installedPackages()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('defaultPythonEnvRoot honors XDG_CACHE_HOME', () => {
    expect(defaultPythonEnvRoot()).toContain('icecream-sheets');
  });

  it.skipIf(!PROVISION_HEAVY)(
    'provisions the real pinned stack and runs pandas + a matplotlib plot',
    () => {
      const root = tmpRoot();
      try {
        const env = new PinnedPythonEnv(root); // pinned requirements
        const messages: string[] = [];
        const marker = env.provision({ onProgress: (m) => messages.push(m), timeoutMs: 20 * 60_000 });
        expect(env.isProvisioned()).toBe(true);
        expect(marker.requirements).toEqual(PINNED_PYTHON_REQUIREMENTS);
        const frozen = env.installedPackages().join('\n');
        expect(frozen).toMatch(/pandas==2\.2\.3/);
        expect(frozen).toMatch(/numpy==1\.26\.4/);
        expect(frozen).toMatch(/matplotlib==3\.8\.4/);

        const r = env.run(
          [
            'import pandas as pd',
            'import matplotlib',
            "matplotlib.use('Agg')",
            'import matplotlib.pyplot as plt',
            's = pd.Series([1, 2, 3, 4])',
            'plt.plot(s)',
            "plt.title('pinned')",
            'result = float(s.mean())',
          ].join('\n'),
          [],
          { timeoutMs: 60_000 },
        );
        expect('error' in r).toBe(false);
        if (!('error' in r)) {
          expect(r.value).toBe(2.5);
          expect(typeof r.plot).toBe('string');
          expect((r.plot as string).startsWith('iVBORw0KGgo')).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    1_200_000,
  );
});
