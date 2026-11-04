import { afterEach, describe, expect, it } from 'vitest';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
// sha256("") — the checksum a blank-workbook serialization carries.
const BLANK_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('engine blank-session checkpoint guard (#88D)', () => {
  let svc: Started | null = null;
  let stores: MemorySessionStores;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup() {
    stores = new MemorySessionStores();
    svc = await startServer(
      createEngineListener({ sessionStores: stores, fileRegistry: null }),
    );
  }

  function post(path: string, body: unknown, headers: Record<string, string> = ALICE) {
    return httpJson('POST', `${svc!.url}${path}`, { headers, body });
  }

  it('a claim-minted session that never loaded writes no snapshot on extras settle or release', async () => {
    await setup();
    const claim = await post('/session/claim', { fileId: 'file-88d-blank' });
    expect(claim.status).toBe(200);
    const sessionId = (claim.json as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();

    // The poison path in the 88D repro: the client pushes session extras
    // ~800 ms after workbookLoaded, arming the 1500 ms autosave settle
    // timer on a session that never built a workbook. Pre-fix this wrote
    // a blank snapshot the next claim faithfully rehydrated forever.
    const extras = await post('/session-extras', { sheetStyles: {} });
    expect(extras.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(await stores.snapshots.get(sessionId)).toBeNull();

    // The second poison path: page-unload release checkpoints too.
    const rel = await post('/session/release', { sessionId, reason: 'page-unload' });
    expect(rel.status).toBe(200);
    expect(await stores.snapshots.get(sessionId)).toBeNull();
  });

  it('a loaded session checkpoints normally on release', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'S', rows: [[1]] }],
      metadata: {},
    });
    const load = await post('/load', {
      format: 'xlsx',
      data: Buffer.from(bytes).toString('base64'),
    });
    expect(load.status).toBe(200);
    const sessionId = (load.json as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();

    const rel = await post('/session/release', { sessionId, reason: 'page-unload' });
    expect(rel.status).toBe(200);
    const snap = await stores.snapshots.get(sessionId);
    expect(snap).not.toBeNull();
    expect(snap!.checksum).not.toBe(BLANK_SHA256);
    expect(snap!.bytes.length).toBeGreaterThan(0);
  });
});
