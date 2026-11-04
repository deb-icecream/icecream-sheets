/**
 * Agent thread persistence through the deployed constructor path
 * (Cycle-3 GAP-4, design-docs/ai-agent.md §9).
 *
 * packages/gateway/src/services/agentSvc.ts now passes a file-backed
 * threadPersistence into every AgentRuntime. This test proves the round
 * trip: POST /message through createAgentListener() → "restart" (fresh
 * module state, same data dir) → the new service instance loads the
 * persisted thread and appends to it instead of starting fresh.
 *
 * Module state is reset with vi.resetModules() + dynamic import to simulate
 * a process restart: the runtimes map and the persistence cache are
 * module-level, exactly what a restart would drop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATEWAY_DATA_DIR_ENV } from '../src/filePersistence.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
const BOB = { 'x-principal': 'user:bob' };

let dir: string;
let savedEnv: string | undefined;
let svc: Started | null = null;

beforeEach(() => {
  vi.resetModules();
  savedEnv = process.env[GATEWAY_DATA_DIR_ENV];
  dir = mkdtempSync(join(tmpdir(), 'agent-threads-'));
  process.env[GATEWAY_DATA_DIR_ENV] = dir;
});

afterEach(async () => {
  if (svc) await stop(svc);
  svc = null;
  if (savedEnv === undefined) delete process.env[GATEWAY_DATA_DIR_ENV];
  else process.env[GATEWAY_DATA_DIR_ENV] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** Fresh createAgentListener (simulates a process restart). */
async function boot() {
  const { createAgentListener } = await import('../src/services/agentSvc.js');
  svc = await startServer(createAgentListener());
  return svc;
}

async function postMessage(threadId: string, text: string, headers: Record<string, string> = ALICE) {
  const r = await httpJson('POST', `${svc!.url}/message`, { headers, body: { threadId, text } });
  expect(r.status).toBe(200);
  return r.json as { threadId: string; message: string };
}

/** Read the persisted thread record for `threadId` from the data dir. */
function readPersistedThread(threadId: string): { messages: { role: string; text: string }[] } {
  for (const f of readdirSync(dir)) {
    const raw = readFileSync(join(dir, f), 'utf8');
    if (!raw.includes(threadId)) continue;
    const doc = JSON.parse(raw) as { threads?: { threadId: string; messages: unknown[] }[] };
    const thread = doc.threads?.find((t) => t.threadId === threadId);
    if (thread) return thread as { messages: { role: string; text: string }[] };
  }
  throw new Error(`no persisted thread ${threadId} in ${dir}`);
}

describe('agent thread persistence (deployed path)', () => {
  it('threads survive a service restart and keep appending', async () => {
    // Boot 1: chat on a fixed thread id. 'recalculate now' completes
    // without a human-in-the-loop pause.
    await boot();
    const reply1 = await postMessage('t-restart', 'recalculate now');
    expect(reply1.threadId).toBe('t-restart');
    expect(reply1.message.length).toBeGreaterThan(0);

    // The thread is on disk (write-through), not just in memory.
    const before = readPersistedThread('t-restart');
    expect(before.messages.length).toBeGreaterThan(0);
    expect(before.messages[0]).toMatchObject({ role: 'user', text: 'recalculate now' });

    // "Restart": drop all module state, boot fresh over the same data dir.
    await stop(svc!);
    svc = null;
    vi.resetModules();
    await boot();

    // The new instance continues the persisted thread: messages append to
    // the stored history instead of starting a fresh thread.
    const reply2 = await postMessage('t-restart', 'recalculate now');
    expect(reply2.threadId).toBe('t-restart');
    const after = readPersistedThread('t-restart');
    expect(after.messages.length).toBeGreaterThan(before.messages.length);
    // The pre-restart turn is still there, first.
    expect(after.messages[0]).toMatchObject({ role: 'user', text: 'recalculate now' });
    expect(after.messages.filter((m) => m.role === 'user' && m.text === 'recalculate now').length).toBe(2);
  });

  it('threads are namespaced per principal on disk', async () => {
    await boot();
    await postMessage('t-alice', 'recalculate now', ALICE);
    await postMessage('t-bob', 'recalculate now', BOB);

    const files = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'));
    expect(files.length).toBeGreaterThan(0);
    const aliceFile = files.find((c) => c.includes('t-alice'));
    const bobFile = files.find((c) => c.includes('t-bob'));
    expect(aliceFile).toBeTruthy();
    expect(bobFile).toBeTruthy();
    // No cross-principal leakage: alice's file has no bob thread and vice versa.
    expect(aliceFile!).not.toContain('t-bob');
    expect(bobFile!).not.toContain('t-alice');
  });
});
