/**
 * Add-on service: the add-on component behind HTTP (design-docs/add-on-model.md).
 *
 * Exposes the production add-on runtime through the web-service boundary:
 * - runtime: install / enable / disable / uninstall / run
 * - catalog: the product-owned catalog (code stripped — the service holds it
 *   for install; clients never need the source bytes)
 * - grant flow: request → approve / deny → revoke / narrow, per-document
 *   capability grants recorded with who and when
 *
 * Trust model: the gateway verifies the JWT and forwards the principal as
 * `x-principal`; every op here is attributed to that principal
 * (requestedBy / decidedBy / run principal). The install-time signature
 * verifier from createProductionAddonService() is always active, so unsigned
 * manifests fail closed at install (production.ts) — there is no
 * user-facing sideload path.
 *
 * Local-dev seams (documented, fail closed):
 * - The document binding for /run resolves through deps.resolveBinding in
 *   production (add-on-model.md §5): the add-on service's deployment wiring
 *   (bin/addons.ts, startAllLocal) points it at the engine service's open
 *   workbook via addonEngineBinding.ts, so the add-on reads/writes real
 *   document data through authorize(). When no resolver is configured —
 *   tests and bare-listener dev use only — /run falls back to an in-memory
 *   grid seeded from the request's `sheets` field.
 * - The authorizer passed to run() allows everything locally. The
 *   capability gate in AddonService.run() still applies (an add-on without
 *   the write capability cannot write), but object-level authorization must
 *   be wired to the real host authorizer in prod. The production wiring
 *   uses createDelegatingAddonAuthorizer(): every decision is audit-logged
 *   with both identities, and object-level enforcement happens inside the
 *   engine-service binding with the real principal.
 *
 * Endpoints:
 * - GET  /health
 * - GET  /catalog                          → { listings }
 * - GET  /installed                        → { installed }
 * - POST /install      { id, version? }     → install from catalog
 * - POST /enable       { id }
 * - POST /disable      { id }
 * - POST /uninstall    { id }               → { ok, removed, grantsPurged }
 * - GET  /grants?addonId=&documentId=       → { grants }
 * - POST /grants/request { addonId, documentId, capabilities }
 * - POST /grants/approve { id }
 * - POST /grants/deny    { id }
 * - POST /grants/revoke  { id }
 * - POST /grants/narrow  { id, capabilities }
 * - POST /run { addonId, documentId, args?, entry?, limits?, sheets? }
 *                                          → { ok, value } | { ok, error, code }
 *   (`sheets` seeds the local-dev in-memory binding and is ignored when a
 *   production resolveBinding is configured.)
 */
