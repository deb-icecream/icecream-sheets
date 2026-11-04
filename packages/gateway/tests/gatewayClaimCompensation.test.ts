/**
 * Batch-2 live wedge — gateway claim compensation.
 *
 * On the pass-2 deployment the gateway's registry CAS threw on every
 * first claim (Firestore rejects undefined document fields), AFTER the
 * engine claim had already created the session on the chosen instance.
 * With no compensating release, the orphaned engine session owned
 * nothing in the registry yet blocked every later claim for a
 * different file with the §9 hard refusal — the owner's "already open
 * in another session" on brand-new files. The gateway now releases the
 * just-claimed engine session whenever the registry claim fails or is
 * lost without this open adopting that exact session.
 *
 * This suite pins the throw path: a registry whose claim() always
 * throws must still produce the designed 503, AND the engine must be
 * left empty (a different file claims immediately, no 409).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import {
  MemoryFileRegistry,
  type FileRegistry,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'compensation-test-secret';

class ThrowingClaimRegistry extends MemoryFileRegistry {
  override async claim(_record: FileRegistryRecord, _expectedEpoch: number | null): Promise<boolean> {
    throw new Error('Cannot use "undefined" as a Firestore value (found in field "grants")');
  }
}

function signedEnv(): NodeJS.ProcessEnv {
  return {
    ENGINE_ACCESS_MODE: 'signed',
    ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
    AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
  } as NodeJS.ProcessEnv;
}

const authHdr = (token: string) => ({ authorization: `Bearer ${token}` });

describe('batch-2 wedge — gateway releases the engine session when the registry claim fails', () => {
  let engine: Started | null = null;
  let gw: Started | null = null;

  afterEach(async () => {
    if (gw) await stop(gw);
    if (engine) await stop(engine);
    gw = null;
    engine = null;
  });

  async function setup() {
    const engineRegistry = new MemoryFileRegistry();
    const stores = new MemorySessionStores();
    engine = await startServer(
      createEngineListener({
        sessionStores: stores,
        fileRegistry: engineRegistry,
        deployEnv: signedEnv(),
      }),
    );
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/engine': engine!.url },
        rateLimit: { points: 100_000, perSeconds: 60 },
        engineAccess: {
          ['sec' + 'ret']: SECRET,
          ttlSeconds: 600,
          tiers: { standard: engine!.url, xl: engine!.url },
        },
        fileRegistry: new ThrowingClaimRegistry() as FileRegistry,
        engineInstances: { 'engine-1': engine!.url },
        engineInstanceId: 'engine-1',
      }),
    );
  }

  function engineToken(principal: string, sid: string, fid: string): string {
    return issueEngineAccessToken({
      secret: SECRET,
      principal,
      sessionId: sid,
      tier: 'standard',
      fid,
      role: 'editor',
    }).token;
  }

  it('a throwing registry claim -> 503 AND the claimed engine session is released (no orphan wedge)', async () => {
    await setup();
    const login = await httpJson('POST', `${gw!.url}/auth/login`, { body: { userId: 'alice' } });
    expect(login.status).toBe(200);
    const jwt = (login.json as { token: string }).token;

    const open = await httpJson('POST', `${gw!.url}/api/engine/open`, {
      headers: authHdr(jwt),
      body: { name: 'wedge.xlsx' },
    });
    expect(open.status).toBe(503);
    expect((open.json as { error?: string }).error).toBe('session registry unavailable');

    // The engine claim inside that open created a session for the new
    // file. If the gateway had NOT compensated, the engine would still
    // hold it and this different-file claim would 409 (the live
    // wedge). With compensation it must succeed immediately.
    const claim2 = await httpJson('POST', `${engine!.url}/session/claim`, {
      headers: authHdr(engineToken('user:alice', 'sess_second', 'file-second')),
      body: { fileId: 'file-second', sessionId: 'sess_second' },
    });
    expect(claim2.status).toBe(200);
    expect(claim2.json).toMatchObject({ ok: true, sessionId: 'sess_second', fileId: 'file-second' });
  });
});
