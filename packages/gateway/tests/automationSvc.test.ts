/**
 * Automation surface tests (triggers program, post-pivot design):
 * the /triggers contract over real HTTP (authn/authz/validation/
 * status codes) against a session-less supervisor, plus the money
 * integration test — a REAL engine listener whose session hooks drive
 * the supervisor (the bin/engine composition): trigger state created
 * through the surface BEFORE the file opens fires onOpen at claim;
 * a granted onEdit trigger fires on a DIFFERENT principal's edit with
 * its writes landing through the engine's real sequenced op
 * composition (journal + revision), read back over the engine API;
 * ungranted refuses visibly, then fires after grant; disable stops it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Persistence } from '@icecream-sheets/service';
import type { FileRegistryRecord } from '../src/deploy/fileRegistry.js';
import { createAutomationListener } from '../src/services/automationSvc.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import {
  TriggerSupervisor,
  type TriggerPersistenceProvider,
} from '../src/services/triggerSupervisor.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const NOW = 1_800_000_000_000;
const FILE = 'file-svc-1';
const ALICE = { 'x-principal': 'user:alice' };
const BOB = { 'x-principal': 'user:bob' };
const EVE = { 'x-principal': 'user:eve' };
const MALLORY = { 'x-principal': 'user:mallory' };

const WRITE_PERMS = [
  { action: 'cell.write', target: 'Sheet1!1,0' },
  { action: 'cell.read', target: 'Sheet1!0,0' },
];

function memoryProvider(): TriggerPersistenceProvider {
  const backing = new Map<string, string>();
  return {
    forScope: async () => {
      const persistence: Persistence = {
        load: (k) => backing.get(k) ?? null,
        save: (k, v) => void backing.set(k, v),
        clear: (k) => void backing.delete(k),
      };
      return { persistence, flush: async () => undefined };
    },
  };
}

function record(sessionId: string): FileRegistryRecord {
  return {
    fileId: FILE,
    sessionId,
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://127.0.0.1:9',
    leaseExpiry: NOW + 600_000,
    ownershipEpoch: 1,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: NOW,
    creatorPrincipal: 'user:alice',
    participants: { 'user:bob': 'editor', 'user:eve': 'viewer' },
    // Read-only enforcement (design doc sections 4/8): participants are
    // advisory join records only — access binds from the owner's GRANTS.
    grants: { 'user:bob': 'editor', 'user:eve': 'viewer' },
  } as FileRegistryRecord;
}

const EDIT_SPEC = {
  name: 'marker',
  event: 'onEdit' as const,
  language: 'javascript' as const,
  script: 'api.setCell({sheet:"Sheet1",row:0,col:1}, 4242);',
  permissions: WRITE_PERMS,
};

describe('automation surface (contract + authorization)', () => {
  let svc: Started;
  let sup: TriggerSupervisor;

  beforeAll(async () => {
    sup = new TriggerSupervisor({
      records: [record('sess-surface')],
      persistenceProvider: memoryProvider(),
      nowMs: () => NOW,
      log: () => undefined,
    });
    svc = await startServer(createAutomationListener({ supervisor: sup }));
  });
  afterAll(async () => {
    await sup.stop();
    await stop(svc);
  });

  const list = (headers: Record<string, string>, fileId = FILE) =>
    httpJson('GET', `${svc.url}/triggers?fileId=${fileId}`, { headers });

  it('401 without a principal; 404 for an unknown file; 403 for a stranger', async () => {
    expect((await httpJson('GET', `${svc.url}/triggers?fileId=${FILE}`)).status).toBe(401);
    expect((await list(ALICE, 'file-nope')).status).toBe(404);
    expect((await list(MALLORY)).status).toBe(403);
  });

  it('viewer reads but cannot mutate; editor + creator can; create validates the spec', async () => {
    const empty = await list(EVE);
    expect(empty.status).toBe(200);
    expect((empty.json as { events: string[] }).events).toEqual([
      'onOpen',
      'onEdit',
      'onInterval',
      'onAtTime',
    ]);
    expect((empty.json as { triggers: unknown[] }).triggers).toEqual([]);

    const eveCreate = await httpJson('POST', `${svc.url}/triggers`, {
      headers: EVE,
      body: { fileId: FILE, spec: EDIT_SPEC },
    });
    expect(eveCreate.status).toBe(403);

    const bad = await httpJson('POST', `${svc.url}/triggers`, {
      headers: ALICE,
      body: { fileId: FILE, spec: { name: '', event: 'onEdit', script: 'x' } },
    });
    expect(bad.status).toBe(400);

    const created = await httpJson('POST', `${svc.url}/triggers`, {
      headers: BOB, // editor participant may create
      body: { fileId: FILE, spec: EDIT_SPEC },
    });
    expect(created.status).toBe(200);
    const trigger = (created.json as { trigger: { id: string; granted: boolean } }).trigger;
    expect(trigger.granted).toBe(false);

    const granted = await httpJson('POST', `${svc.url}/triggers/${trigger.id}/grant`, {
      headers: ALICE,
      body: { fileId: FILE },
    });
    expect(granted.status).toBe(200);
    expect((granted.json as { trigger: { granted: boolean } }).trigger.granted).toBe(true);

    const unknown = await httpJson('POST', `${svc.url}/triggers/trigger-nope/grant`, {
      headers: ALICE,
      body: { fileId: FILE },
    });
    expect(unknown.status).toBe(404);

    const del = await httpJson('DELETE', `${svc.url}/triggers/${trigger.id}?fileId=${FILE}`, {
      headers: ALICE,
    });
    expect(del.status).toBe(200);
    expect((await list(ALICE)).json).toMatchObject({ triggers: [] });
  });

  it('503 when the supervisor is null (fail closed)', async () => {
    const dead = await startServer(createAutomationListener({ supervisor: null }));
    try {
      const res = await httpJson('GET', `${dead.url}/triggers?fileId=${FILE}`, {
        headers: ALICE,
      });
      expect(res.status).toBe(503);
    } finally {
      await stop(dead);
    }
  });
});

describe('integration: real engine session (bin/engine composition)', () => {
  let engine: Started;
  let svc: Started;
  let sup: TriggerSupervisor;
  let sessionId: string;

  const readCell = async (row: number, col: number) => {
    const rd = await httpJson('POST', `${engine.url}/read`, {
      headers: ALICE,
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row, col } },
    });
    return (rd.json as { value: { kind: string; value: unknown } }).value;
  };
  const editAsBob = (row: number, col: number, value: unknown) =>
    httpJson('POST', `${engine.url}/execute`, {
      headers: BOB,
      body: { cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row, col }, value } },
    });
  const waitFor = async (fn: () => Promise<boolean>, ms = 15_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };
  const surfaceList = async () => {
    const listed = await httpJson('GET', `${svc.url}/triggers?fileId=${FILE}`, {
      headers: ALICE,
    });
    return (
      listed.json as {
        triggers: {
          id: string;
          name: string;
          granted: boolean;
          lastRun: { ok: boolean; error?: string } | null;
        }[];
      }
    ).triggers;
  };

  beforeAll(async () => {
    sup = new TriggerSupervisor({
      records: () => [record(sessionId ?? 'sess-pending')],
      persistenceProvider: memoryProvider(),
      nowMs: () => NOW,
      log: () => undefined,
    });
    engine = await startServer(
      createEngineListener({
        fileRegistry: null,
        sessionHooks: {
          onSessionReady: (h) => void sup.noteSessionReady(h),
          onSessionClosed: (sid) => void sup.noteSessionClosed(sid),
        },
      }),
    );
    svc = await startServer(createAutomationListener({ supervisor: sup }));
  }, 60_000);
  afterAll(async () => {
    await sup.stop();
    await stop(svc);
    await stop(engine);
  });

  it('onOpen fires at claim; a granted onEdit trigger fires on ANOTHER principal’s edit through the real sequencer; ungranted refuses visibly then fires after grant; disable stops it', async () => {
    // 1. Create + grant everything through the surface BEFORE the
    //    file is opened (detached CRUD against the store).
    const openCreated = await httpJson('POST', `${svc.url}/triggers`, {
      headers: ALICE,
      body: {
        fileId: FILE,
        spec: {
          name: 'greeter',
          event: 'onOpen',
          language: 'javascript',
          script: 'api.setCell({sheet:"Sheet1",row:0,col:4}, 111);',
          permissions: [{ action: 'cell.write', target: 'Sheet1!4,0' }],
        },
      },
    });
    expect(openCreated.status).toBe(200);
    const openId = (openCreated.json as { trigger: { id: string } }).trigger.id;
    await httpJson('POST', `${svc.url}/triggers/${openId}/grant`, {
      headers: ALICE,
      body: { fileId: FILE },
    });

    const created = await httpJson('POST', `${svc.url}/triggers`, {
      headers: ALICE,
      body: { fileId: FILE, spec: EDIT_SPEC },
    });
    const markerId = (created.json as { trigger: { id: string } }).trigger.id;
    await httpJson('POST', `${svc.url}/triggers/${markerId}/grant`, {
      headers: ALICE,
      body: { fileId: FILE },
    });

    const created2 = await httpJson('POST', `${svc.url}/triggers`, {
      headers: ALICE,
      body: {
        fileId: FILE,
        spec: {
          ...EDIT_SPEC,
          name: 'second',
          script: 'api.setCell({sheet:"Sheet1",row:0,col:6}, 777);',
          permissions: [{ action: 'cell.write', target: 'Sheet1!6,0' }],
        },
      },
    });
    const secondId = (created2.json as { trigger: { id: string } }).trigger.id;

    // A read + multi-write trigger (proves the restored semantics
    // end-to-end): C1 := A1 * 2 and D1 := 5 in ONE run.
    const created3 = await httpJson('POST', `${svc.url}/triggers`, {
      headers: ALICE,
      body: {
        fileId: FILE,
        spec: {
          name: 'doubler',
          event: 'onEdit',
          language: 'javascript',
          script: [
            'const cur = api.getCell({sheet:"Sheet1",row:0,col:0});',
            'const n = cur.kind === "number" ? cur.value : 0;',
            'api.setCell({sheet:"Sheet1",row:0,col:2}, n * 2);',
            'api.setCell({sheet:"Sheet1",row:0,col:3}, 5);',
          ].join('\n'),
          permissions: [
            { action: 'cell.read', target: 'Sheet1!0,0' },
            { action: 'cell.write', target: 'Sheet1!2,0' },
            { action: 'cell.write', target: 'Sheet1!3,0' },
          ],
        },
      },
    });
    const doublerId = (created3.json as { trigger: { id: string } }).trigger.id;
    await httpJson('POST', `${svc.url}/triggers/${doublerId}/grant`, {
      headers: ALICE,
      body: { fileId: FILE },
    });

    // 2. Open the file: reset creates the session, claim binds the
    //    file — the hook attaches the supervisor, onOpen fires.
    const reset = await httpJson('POST', `${engine.url}/reset`, { headers: ALICE, body: {} });
    sessionId = (reset.json as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^sess_/);
    const claim = await httpJson('POST', `${engine.url}/session/claim`, {
      headers: ALICE,
      body: { fileId: FILE },
    });
    expect(claim.status).toBe(200);
    expect(await waitFor(async () => sup.attachedSessionFor(FILE) === sessionId)).toBe(true);
    expect(await waitFor(async () => (await readCell(0, 4)).value === 111)).toBe(true);

    // 3. Bob edits A1 → the granted marker fires (through the real
    //    /ops composition: the write is journaled + revisioned).
    await editAsBob(0, 0, 7);
    expect(await waitFor(async () => (await readCell(0, 1)).value === 4242)).toBe(true);
    const markerStatus = (await surfaceList()).find((t) => t.id === markerId);
    expect(markerStatus?.lastRun?.ok).toBe(true);

    // 4. The doubler computed from the READ value and wrote BOTH cells.
    expect(await waitFor(async () => (await readCell(0, 2)).value === 14)).toBe(true);
    expect((await readCell(0, 3)).value).toBe(5);

    // 5. The ungranted 'second' trigger was refused; the surface
    //    shows why, and its cell was never written.
    const secondStatus = (await surfaceList()).find((t) => t.id === secondId);
    expect(secondStatus?.granted).toBe(false);
    expect(secondStatus?.lastRun?.ok).toBe(false);
    expect(secondStatus?.lastRun?.error).toMatch(/grant/i);
    expect((await readCell(0, 6)).value).not.toBe(777);
    await httpJson('POST', `${svc.url}/triggers/${secondId}/grant`, {
      headers: ALICE,
      body: { fileId: FILE },
    });
    await editAsBob(0, 0, 8);
    expect(await waitFor(async () => (await readCell(0, 6)).value === 777)).toBe(true);

    // 6. Disable the marker → clear its cell → Bob edits → no fire.
    await httpJson('POST', `${svc.url}/triggers/${markerId}/enabled`, {
      headers: ALICE,
      body: { fileId: FILE, enabled: false },
    });
    await editAsBob(0, 1, 0);
    await editAsBob(0, 0, 9);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await readCell(0, 1)).value).toBe(0);
  }, 120_000);
});

describe('scheduler tick endpoint (Scope update 2)', () => {
  let surface: Started;
  let tickCalls = 0;
  const FAKE_SUMMARY = {
    scanned: 3,
    fired: ['file-x'],
    skippedLive: [] as string[],
    failures: [] as { fileId: string; error: string }[],
  };

  beforeAll(async () => {
    const supervisor = new TriggerSupervisor({
      records: [],
      persistenceProvider: memoryProvider(),
      log: () => undefined,
    });
    (supervisor as unknown as { tick: () => Promise<typeof FAKE_SUMMARY> }).tick =
      async () => {
        tickCalls += 1;
        return FAKE_SUMMARY;
      };
    surface = await startServer(
      createAutomationListener({
        supervisor,
        tickAuthorize: async (auth) => auth === 'Bearer good-scheduler-token',
      }),
    );
  });
  afterAll(async () => {
    await stop(surface);
  });

  it('refuses a tick with no token (401) and never runs the scan', async () => {
    const r = await httpJson('POST', `${surface.url}/tick`);
    expect(r.status).toBe(401);
    expect(tickCalls).toBe(0);
  });

  it('refuses a tick with a wrong token (401)', async () => {
    const r = await httpJson('POST', `${surface.url}/tick`, {
      headers: { authorization: 'Bearer user-jwt-not-a-scheduler-token' },
    });
    expect(r.status).toBe(401);
    expect(tickCalls).toBe(0);
  });

  it('runs the scan for a verified scheduler token and returns the summary', async () => {
    const r = await httpJson('POST', `${surface.url}/tick`, {
      headers: { authorization: 'Bearer good-scheduler-token' },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, scanned: 3, fired: ['file-x'] });
    expect(tickCalls).toBe(1);
  });

  it('fails closed (503) when tick auth is not configured at all', async () => {
    const supervisor = new TriggerSupervisor({
      records: [],
      persistenceProvider: memoryProvider(),
      log: () => undefined,
    });
    const unconfigured = await startServer(
      createAutomationListener({ supervisor, tickAuth: null }),
    );
    try {
      const r = await httpJson('POST', `${unconfigured.url}/tick`, {
        headers: { authorization: 'Bearer anything' },
      });
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.json)).toContain('not configured');
    } finally {
      await stop(unconfigured);
    }
  });
});
