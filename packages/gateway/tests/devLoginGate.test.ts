/**
 * F-1 + F-16 regression tests (security pass, 2026-10-22).
 *
 * F-1 (Critical): POST /auth/login mints a gateway JWT for ANY
 * caller-named userId with NO credential check — full impersonation if
 * served in production. It must be served ONLY on explicit opt-in
 * (GatewayOptions.devLoginEnabled; the shipped bin wires
 * ALLOW_DEV_LOGIN==='1', default OFF). Default → 404.
 *
 * F-16 (High): the shipped gateway bin must FAIL CLOSED (exit 1) when
 * AUTH_SECRET is unset — the publicly known 'local-dev-secret' fallback
 * must not exist in any wiring (bin, createGateway callers, or
 * startAllLocal).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyToken } from '@icecream-sheets/service';
import { createGateway, type GatewayListener } from '../src/gateway.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'dev-login-gate-test-secret';
const RL = { points: 1000, perSeconds: 60 };

describe('F-1: /auth/login gate (createGateway)', () => {
  let gateway: Started | null = null;
  let listener: GatewayListener | null = null;

  afterEach(async () => {
    if (gateway) await stop(gateway);
    gateway = null;
    listener = null;
  });

  it('answers 404 by default (no devLoginEnabled opt-in)', async () => {
    listener = createGateway({ authSecret: SECRET, routes: {}, rateLimit: RL });
    gateway = await startServer(listener);
    const r = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'victim' } });
    expect(r.status).toBe(404);
    expect((r.json as { error?: string }).error).toBe('not found: /auth/login');
  });

  it('answers 404 with devLoginEnabled explicitly false', async () => {
    listener = createGateway({ authSecret: SECRET, routes: {}, rateLimit: RL, devLoginEnabled: false });
    gateway = await startServer(listener);
    const r = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'victim' } });
    expect(r.status).toBe(404);
  });

  it('mints a verifiable JWT when explicitly enabled (local posture)', async () => {
    listener = createGateway({ authSecret: SECRET, routes: {}, rateLimit: RL, devLoginEnabled: true });
    gateway = await startServer(listener);
    const r = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'alice' } });
    expect(r.status).toBe(200);
    const token = (r.json as { token: string }).token;
    expect(typeof token).toBe('string');
    const claims = await verifyToken(token, SECRET);
    expect(claims.userId).toBe('alice');
    const me = await httpJson('GET', `${gateway.url}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Bin-level: the SHIPPED artifact (dist/bin/gateway.js) — the exact
// process the Dockerfile runs. Build-if-stale so the tests always prove
// the current source's bin.
// ---------------------------------------------------------------------------

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PKG_DIR, 'dist', 'bin', 'gateway.js');

function ensureBinBuilt(): void {
  const srcFiles = ['src/bin/gateway.ts', 'src/gateway.ts', 'src/index.ts'].map((f) =>
    path.join(PKG_DIR, f),
  );
  const newestSrc = Math.max(...srcFiles.map((f) => statSync(f).mtimeMs));
  if (existsSync(BIN) && statSync(BIN).mtimeMs >= newestSrc) return;
  execSync('npm run build', { cwd: PKG_DIR, stdio: 'pipe', timeout: 300_000 });
  if (!existsSync(BIN)) throw new Error('gateway build did not produce dist/bin/gateway.js');
}

interface BinRun {
  child: ChildProcess;
  output: () => string;
}

function startBin(env: Record<string, string>): BinRun {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'AUTH_SECRET' || k === 'ALLOW_DEV_LOGIN') continue;
    base[k] = v;
  }
  const child = spawn(process.execPath, [BIN], {
    cwd: PKG_DIR,
    env: { ...base, HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  return { child, output: () => out };
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return await Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe('F-16 + F-1: shipped gateway bin posture', () => {
  let run: BinRun | null = null;

  afterEach(() => {
    run?.child.kill('SIGKILL');
    run = null;
  });

  it(
    'F-16: exits 1 when AUTH_SECRET is unset (fail closed, no default secret)',
    { timeout: 330_000 },
    async () => {
      ensureBinBuilt();
      run = startBin({ PORT: '18931' });
      const code = await waitForExit(run.child, 30_000);
      expect(code).toBe(1);
      expect(run.output()).toContain('AUTH_SECRET is not set');
    },
  );

  it(
    'F-1: with AUTH_SECRET set but ALLOW_DEV_LOGIN unset, /auth/login is 404',
    { timeout: 330_000 },
    async () => {
      ensureBinBuilt();
      run = startBin({ PORT: '18932', AUTH_SECRET: 'bin-gate-test-secret' });
      expect(await waitForHealth(18932, 60_000)).toBe(true);
      const r = await httpJson('POST', 'http://127.0.0.1:18932/auth/login', {
        body: { userId: 'victim' },
      });
      expect(r.status).toBe(404);
    },
  );

  it(
    'F-1: ALLOW_DEV_LOGIN=1 explicitly enables /auth/login in the bin (local posture)',
    { timeout: 330_000 },
    async () => {
      ensureBinBuilt();
      run = startBin({ PORT: '18933', AUTH_SECRET: 'bin-gate-test-secret', ALLOW_DEV_LOGIN: '1' });
      expect(await waitForHealth(18933, 60_000)).toBe(true);
      expect(run.output()).toContain('ALLOW_DEV_LOGIN=1');
      const r = await httpJson('POST', 'http://127.0.0.1:18933/auth/login', {
        body: { userId: 'bin-user' },
      });
      expect(r.status).toBe(200);
      const token = (r.json as { token: string }).token;
      const claims = await verifyToken(token, 'bin-gate-test-secret');
      expect(claims.userId).toBe('bin-user');
    },
  );
});
