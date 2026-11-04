/**
 * #65 — /api/automation/* is mounted on the local topology.
 *
 * Production mounts the automation surface inside the combined service
 * package, but startAllLocal started no automation listener and its
 * gateway routes map had no '/api/automation' entry, so every
 * automation call on a locally built gateway answered 404
 * 'no backend route for /api/automation/...'. startAllLocal now serves
 * the automation listener (TriggerSupervisor-backed, fail-closed) and
 * routes the prefix to it.
 *
 * Ports: the 9290-9299 block claimed by the #63-#65 fix stream.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAllLocal, type StartedServices } from '../src/index.js';
import { httpJson } from './helpers.js';

const SECRET = 'automation-mount-test-secret';
const PORTS = {
  gateway: 9290,
  engine: 9291,
  vault: 9292,
  meta: 9293,
  etl: 9294,
  agent: 9295,
  mcp: 9296,
  addons: 9297,
  automation: 9298,
};
const GATEWAY = `http://127.0.0.1:${PORTS.gateway}`;
const AUTOMATION = `http://127.0.0.1:${PORTS.automation}`;

describe('#65 /api/automation mounted by startAllLocal', () => {
  let started: StartedServices | null = null;
  let auth: Record<string, string> = {};

  beforeAll(async () => {
    started = await startAllLocal({
      authSecret: SECRET,
      devLoginEnabled: true,
      ports: PORTS,
    });
    const login = await httpJson('POST', `${GATEWAY}/auth/login`, { body: { userId: 'alice' } });
    expect(login.status).toBe(200);
    auth = { Authorization: `Bearer ${(login.json as { token: string }).token}` };
  });

  afterAll(async () => {
    if (started) await started.close();
    started = null;
  });

  it('the automation listener answers its health on its own port', async () => {
    const r = await httpJson('GET', `${AUTOMATION}/health`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, service: 'automation' });
  });

  it('GET /api/automation/health through the gateway reaches the surface (not a gateway 404)', async () => {
    const anon = await httpJson('GET', `${GATEWAY}/api/automation/health`);
    expect(anon.status).toBe(401); // gateway auth still fail-closed
    const r = await httpJson('GET', `${GATEWAY}/api/automation/health`, { headers: auth });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, service: 'automation' });
  });

  it('GET /api/automation/triggers answers with the surface response, not "no backend route"', async () => {
    const r = await httpJson('GET', `${GATEWAY}/api/automation/triggers?fileId=file-nope`, {
      headers: auth,
    });
    // The surface's own designed answer for an unknown file — proof the
    // request reached the automation surface. The pre-fix gateway
    // answered 404 'no backend route for /api/automation/triggers'.
    expect(r.status).toBe(404);
    expect((r.json as { error: string }).error).toBe('unknown file: file-nope');
    expect(JSON.stringify(r.json)).not.toContain('no backend route');
  });
});
