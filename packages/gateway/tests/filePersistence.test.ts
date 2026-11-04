/**
 * filePersistence unit tests (Cycle-3 GAP-4): the file-backed Persistence
 * adapter behind the agent service's threadPersistence (ai-agent.md §9).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filePersistence,
  gatewayDataDir,
  persistenceFileFor,
  GATEWAY_DATA_DIR_ENV,
} from '../src/filePersistence.js';

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[GATEWAY_DATA_DIR_ENV];
  dir = mkdtempSync(join(tmpdir(), 'file-persistence-'));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[GATEWAY_DATA_DIR_ENV];
  else process.env[GATEWAY_DATA_DIR_ENV] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('filePersistence', () => {
  it('save → load round-trip', () => {
    const p = filePersistence(dir);
    expect(p.load('k1')).toBeNull();
    p.save('k1', '{"a":1}');
    expect(p.load('k1')).toBe('{"a":1}');
  });

  it('clear removes the key', () => {
    const p = filePersistence(dir);
    p.save('k1', 'v');
    p.clear('k1');
    expect(p.load('k1')).toBeNull();
    expect(p.load('missing')).toBeNull();
    p.clear('missing'); // no throw
  });

  it('data survives a fresh adapter over the same directory', () => {
    filePersistence(dir).save('icecream-sheets.agent-threads.v1.user:alice', '{"threads":[]}');
    const p2 = filePersistence(dir);
    expect(p2.load('icecream-sheets.agent-threads.v1.user:alice')).toBe('{"threads":[]}');
  });

  it('sanitizes hostile keys and never collides', () => {
    const p = filePersistence(dir);
    const k1 = 'icecream-sheets.agent-threads.v1.user:alice';
    const k2 = 'icecream-sheets.agent-threads.v1.user/alice';
    const k3 = 'icecream-sheets.agent-threads.v1.user:alice ';
    p.save(k1, 'one');
    p.save(k2, 'two');
    p.save(k3, 'three');
    expect(p.load(k1)).toBe('one');
    expect(p.load(k2)).toBe('two');
    expect(p.load(k3)).toBe('three');
    const f1 = persistenceFileFor(dir, k1);
    const f2 = persistenceFileFor(dir, k2);
    const f3 = persistenceFileFor(dir, k3);
    expect(new Set([f1, f2, f3]).size).toBe(3);
    // No path traversal: everything stays inside dir.
    for (const f of [f1, f2, f3]) {
      expect(f.startsWith(dir)).toBe(true);
      expect(f).not.toContain('..');
    }
  });

  it('writes atomically (no stray temp files)', () => {
    const p = filePersistence(dir);
    p.save('k', 'v');
    expect(readdirSync(dir).every((f) => !f.endsWith('.tmp'))).toBe(true);
  });
});

describe('gatewayDataDir', () => {
  it('honors $ICECREAM_DATA_DIR and creates it', () => {
    const custom = join(dir, 'custom-data');
    process.env[GATEWAY_DATA_DIR_ENV] = custom;
    expect(gatewayDataDir()).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });

  it('defaults under the home directory', () => {
    delete process.env[GATEWAY_DATA_DIR_ENV];
    const d = gatewayDataDir();
    expect(d).toContain('.icecream-sheets');
    expect(existsSync(d)).toBe(true);
  });
});
