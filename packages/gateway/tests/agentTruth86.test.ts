// Agent truthfulness, issue #86: a no-access agent must NEVER report
// write success while writing to its own fallback workbook.
//
// Before the fix, a legacy chat turn with no bound session (no live
// session, no grant — the exact #51 agent-door scenario) ran on a
// plain EngineHost: its writes SUCCEEDED on its private scratch
// workbook and the reply said 'Done.', while the user believed the
// named file had changed. After the fix, unbound chat runtimes run
// on UnboundChatEngineHost: every user-data mutation is refused with
// a plain-language error, the reply composes the failure (never
// 'Done.'), and the scratch workbook is never mutated.
//
// What this file pins (matrix):
// - no-access chat write -> refused, no success message, no mutation
// - no-access chat formula -> refused the same way
// - recalculate on an unbound chat runtime still succeeds (compute,
//   not user data — the pinned fallback-continuity boundary)
// - the bridge keeps its writable private host when unbound (app data
//   lives there by design; the artifact seed test pins generate)
// - a bound editor chat write still lands on the engine session
//   (the #86 cache-key change must not regress the bound path)
// The viewer leg (bound viewer write refused by the remote readOnly
// gate) is covered by the existing viewer suites and run alongside.

import type { RequestListener } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TypedValue } from '@icecream-sheets/engine';
import { createAgentListener } from '../src/services/agentSvc.js';
import {
  issueEngineAccessToken,
  verifyEngineAccessToken,
} from '../src/deploy/engineAccess.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

type AuditEntry = { tool?: string; ok?: boolean; summary?: string };

const NUM = (v: number): TypedValue => ({ kind: 'number', value: v });

// ---------------------------------------------------------------------------
// No-access chat turns: the resolver matches nothing for this principal.
// ---------------------------------------------------------------------------

