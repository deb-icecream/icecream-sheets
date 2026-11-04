import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPython, setPinnedEnvForTests, getPythonSandboxCache } from '../src/sandbox/python.js';
import {
  PinnedPythonEnv,
  pythonCacheKey,
} from '@icecream-sheets/service/python-env';

/** The stdlib-only prelude contract is unchanged; run hermetically on the system interpreter. */
const SYS = { pinned: false } as const;

describe('runPython', () => {
  it('uses the math allowlist', () => {
    expect(runPython('import math\nresult = math.floor(args["x"])', { x: 2.9 }, SYS)).toEqual({
      value: 2,
    });
  });

  it('supports statistics and itertools from the allowlist', () => {
    const result = runPython(
      'import statistics, itertools\nresult = statistics.mean([1, 2, 3]) + sum(itertools.islice(range(10), 2))',
      {},
      SYS,
    );
    expect(result).toEqual({ value: 3 });
  });

  it('blocks import os', () => {
    const result = runPython('import os\nresult = 1', {}, SYS);
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toMatch(/not allowed/);
    }
  });

  it('blocks import subprocess and socket', () => {
    expect(runPython('import subprocess\nresult = 1', {}, SYS)).toHaveProperty('error');
    expect(runPython('import socket\nresult = 1', {}, SYS)).toHaveProperty('error');
  });

  it('blocks __import__ smuggling of os', () => {
    const result = runPython('m = __import__("os")\nresult = 1', {}, SYS);
    expect(result).toHaveProperty('error');
  });

  it('makes open() unavailable', () => {
    const result = runPython('result = open("/etc/hostname").read()', {}, SYS);
    expect(result).toHaveProperty('error');
  });

  it('times out on an infinite loop', () => {
    const result = runPython('while True:\n    pass', {}, { ...SYS, timeoutMs: 500 });
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toMatch(/timed out/i);
    }
  }, 10000);

  it('requires the program to assign result', () => {
    const result = runPython('x = 1 + 1', {}, SYS);
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toMatch(/result/);
    }
  });

  it('rejects non-JSON-serializable results', () => {
    const result = runPython('result = object()', {}, SYS);
    expect(result).toHaveProperty('error');
  });

  it('blocks pandas on the stdlib-only system interpreter', () => {
    const result = runPython('import pandas\nresult = 1', {}, SYS);
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toMatch(/not allowed/);
    }
  });
});

// ---------------------------------------------------------------------------
// Pinned environment: hermetic venv with EMPTY requirements (no network).
// ---------------------------------------------------------------------------

const PROVISION_HEAVY = process.env.ICECREAM_PROVISION_PYENV === '1';

function provisionEmptyEnv(): { env: PinnedPythonEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'icecream-py-sandbox-test-'));
  const env = new PinnedPythonEnv(root, []);
  env.provision();
  setPinnedEnvForTests(env);
  return { env, root };
}

describe('runPython pinned environment', () => {
  let root = '';
  afterEach(() => {
    setPinnedEnvForTests(null);
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('runs in the venv interpreter with the extended allowlist', () => {
    ({ root } = provisionEmptyEnv());
    // io/base64 are importable under the pinned prelude (engine PY() contract).
    const r = runPython('import io, base64\nresult = base64.b64encode(io.BytesIO(b"ab").read()).decode()', {});
    expect(r).toEqual({ value: 'YWI=' });
  });

  it('lets pandas past the import hook (then fails honestly: not installed in the empty venv)', () => {
    ({ root } = provisionEmptyEnv());
    const r = runPython('import pandas\nresult = 1', {});
    expect(r).toHaveProperty('error');
    if ('error' in r) {
      // The allowlist permits pandas now; the empty venv genuinely lacks it.
      expect(r.error).toMatch(/No module named .*pandas/);
    }
  });

  it('still blocks os under the pinned prelude', () => {
    ({ root } = provisionEmptyEnv());
    expect(runPython('import os\nresult = 1', {})).toHaveProperty('error');
  });

  it('caches successful results under the content-addressed key', () => {
    const { env } = provisionEmptyEnv();
    root = env.rootDir;
    const code = 'result = 40 + 2';
    const first = runPython(code, {});
    expect(first).toEqual({ value: 42 });
    const key = pythonCacheKey(env.fingerprint(), code, '{}');
    const entry = getPythonSandboxCache().get(key);
    expect(entry?.value).toBe(42);
    expect(entry?.envFingerprint).toBe(env.fingerprint());
    // A repeat call is served from the cache with the identical value.
    expect(runPython(code, {})).toEqual({ value: 42 });
  });

  it('does not cache when cache:false', () => {
    const { env } = provisionEmptyEnv();
    root = env.rootDir;
    const code = 'result = "nocache-" + args["s"]';
    runPython(code, { s: 'x' }, { cache: false });
    const key = pythonCacheKey(env.fingerprint(), code, '{"s":"x"}');
    expect(getPythonSandboxCache().get(key)).toBeUndefined();
  });

  it('never caches errors', () => {
    const { env } = provisionEmptyEnv();
    root = env.rootDir;
    const code = 'raise ValueError("boom")';
    const r = runPython(code, {});
    expect(r).toHaveProperty('error');
    const key = pythonCacheKey(env.fingerprint(), code, '{}');
    expect(getPythonSandboxCache().get(key)).toBeUndefined();
  });

  it.skipIf(!PROVISION_HEAVY)(
    'runs pandas from the real pinned stack',
    () => {
      // Uses the default (persistent, content-addressed) root: provisioning
      // is idempotent, so an already-provisioned env is reused as-is.
      const env = new PinnedPythonEnv(); // pinned requirements
      env.provision({ timeoutMs: 20 * 60_000 });
      setPinnedEnvForTests(env);
      try {
        const r = runPython(
          'import pandas as pd\nimport numpy as np\nresult = int(pd.Series([1, 2, 3]).sum() + np.int64(1))',
          {},
          { timeoutMs: 60_000 },
        );
        expect(r).toEqual({ value: 7 });
      } finally {
        setPinnedEnvForTests(null);
      }
    },
    25 * 60_000,
  );
});
