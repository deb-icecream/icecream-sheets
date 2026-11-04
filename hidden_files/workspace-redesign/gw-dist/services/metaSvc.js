/**
 * Metadata service: generic per-tenant key/value store behind HTTP.
 *
 * Follows the service MetadataStore pattern (packages/service/src/
 * metadataStore.ts) without persisting to disk: keys are namespaced per
 * principal — storage key = `<principal>/<key>` — so one tenant can never
 * read another's values. In-memory persistence for now; prod backs this
 * with the service metadata store backend (durable, encrypted at rest).
 *
 * Endpoints:
 * - GET    /health
 * - GET    /kv/:key      → { value: string | null }
 * - PUT    /kv/:key      { value: string }
 * - DELETE /kv/:key
 *
 * The :key segment may itself contain slashes (everything after /kv/).
 */
import { handlePreflight, readBody, requestPrincipal, sendError, sendJson } from '../httpUtils.js';
const store = new Map();
function namespacedKey(principal, key) {
    return `${principal}/${key}`;
}
export function createMetaListener() {
    return async (req, res) => {
        if (handlePreflight(req, res))
            return;
        const url = new URL(req.url ?? '/', 'http://meta');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const principal = requestPrincipal(req);
        try {
            if (path === '/health' && method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'meta' });
            }
            if (path === '/kv/' || path === '/kv') {
                return sendError(res, 400, 'a key is required: /kv/:key');
            }
            if (path.startsWith('/kv/')) {
                const key = decodeURIComponent(path.slice('/kv/'.length));
                if (key.length === 0)
                    return sendError(res, 400, 'a key is required: /kv/:key');
                const storageKey = namespacedKey(principal, key);
                if (method === 'GET') {
                    const value = store.has(storageKey) ? store.get(storageKey) : null;
                    return sendJson(res, 200, { value });
                }
                if (method === 'PUT') {
                    const body = (await readBody(req));
                    if (typeof body?.value !== 'string') {
                        return sendError(res, 400, '{ value: string } required');
                    }
                    store.set(storageKey, body.value);
                    return sendJson(res, 200, { ok: true });
                }
                if (method === 'DELETE') {
                    store.delete(storageKey);
                    return sendJson(res, 200, { ok: true });
                }
                return sendError(res, 405, 'method not allowed (use GET, PUT, DELETE)');
            }
            return sendError(res, 404, `not found: ${path}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return sendError(res, 500, `meta error: ${msg}`);
        }
    };
}
