/**
 * Sheet structural ops through POST /ops (agent-rerun case 7 regression).
 *
 * The 2026-10-22 agent validation found sheet.add failing at the engine
 * with 200 + { ok:false, "Unknown command: {\"type\":\"sheet.add\",…}" }:
 * a half-converted op shape (collab `type`, params inlined, no `cmd`
 * field) reached execute(). On the current tree the conversion pair
 * (cmdToCollabOp / collabOpToCmd) is symmetric and the op lands — these
 * tests pin that end to end at the route level, in the exact case-7
 * posture (a JOINER adds the sheet), through the rebase branch, and with
 * the second client observing the structure change over SSE. They also
 * pin the fail-fast contract: a malformed, non-EngineCommand `cmd` is a
 * 400 at the route (never a phantom 200 "Unknown command"), on both
 * /ops and the legacy /execute route, with nothing journaled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import {
  collabOpToCmd,
  cmdToCollabOp,
  createEngineListener,
  isEngineCommandShape,
} from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import { MemoryFileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'sheetadd-test-secret';

function tinyXlsxBase64(): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[10, 20], [null, '=A1+B1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

function tokenFor(principal: string, sid: string, fid: string): string {
  return issueEngineAccessToken({
    secret: SECRET,
    principal,
    sessionId: sid,
    tier: 'standard',
    fid,
    role: 'editor',
  }).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('sheet structural ops via /ops (case-7 regression)', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup() {
    svc = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: new MemoryFileRegistry(),
        deployEnv: {
          ENGINE_ACCESS_MODE: 'signed',
          ENGINE_ACCESS_SECRET: SECRET,
          AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
        } as NodeJS.ProcessEnv,
      }),
    );
    return svc;
  }

  async function claimAndLoad(fid: string, sid: string, principal = 'user:alice') {
    const tok = tokenFor(principal, sid, fid);
    const claim = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(tok),
      body: { fileId: fid, sessionId: sid },
    });
    expect(claim.status).toBe(200);
    const load = await httpJson('POST', `${svc!.url}/load`, {
      headers: bearer(tok),
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: sid },
    });
    expect(load.status).toBe(200);
    return tok;
  }

  function ops(token: string, body: unknown) {
    return httpJson('POST', `${svc!.url}/ops`, { headers: bearer(token), body });
  }

  async function revision(token: string): Promise<number> {
    const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: bearer(token) });
    return (st.json as { revision: number }).revision;
  }

  it('conversion pair: sheet ops round-trip cmd -> collab op -> cmd', () => {
    for (const cmd of [
      { cmd: 'addSheet', name: 'Data' },
      { cmd: 'deleteSheet', name: 'Data' },
      { cmd: 'renameSheet', name: 'Data', newName: 'Data2' },
    ] as const) {
      const op = cmdToCollabOp(cmd as never, 'client-1', 3);
      expect(op).not.toBeNull();
      expect(collabOpToCmd(op!)).toEqual(cmd);
    }
    expect(isEngineCommandShape({ cmd: 'addSheet', name: 'X' })).toBe(true);
    // The shapes from the field failure are NOT commands.
    expect(isEngineCommandShape({ type: 'sheet.add', name: 'X' })).toBe(false);
    expect(isEngineCommandShape({ type: 'sheet.add', params: { name: 'X' } })).toBe(false);
    expect(isEngineCommandShape({ name: 'X' })).toBe(false);
    expect(isEngineCommandShape({ cmd: '' })).toBe(false);
    expect(isEngineCommandShape(null)).toBe(false);
  });

  it('joiner addSheet at current baseRev: applied, journaled, readable by both clients', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    // Alice makes one edit so the session revision is > 0 (case-7 posture:
    // the joiner authors against a live session, not a fresh one).
    const edit = await ops(alice, {
      clientId: 'alice-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 42 },
    });
    expect(edit.json).toMatchObject({ ok: true, revision: 1 });

    // Bob joins the same session (claim is the join in this topology) and
    // adds a sheet at the current revision.
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const join = await httpJson('POST', `${svc!.url}/session/claim`, {
      headers: bearer(bob),
      body: { fileId: 'file-1', sessionId: 'sess_1' },
    });
    expect(join.status).toBe(200);
    const add = await ops(bob, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 1,
      cmd: { cmd: 'addSheet', name: 'Inventory CSV' },
    });
    expect(add.status).toBe(200);
    expect(add.json).toMatchObject({ ok: true, revision: 2 });

    // The op journaled: revision moved, and the new sheet is readable by
    // BOTH the author and the other client.
    expect(await revision(alice)).toBe(2);
    for (const tok of [alice, bob]) {
      const rd = await httpJson('POST', `${svc!.url}/read`, {
        headers: bearer(tok),
        body: { kind: 'range', range: { sheet: 'Inventory CSV', startRow: 0, startCol: 0, endRow: 1, endCol: 1 } },
      });
      expect(rd.status).toBe(200);
    }
    // Catch-up carries the structural op for a client syncing from rev 1.
    const revs = await httpJson('GET', `${svc!.url}/revisions?from=1&to=2`, { headers: bearer(alice) });
    expect(revs.status).toBe(200);
    const list = (revs.json as { revisions: Array<{ revision: number; op: { cmd?: string } }> }).revisions;
    expect(list.map((r) => r.revision)).toEqual([2]);
    expect(list[0]!.op).toMatchObject({ cmd: 'addSheet', name: 'Inventory CSV' });
  });

  it('addSheet at a stale baseRev is rebased and applied (not rejected)', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    const e1 = await ops(alice, {
      clientId: 'alice-c', clientSeq: 1, baseRev: 0,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 },
    });
    expect(e1.json).toMatchObject({ ok: true, revision: 1 });
    const e2 = await ops(bob, {
      clientId: 'bob-c', clientSeq: 1, baseRev: 1,
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 2 },
    });
    expect(e2.json).toMatchObject({ ok: true, revision: 2 });
    // Alice's addSheet was authored against revision 1; the intervening
    // op is a cell.set, which does not obsolete a sheet.add.
    const add = await ops(alice, {
      clientId: 'alice-c', clientSeq: 2, baseRev: 1,
      cmd: { cmd: 'addSheet', name: 'Rebased Sheet' },
    });
    expect(add.status).toBe(200);
    expect(add.json).toMatchObject({ ok: true, revision: 3 });
    expect(await revision(bob)).toBe(3);
  });

  it('SSE: a second client sees the structure event when a sheet is added', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const bob = tokenFor('user:bob', 'sess_1', 'file-1');
    // Bob listens on the always-on SSE channel before Alice's op.
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let sawStructure: ((e: { event: string; data: Record<string, unknown> }) => void) | null = null;
    const structureSeen = new Promise<{ event: string; data: Record<string, unknown> }>((resolve) => {
      sawStructure = resolve;
    });
    const u = new URL(`${svc!.url}/deltas`);
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname, headers: bearer(bob) },
      (res) => {
        expect(res.statusCode).toBe(200);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (block.startsWith(':')) continue;
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            const parsed = { event, data: JSON.parse(data) as Record<string, unknown> };
            events.push(parsed);
            if (parsed.event === 'session' && parsed.data['kind'] === 'structure') sawStructure?.(parsed);
          }
        });
      },
    );
    try {
      // Wait for the hello frame so the subscription is live.
      await new Promise<void>((resolve, reject) => {
        const t = setInterval(() => {
          if (events.some((e) => e.event === 'hello')) {
            clearInterval(t);
            resolve();
          }
        }, 10);
        setTimeout(() => reject(new Error('no SSE hello')), 5000);
      });
      const add = await ops(alice, {
        clientId: 'alice-c', clientSeq: 1, baseRev: 0,
        cmd: { cmd: 'addSheet', name: 'Broadcast Sheet' },
      });
      expect(add.json).toMatchObject({ ok: true, revision: 1 });
      const structure = await Promise.race([
        structureSeen,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no structure event')), 5000)),
      ]);
      expect(structure.data['revision']).toBe(1);
      expect(structure.data['events']).toEqual(expect.arrayContaining(['sheetAdded']));
    } finally {
      req.destroy();
    }
  });

  it('malformed cmd shapes are 400 at the route — nothing journaled (/ops and /execute)', async () => {
    await setup();
    const alice = await claimAndLoad('file-1', 'sess_1');
    const badShapes: unknown[] = [
      // The exact field-failure shape: flat collab op (params inlined).
      { type: 'sheet.add', name: 'Inventory CSV' },
      // The proper CollabOp wire shape — still not an EngineCommand.
      { id: 'bob-c:0', type: 'sheet.add', baseRevision: 0, params: { name: 'Inventory CSV' } },
      { name: 'Inventory CSV' },
      { cmd: '' },
      { cmd: 42 },
    ];
    let seq = 0;
    for (const cmd of badShapes) {
      seq++;
      const r = await ops(alice, { clientId: 'alice-c', clientSeq: seq, baseRev: 0, cmd });
      expect(r.status).toBe(400);
      expect(String((r.json as { error?: string }).error ?? '')).toContain('EngineCommand');
      const ex = await httpJson('POST', `${svc!.url}/execute`, {
        headers: bearer(alice),
        body: { cmd },
      });
      expect(ex.status).toBe(400);
    }
    // Nothing was applied or journaled by any of the malformed attempts:
    // the revision never moved and no 'Inventory CSV' sheet exists.
    expect(await revision(alice)).toBe(0);
    const rd = await httpJson('POST', `${svc!.url}/read`, {
      headers: bearer(alice),
      body: { kind: 'range', range: { sheet: 'Inventory CSV', startRow: 0, startCol: 0, endRow: 0, endCol: 0 } },
    });
    expect(rd.status).not.toBe(200);
    // And a well-formed addSheet still lands afterwards (no poisoned state).
    const add = await ops(alice, {
      clientId: 'alice-c', clientSeq: 100, baseRev: 0,
      cmd: { cmd: 'addSheet', name: 'Inventory CSV' },
    });
    expect(add.json).toMatchObject({ ok: true, revision: 1 });
  });
});
