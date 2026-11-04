import { handlePreflight, readBody, sendError, sendJson } from '../httpUtils.js';
import { tickAuthConfig, verifySchedulerOidc, } from './tickAuth.js';
/** Events the hosted runtime can fire in this topology (REPORT.md). */
export const AUTOMATION_EVENT_CAPABILITIES = [
    'onOpen',
    'onEdit',
    'onInterval',
    'onAtTime',
];
function rawPrincipal(req) {
    const h = req.headers['x-principal'];
    return typeof h === 'string' && h.length > 0 ? h : null;
}
export function createAutomationListener(deps) {
    const supervisor = deps.supervisor;
    return async (req, res) => {
        if (handlePreflight(req, res))
            return;
        const url = new URL(req.url ?? '/', 'http://automation');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        try {
            if (path === '/health' && method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'automation' });
            }
            // -- scheduler tick (Scope update 2) ------------------------------
            // Authenticated ONLY by the Cloud Scheduler OIDC token (no
            // x-principal). Fail closed: unconfigured → 503, bad or missing
            // token → 401, broken store → 503 (the tick retries later).
            if (path === '/tick' && method === 'POST') {
                if (!supervisor) {
                    return sendJson(res, 503, { ok: false, error: 'trigger supervisor unavailable' });
                }
                const config = deps.tickAuth !== undefined
                    ? deps.tickAuth
                    : tickAuthConfig(deps.env ?? process.env);
                if (!config && !deps.tickAuthorize) {
                    return sendJson(res, 503, {
                        ok: false,
                        error: 'tick auth not configured (TRIGGER_TICK_AUDIENCE / TRIGGER_TICK_SA_EMAIL)',
                    });
                }
                const authorized = deps.tickAuthorize
                    ? await deps.tickAuthorize(req.headers.authorization)
                    : await verifySchedulerOidc(req.headers.authorization, config);
                if (!authorized) {
                    return sendJson(res, 401, { ok: false, error: 'unauthorized tick' });
                }
                if (supervisor.prodBrokenReason !== null) {
                    return sendJson(res, 503, {
                        ok: false,
                        error: `trigger store unavailable (fail closed): ${supervisor.prodBrokenReason}`,
                    });
                }
                const summary = await supervisor.tick();
                return sendJson(res, 200, { ok: true, ...summary });
            }
            if (path !== '/triggers' && !path.startsWith('/triggers/')) {
                return sendError(res, 404, `not found: ${path}`);
            }
            if (!supervisor) {
                return sendJson(res, 503, { ok: false, error: 'trigger supervisor unavailable' });
            }
            if (supervisor.prodBrokenReason !== null) {
                return sendJson(res, 503, {
                    ok: false,
                    error: `trigger store unavailable (fail closed): ${supervisor.prodBrokenReason}`,
                });
            }
            const principal = rawPrincipal(req);
            if (principal === null) {
                return sendJson(res, 401, { ok: false, error: 'x-principal header required' });
            }
            // Shared gate: file must be known (any registry record), caller
            // must hold a role on it, mutations require 'editor'.
            const gate = async (fileId, mutation) => {
                if (!(await supervisor.fileKnown(fileId))) {
                    sendJson(res, 404, { ok: false, error: `unknown file: ${fileId}` });
                    return null;
                }
                const role = await supervisor.authorizeFile(principal, fileId);
                if (role === null) {
                    sendJson(res, 403, {
                        ok: false,
                        error: 'caller is not a participant of this file\u2019s session',
                    });
                    return null;
                }
                if (mutation && role !== 'editor') {
                    sendJson(res, 403, {
                        ok: false,
                        error: 'viewer participants cannot manage triggers',
                    });
                    return null;
                }
                return role;
            };
            // -- list ---------------------------------------------------------
            if (path === '/triggers' && method === 'GET') {
                const fileId = url.searchParams.get('fileId') ?? '';
                if (!fileId)
                    return sendError(res, 400, 'fileId query parameter required');
                if ((await gate(fileId, false)) === null)
                    return;
                const triggers = await supervisor.listForFile(fileId);
                return sendJson(res, 200, {
                    ok: true,
                    events: [...AUTOMATION_EVENT_CAPABILITIES],
                    triggers,
                });
            }
            // -- create -------------------------------------------------------
            if (path === '/triggers' && method === 'POST') {
                const body = (await readBody(req));
                if (!body || typeof body.fileId !== 'string' || body.fileId.length === 0) {
                    return sendError(res, 400, '{ fileId: string, spec: TriggerSpecInit } required');
                }
                if (typeof body.spec !== 'object' || body.spec === null) {
                    return sendError(res, 400, '{ fileId: string, spec: TriggerSpecInit } required');
                }
                if ((await gate(body.fileId, true)) === null)
                    return;
                try {
                    const trigger = await supervisor.createForFile(body.fileId, body.spec);
                    return sendJson(res, 200, { ok: true, trigger });
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg.includes('createTriggerSpec'))
                        return sendError(res, 400, msg);
                    throw e;
                }
            }
            // -- per-trigger routes -------------------------------------------
            const m = /^\/triggers\/([^/]+)(\/enabled|\/grant)?$/.exec(path);
            if (m && (method === 'POST' || method === 'DELETE')) {
                const id = decodeURIComponent(m[1]);
                const action = m[2] ?? '';
                if (method === 'DELETE' && action === '') {
                    const fileId = url.searchParams.get('fileId') ?? '';
                    if (!fileId)
                        return sendError(res, 400, 'fileId query parameter required');
                    if ((await gate(fileId, true)) === null)
                        return;
                    const removed = await supervisor.removeForFile(fileId, id);
                    if (!removed) {
                        return sendJson(res, 404, { ok: false, error: `unknown trigger: ${id}` });
                    }
                    return sendJson(res, 200, { ok: true });
                }
                if (method === 'POST' && (action === '/enabled' || action === '/grant')) {
                    const body = (await readBody(req));
                    if (!body || typeof body.fileId !== 'string' || body.fileId.length === 0) {
                        return sendError(res, 400, '{ fileId: string, ... } required');
                    }
                    if ((await gate(body.fileId, true)) === null)
                        return;
                    try {
                        if (action === '/enabled') {
                            if (typeof body.enabled !== 'boolean') {
                                return sendError(res, 400, '{ fileId: string, enabled: boolean } required');
                            }
                            const trigger = await supervisor.setEnabledForFile(body.fileId, id, body.enabled);
                            return sendJson(res, 200, { ok: true, trigger });
                        }
                        const trigger = await supervisor.grantForFile(body.fileId, id, principal);
                        return sendJson(res, 200, { ok: true, trigger });
                    }
                    catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        if (msg.startsWith('unknown trigger')) {
                            return sendJson(res, 404, { ok: false, error: msg });
                        }
                        throw e;
                    }
                }
            }
            return sendError(res, 404, `not found: ${method} ${path}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return sendError(res, 500, `automation error: ${msg}`);
        }
    };
}
