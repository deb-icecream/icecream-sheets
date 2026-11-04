/** Issue #27 family / batch-2 wedge backstop: with SESSION_LIFECYCLE=on the idle sweeper checkpoints + evicts a session idle past IDLE_TIMEOUT_MS (the 10-minute rule, compressed here), so a stranded session frees its instance for other files. */
import { describe, expect, it } from 'vitest';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import { MemoryFileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop } from './helpers.js';

const SECRET = 'scratch-secret';

describe('engine idle sweeper (SESSION_LIFECYCLE)', () => {
  it('evicts an idle pending session', async () => {
    const stores = new MemorySessionStores();
    const env = {
      ENGINE_ACCESS_MODE: 'signed',
      ['ENGINE_ACCESS_' + 'SECRET']: SECRET,
      AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
      SESSION_LIFECYCLE: 'on',
      IDLE_TIMEOUT_MS: '1000',
      SESSION_SWEEPER_MS: '250',
    } as NodeJS.ProcessEnv;
    const svc = await startServer(
      createEngineListener({ sessionStores: stores, fileRegistry: new MemoryFileRegistry(), deployEnv: env }),
    );
    try {
      const tok = issueEngineAccessToken({
        secret: SECRET, principal: 'user:alice', sessionId: 'sess_pend', tier: 'standard', fid: 'file-p', role: 'editor',
      }).token;
      const claim = await httpJson('POST', `${svc.url}/session/claim`, {
        headers: { authorization: `Bearer ${tok}` },
        body: { fileId: 'file-p', sessionId: 'sess_pend' },
      });
      expect(claim.status).toBe(200);
      let freed = false;
      for (let i = 0; i < 20 && !freed; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const tok2 = issueEngineAccessToken({
          secret: SECRET, principal: 'user:alice', sessionId: 'sess_q', tier: 'standard', fid: 'file-q', role: 'editor',
        }).token;
        const c2 = await httpJson('POST', `${svc.url}/session/claim`, {
          headers: { authorization: `Bearer ${tok2}` },
          body: { fileId: 'file-q', sessionId: 'sess_q' },
        });
        if (c2.status === 200) freed = true;
      }
      expect(freed).toBe(true);
    } finally {
      await stop(svc);
    }
  }, 30_000);
});