import { createMemoryBinding, createProductionAddonService, validateCapability, } from '@icecream-sheets/service';
import { handlePreflight, readBody, requestPrincipal, sendError, sendJson } from '../httpUtils.js';
/** Local-dev authorizer: allows everything (see header comment). */
const ALLOW_ALL_AUTHORIZER = {
    authorize: () => true,
};
/** Listing with the source bytes stripped (clients never need them). */
function publicListing(l) {
    const { code: _code, ...rest } = l;
    void _code;
    return rest;
}
/** Stored add-on with the source bytes stripped. */
function publicStored(s) {
    const { code: _code, ...rest } = s;
    void _code;
    return rest;
}
function isNonEmptyString(x) {
    return typeof x === 'string' && x.length > 0;
}
function validateCapabilities(input) {
    if (!Array.isArray(input) || input.length === 0) {
        return { ok: false, error: 'capabilities must be a non-empty array' };
    }
    const errors = [];
    input.forEach((c, i) => errors.push(...validateCapability(c, `capabilities[${i}]`)));
    if (errors.length > 0)
        return { ok: false, error: errors.join('; ') };
    return { ok: true, capabilities: input };
}
/** The `sheets` seed for /run: Record<sheetName, grid of CellValue>. */
function validateSheetsSeed(input) {
    if (input === undefined)
        return { ok: true, sheets: {} };
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, error: 'sheets must be an object of sheet-name → grid rows' };
    }
    const out = {};
    for (const [name, grid] of Object.entries(input)) {
        if (name.length === 0)
            return { ok: false, error: 'sheets: sheet names must be non-empty' };
        if (!Array.isArray(grid) || !grid.every((row) => Array.isArray(row))) {
            return { ok: false, error: `sheets["${name}"]: must be an array of rows (each an array of cell values)` };
        }
        out[name] = grid;
    }
    return { ok: true, sheets: out };
}
export function createAddonListener(deps = {}) {
    const authorizer = deps.authorizer ?? ALLOW_ALL_AUTHORIZER;
    // Production service bootstrap is async (Ed25519 init); build it lazily and
    // cache the promise. A failed init fails closed: every endpoint 503s
    // instead of serving an unsigned-runtime (mirrors the desktop main.ts
    // behavior of disabling installs when init fails).
    let servicePromise = deps.service
        ? Promise.resolve(deps.service)
        : null;
    async function service() {
        if (!servicePromise) {
            servicePromise = createProductionAddonService().catch((e) => {
                // Reset so a later request can retry the init; the rejection below
                // makes this request 503.
                servicePromise = null;
                throw e;
            });
        }
        return servicePromise;
    }
    return async (req, res) => {
        if (handlePreflight(req, res))
            return;
        const url = new URL(req.url ?? '/', 'http://addons');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const principal = requestPrincipal(req, 'user');
        let svc;
        try {
            svc = await service();
        }
        catch (e) {
            return sendError(res, 503, `add-on service unavailable: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
            if (path === '/health' && method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'addons' });
            }
            // -- catalog --------------------------------------------------------
            if (path === '/catalog' && method === 'GET') {
                return sendJson(res, 200, { listings: svc.listCatalog().map(publicListing) });
            }
            // -- installed ------------------------------------------------------
            if (path === '/installed' && method === 'GET') {
                return sendJson(res, 200, { installed: svc.listInstalled().map(publicStored) });
            }
            // -- lifecycle ------------------------------------------------------
            if (path === '/install' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                if (body.version !== undefined && !isNonEmptyString(body.version)) {
                    return sendError(res, 400, 'version, when given, must be a non-empty string');
                }
                try {
                    const stored = svc.installFromCatalog(body.id, body.version ?? undefined);
                    return sendJson(res, 200, { ok: true, addon: publicStored(stored) });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/enable' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                try {
                    const stored = svc.enableAddon(body.id);
                    return sendJson(res, 200, { ok: true, addon: publicStored(stored) });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/disable' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                try {
                    const stored = svc.disableAddon(body.id);
                    return sendJson(res, 200, { ok: true, addon: publicStored(stored) });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/uninstall' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                const { removed, grantsPurged } = svc.uninstallAddon(body.id);
                return sendJson(res, 200, { ok: true, removed, grantsPurged });
            }
            // -- grants ----------------------------------------------------------
            if (path === '/grants' && method === 'GET') {
                const addonId = url.searchParams.get('addonId');
                const documentId = url.searchParams.get('documentId');
                const grants = svc.grants.list().filter((g) => (addonId === null || g.addonId === addonId) && (documentId === null || g.documentId === documentId));
                return sendJson(res, 200, { grants });
            }
            if (path === '/grants/request' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.addonId))
                    return sendError(res, 400, '{ addonId: string } required');
                if (!isNonEmptyString(body?.documentId))
                    return sendError(res, 400, '{ documentId: string } required');
                const caps = validateCapabilities(body?.capabilities);
                if (!caps.ok)
                    return sendError(res, 400, caps.error);
                try {
                    const grant = svc.requestGrant(body.addonId, body.documentId, caps.capabilities, principal);
                    return sendJson(res, 200, { ok: true, grant });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/grants/approve' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                try {
                    const grant = svc.approveGrant(body.id, principal);
                    return sendJson(res, 200, { ok: true, grant });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/grants/deny' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                try {
                    const grant = svc.denyGrant(body.id, principal);
                    return sendJson(res, 200, { ok: true, grant });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/grants/revoke' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                try {
                    const grant = svc.revokeGrant(body.id, principal);
                    return sendJson(res, 200, { ok: true, grant });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            if (path === '/grants/narrow' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.id))
                    return sendError(res, 400, '{ id: string } required');
                const caps = validateCapabilities(body?.capabilities);
                if (!caps.ok)
                    return sendError(res, 400, caps.error);
                try {
                    const grant = svc.narrowGrant(body.id, caps.capabilities, principal);
                    return sendJson(res, 200, { ok: true, grant });
                }
                catch (e) {
                    return sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
            }
            // -- run -------------------------------------------------------------
            if (path === '/run' && method === 'POST') {
                const body = (await readBody(req));
                if (!isNonEmptyString(body?.addonId))
                    return sendError(res, 400, '{ addonId: string } required');
                if (!isNonEmptyString(body?.documentId))
                    return sendError(res, 400, '{ documentId: string } required');
                if (body?.entry !== undefined && !isNonEmptyString(body.entry)) {
                    return sendError(res, 400, 'entry, when given, must be a non-empty string');
                }
                let binding;
                if (deps.resolveBinding) {
                    // Production path (§5): resolve the document binding through the
                    // adapter's metadata capabilities — the add-on reads/writes the
                    // real open workbook. Resolver failures fail closed.
                    try {
                        const authz = req.headers['authorization'];
                        binding = await deps.resolveBinding(body.documentId, {
                            principal,
                            authorization: typeof authz === 'string' ? authz : undefined,
                        });
                    }
                    catch (e) {
                        return sendError(res, 502, `document binding unavailable: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                else {
                    // Local-dev seam (documented): in-memory grid seeded from the
                    // request's `sheets` field. Production wiring always provides
                    // resolveBinding, so this never serves real traffic.
                    const seed = validateSheetsSeed(body?.sheets);
                    if (!seed.ok)
                        return sendError(res, 400, seed.error);
                    binding = createMemoryBinding(body.documentId, 
                    // CellValue is string | number | boolean | null; the worker path
                    // treats anything else as unreadable, so pass the grid through.
                    seed.sheets);
                }
                const result = await svc.run({
                    addonId: body.addonId,
                    binding,
                    args: body?.args,
                    entry: isNonEmptyString(body?.entry) ? body.entry : undefined,
                    limits: body?.limits ?? undefined,
                }, { principal, authorizer });
                // run() never throws: preconditions fail closed as a result payload.
                if (!result.ok) {
                    return sendError(res, result.code === 'auth' ? 403 : 400, result.error, { code: result.code });
                }
                return sendJson(res, 200, { ok: true, value: result.value });
            }
            return sendError(res, 404, `not found: ${path}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return sendError(res, 500, `addons error: ${msg}`);
        }
    };
}
