/**
 * Shipped-runner configuration (src/bin/runner-config.ts): the bin must
 * enforce auth and wire durable persistence, failing closed on any
 * misconfiguration BEFORE listening.
 *
 * Durable-store migration: resolveRunnerConfig is async; MCP_STORE=prod
 * builds a Firestore-backed AsyncPersistence (fail-closed when the
 * project ID is missing or the client package is absent).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFilePersistence,
  createProdPersistence,
  prodMcpConfig,
  resolveRunnerConfig,
} from '../src/bin/runner-config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-runner-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRunnerConfig — auth (always enforced)', () => {
  it('throws when MCP_AUTH_SECRET is missing', async () => {
    await expect(resolveRunnerConfig({ MCP_DATA_DIR: tempDir() })).rejects.toThrow(
      /MCP_AUTH_SECRET is not set/,
    );
  });

  it('throws when MCP_AUTH_SECRET is empty', async () => {
    await expect(
      resolveRunnerConfig({ MCP_AUTH_SECRET: '', MCP_DATA_DIR: tempDir() }),
    ).rejects.toThrow(/MCP_AUTH_SECRET is not set/);
  });

  it('throws when MCP_AUTH_SECRET is whitespace only', async () => {
    await expect(
      resolveRunnerConfig({ MCP_AUTH_SECRET: '   \t  ', MCP_DATA_DIR: tempDir() }),
    ).rejects.toThrow(/MCP_AUTH_SECRET is not set/);
  });

  it('with a valid secret: requireAuth is true and the secret is passed through', async () => {
    const config = await resolveRunnerConfig({
      MCP_AUTH_SECRET: 'test-secret-value',
      MCP_DATA_DIR: tempDir(),
    });
    expect(config.requireAuth).toBe(true);
    expect(config.authSecret).toBe('test-secret-value');
  });
});

describe('resolveRunnerConfig — persistence selection (MCP_STORE)', () => {
  it('MCP_STORE unset → local store, and persistence survives a fresh factory instance (restart property)', async () => {
    const dir = tempDir();
    const env = { MCP_AUTH_SECRET: 'test-secret-value', MCP_DATA_DIR: dir };

    const first = await resolveRunnerConfig(env);
    expect(first.store).toBe('local');
    expect(first.dataDir).toBe(dir);
    expect(first.asyncPersistence).toBeUndefined();
    first.persistence!.save('icecream-sheets.mcp.agent-memory.v1', '{"user":{"k":1}}');

    // A fresh resolve over the same directory = a restarted process:
    // what the first instance saved must load through the new instance.
    const second = await resolveRunnerConfig(env);
    expect(second.persistence).not.toBe(first.persistence);
    expect(second.persistence!.load('icecream-sheets.mcp.agent-memory.v1')).toBe(
      '{"user":{"k":1}}',
    );
  });

  it("MCP_STORE='local' → local store", async () => {
    const config = await resolveRunnerConfig({
      MCP_AUTH_SECRET: 'test-secret-value',
      MCP_STORE: 'local',
      MCP_DATA_DIR: tempDir(),
    });
    expect(config.store).toBe('local');
    expect(config.asyncPersistence).toBeUndefined();
  });

  it("MCP_STORE='prod' without GCP_PROJECT_ID throws fail-closed", async () => {
    await expect(
      resolveRunnerConfig({
        MCP_AUTH_SECRET: 'test-secret-value',
        MCP_STORE: 'prod',
        MCP_DATA_DIR: tempDir(),
      }),
    ).rejects.toThrow(/GCP_PROJECT_ID/);
  });

  it("MCP_STORE=prod without the Firestore package installed throws fail-closed (not silently local)", async () => {
    // In this repo the package is a declared dependency but not installed
    // (package-lock-only); the dynamic import must fail closed, never
    // fall back to local storage.
    await expect(
      createProdPersistence({
        MCP_AUTH_SECRET: 'x',
        MCP_STORE: 'prod',
        GCP_PROJECT_ID: 'dreamscapes-zero',
      }),
    ).rejects.toThrow(/@google-cloud\/firestore.*not installed/);
  });

  it('an unknown MCP_STORE value throws, naming the bad value', async () => {
    await expect(
      resolveRunnerConfig({
        MCP_AUTH_SECRET: 'test-secret-value',
        MCP_STORE: 'bogus',
        MCP_DATA_DIR: tempDir(),
      }),
    ).rejects.toThrow(/bogus/);
  });

  it('data dir falls back to $ICECREAM_DATA_DIR/mcp when MCP_DATA_DIR is unset', async () => {
    const base = tempDir();
    const config = await resolveRunnerConfig({
      MCP_AUTH_SECRET: 'test-secret-value',
      ICECREAM_DATA_DIR: base,
    });
    expect(config.dataDir).toBe(join(base, 'mcp'));
  });
});

describe('prodMcpConfig', () => {
  it('requires GCP_PROJECT_ID', () => {
    expect(() => prodMcpConfig({})).toThrow(/GCP_PROJECT_ID/);
    expect(prodMcpConfig({ GCP_PROJECT_ID: 'dreamscapes-zero' })).toEqual({
      projectId: 'dreamscapes-zero',
      databaseId: undefined,
    });
  });

  it('passes through FIRESTORE_DATABASE_ID when set', () => {
    expect(
      prodMcpConfig({ GCP_PROJECT_ID: 'p', FIRESTORE_DATABASE_ID: 'mydb' }),
    ).toEqual({ projectId: 'p', databaseId: 'mydb' });
  });
});

describe('createFilePersistence — file-backed Persistence factory', () => {
  it('round-trips across two factory instances over a temp dir (the restart property)', () => {
    const dir = tempDir();
    const one = createFilePersistence(dir);
    expect(one.load('never-saved-key')).toBeNull();
    one.save('some.key', 'saved-value');

    const two = createFilePersistence(dir);
    expect(two.load('some.key')).toBe('saved-value');

    two.clear('some.key');
    const three = createFilePersistence(dir);
    expect(three.load('some.key')).toBeNull();
  });

  it('distinct keys never collide, even when they sanitize alike', () => {
    const dir = tempDir();
    const p = createFilePersistence(dir);
    p.save('a/b', 'first');
    p.save('a_b', 'second');
    const fresh = createFilePersistence(dir);
    expect(fresh.load('a/b')).toBe('first');
    expect(fresh.load('a_b')).toBe('second');
  });
});
