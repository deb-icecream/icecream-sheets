/**
 * Vault service: credential storage behind HTTP.
 *
 * Wraps CredentialVault (packages/service/src/vault.ts). Secrets are
 * encrypted with the vault master key; only references travel.
 *
 * Authorization: ref format `user:<userId>:<name>`. A requester may only
 * touch refs starting with their own `user:<userId>:` prefix (fail closed
 * otherwise). The vault itself is also constructed per request with a
 * request-scoped check closure, so the check callback and the HTTP handler
 * enforce the same rule (defense in depth). Persistence is in-memory for
 * now — prod backs this with the service metadata store backend.
 *
 * Endpoints:
 * - GET  /health
 * - POST /store    { ref, secret }
 * - POST /retrieve { ref } → { secret }
 * - POST /revoke   { ref }
 * - GET  /refs     → { refs: string[] } (requester's own refs only)
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { CredentialVault, KeyManager, memoryPersistence, type Persistence } from '@icecream-sheets/service';
import { handlePreflight, readBody, requestPrincipal, sendError, sendJson } from '../httpUtils.js';

// Shared across requests in this process: the ciphertext store and the key
// material. Prod replaces memoryPersistence() with the metadata store backend.
const persistence: Persistence = memoryPersistence();
const keys = new KeyManager(memoryPersistence());

/** The requester's own credential namespace: `user:<userId>:`. */
function ownPrefix(principal: string): string {
  return `${principal}:`;
}

export function createVaultListener(): RequestListener {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://vault');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const principal = requestPrincipal(req);
    const prefix = ownPrefix(principal);

    /** Vault instance scoped to this request: the check closure pins the requester. */
    async function scopedVault(): Promise<CredentialVault> {
      return CredentialVault.create(persistence, keys, {
        check: (_action, target) => target.startsWith(prefix),
      });
    }

    try {
      if (path === '/health' && method === 'GET') {
        return sendJson(res, 200, { ok: true, service: 'vault' });
      }

      if (path === '/store' && method === 'POST') {
        const body = (await readBody(req)) as { ref?: unknown; secret?: unknown } | undefined;
        if (typeof body?.ref !== 'string' || typeof body?.secret !== 'string') {
          return sendError(res, 400, '{ ref: string, secret: string } required');
        }
        if (!body.ref.startsWith(prefix)) {
          return sendError(res, 403, `ref must start with your own prefix '${prefix}'`);
        }
        await (await scopedVault()).store(body.ref, body.secret, principal);
        return sendJson(res, 200, { ok: true });
      }

      if (path === '/retrieve' && method === 'POST') {
        const body = (await readBody(req)) as { ref?: unknown } | undefined;
        if (typeof body?.ref !== 'string') return sendError(res, 400, '{ ref: string } required');
        if (!body.ref.startsWith(prefix)) {
          return sendError(res, 403, `ref must start with your own prefix '${prefix}'`);
        }
        try {
          const secret = await (await scopedVault()).retrieve(body.ref, principal);
          return sendJson(res, 200, { ok: true, secret });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const status = /unknown credential reference/.test(msg) ? 404 : 403;
          return sendError(res, status, msg);
        }
      }

      if (path === '/revoke' && method === 'POST') {
        const body = (await readBody(req)) as { ref?: unknown } | undefined;
        if (typeof body?.ref !== 'string') return sendError(res, 400, '{ ref: string } required');
        if (!body.ref.startsWith(prefix)) {
          return sendError(res, 403, `ref must start with your own prefix '${prefix}'`);
        }
        try {
          await (await scopedVault()).revoke(body.ref, principal);
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const status = /unknown credential reference/.test(msg) ? 404 : 403;
          return sendError(res, status, msg);
        }
      }

      if (path === '/refs' && method === 'GET') {
        const refs = (await scopedVault()).listRefs().filter((r) => r.startsWith(prefix));
        return sendJson(res, 200, { refs });
      }

      return sendError(res, 404, `not found: ${path}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return sendError(res, 500, `vault error: ${msg}`);
    }
  };
}