describe('agent truth #86 (no-access chat turns)', () => {
  let agent: Started | null = null;
  let savedDataDir: string | undefined;

  const CAROL = { 'x-principal': 'user:carol' };
  const post = (path: string, body: unknown) =>
    httpJson('POST', `${agent!.url}${path}`, { headers: CAROL, body });

  beforeAll(async () => {
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ICECREAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'agent-truth-86-'));
    agent = await startServer(
      createAgentListener({ resolveSession: async () => null }),
    );
  });

  afterAll(async () => {
    if (agent) await stop(agent);
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a no-access chat write is refused, never reported as success, and never mutates the fallback workbook', async () => {
    const r = await post('/message', { text: 'set A1 to 5' });
    expect(r.status).toBe(200);
    const reply = r.json as { message: string; audit: AuditEntry[] };
    const write = reply.audit.find((a) => a.tool === 'write_cells');
    expect(write?.ok).toBe(false);
    expect(write?.summary).toContain('no workbook is bound');
    // The reply composes the failure, never a success narrative.
    expect(reply.message).toContain('no workbook is bound');
    expect(reply.message).not.toContain('Done.');
    // The refused write left nothing behind: the same chat runtime's
    // workbook still reads empty at A1. (Pre-fix this read returned 5.)
    const read = await post('/message', { text: 'what is in A1' });
    expect(read.status).toBe(200);
    expect((read.json as { message: string }).message).toContain('(empty)');
  });

  it('a no-access chat formula is refused the same way', async () => {
    const r = await post('/message', { text: 'put =SUM(A1:A3) in B1' });
    expect(r.status).toBe(200);
    const reply = r.json as { message: string; audit: AuditEntry[] };
    const formula = reply.audit.find((a) => a.tool === 'set_formulas');
    expect(formula?.ok).toBe(false);
    expect(formula?.summary).toContain('no workbook is bound');
    expect(reply.message).toContain('no workbook is bound');
    expect(reply.message).not.toContain('Done.');
  });

  it('recalculate still succeeds on an unbound chat runtime (compute, not user data)', async () => {
    const r = await post('/message', { text: 'recalculate now' });
    expect(r.status).toBe(200);
    const reply = r.json as { audit: AuditEntry[] };
    expect(reply.audit.find((a) => a.tool === 'recalculate')?.ok).toBe(true);
  });

  it('the bridge keeps its writable private host when unbound', async () => {
    const seed = await post('/tools/call', {
      tool: 'write_cells',
      args: { cells: [{ sheet: 'Sheet1', row: 0, col: 0, value: 99 }] },
    });
    expect(seed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Bound editor chat turns: the #86 cache-key change must not regress
// the bound path (fake engine HTTP server + editor session).
// ---------------------------------------------------------------------------

const FAKE_SECRET = 'agent-truth-86-fake-secret';
const DAVE = { 'x-principal': 'user:dave' };

describe('agent truth #86 (bound editor still writes)', () => {
  let engine: Started | null = null;
  let agent: Started | null = null;
  let savedSecret: string | undefined;
  let savedDataDir: string | undefined;

  const FILE_ID = 'file-agent-truth-86';
  const SESSION_ID = 'sess_agent_truth_86';
  let fakeRevision = 0;
  const opsSeen: unknown[] = [];

  beforeAll(async () => {
    savedSecret = process.env.ENGINE_ACCESS_SECRET;
    process.env.ENGINE_ACCESS_SECRET = FAKE_SECRET;
    savedDataDir = process.env.ICECREAM_DATA_DIR;
    process.env.ICECREAM_DATA_DIR = mkdtempSync(join(tmpdir(), 'agent-truth-86-bound-'));

    const send = (res: Parameters<RequestListener>[1], status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    engine = await startServer(((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      try {
        const claims = verifyEngineAccessToken(token, FAKE_SECRET, {
          sessionId: SESSION_ID,
          principal: 'user:dave',
        });
        if (claims.fid !== FILE_ID || claims.role !== 'editor') throw new Error('scope');
      } catch {
        return send(res, 401, { ok: false, error: 'engine access denied' });
      }
      let body: Record<string, unknown> = {};
      const finish = async () => {
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        }
        if (url.pathname === '/session/status') {
          return send(res, 200, { ok: true, sessionId: SESSION_ID, fileId: FILE_ID, revision: fakeRevision });
        }
        if (url.pathname === '/ops') {
          opsSeen.push(body);
          fakeRevision += 1;
          return send(res, 200, {
            ok: true,
            revision: fakeRevision,
            ack: { revision: fakeRevision, changedCellCount: 1, checksum: 'fake' },
          });
        }
        if (url.pathname === '/execute') return send(res, 200, { ok: true });
        if (url.pathname === '/sheets') return send(res, 200, { sheets: ['Sheet1'] });
        if (url.pathname === '/snapshot') {
          return send(res, 200, { protocolVersion: 1, sheets: [{ name: 'Sheet1', cells: [] }] });
        }
        if (url.pathname === '/events') return send(res, 200, { events: [] });
        return send(res, 404, { ok: false, error: `fake engine: no route ${url.pathname}` });
      };
      void finish();
    }) as RequestListener);

    const resolved = {
      fileId: FILE_ID,
      sessionId: SESSION_ID,
      engineUrl: engine.url,
      ownershipEpoch: 1,
      creatorPrincipal: 'user:dave',
      role: 'editor' as const,
      currentRevision: 0,
      updatedAt: Date.now(),
    };
    agent = await startServer(
      createAgentListener({ resolveSession: async () => resolved }),
    );
  });

  afterAll(async () => {
    if (agent) await stop(agent);
    if (engine) await stop(engine);
    if (savedSecret === undefined) delete process.env.ENGINE_ACCESS_SECRET;
    else process.env.ENGINE_ACCESS_SECRET = savedSecret;
    if (savedDataDir === undefined) delete process.env.ICECREAM_DATA_DIR;
    else process.env.ICECREAM_DATA_DIR = savedDataDir;
  });

  it('a bound editor chat write still lands on the engine session', async () => {
    const r = await httpJson('POST', `${agent!.url}/message`, {
      headers: DAVE,
      body: { text: 'set C1 to 424242' },
    });
    expect(r.status).toBe(200);
    const reply = r.json as { audit: AuditEntry[] };
    expect(reply.audit.find((a) => a.tool === 'write_cells')?.ok).toBe(true);
    expect(opsSeen).toHaveLength(1);
    expect(opsSeen[0]).toMatchObject({
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 2 }, value: 424242 },
    });
    // Sanity: the minter's tokens really are the deploy signer's shape.
    const probe = issueEngineAccessToken({
      secret: FAKE_SECRET,
      principal: 'user:dave',
      sessionId: SESSION_ID,
      fid: FILE_ID,
      role: 'editor',
      tier: 'standard',
      ttlSeconds: 120,
    });
    expect(verifyEngineAccessToken(probe.token, FAKE_SECRET).fid).toBe(FILE_ID);
  });
});
