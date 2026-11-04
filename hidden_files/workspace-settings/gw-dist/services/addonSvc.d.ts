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
import type { RequestListener } from 'node:http';
import { AddonService, type AuthorizerLike, type DocumentBinding } from '@icecream-sheets/service';
export interface AddonServiceDeps {
    /** Override for tests (in-memory, no signature enforcement). */
    service?: AddonService;
    /**
     * Host authorizer for run(). Defaults to a local-dev allow-all; prod
     * wires the real host authorizer so the add-on never elevates beyond the
     * granting user's permissions (add-on-model.md §5).
     */
    authorizer?: AuthorizerLike;
    /**
     * Production document-binding resolver (add-on-model.md §5: "resolved
     * through the adapter's metadata capabilities"). Called on every /run
     * with the request's documentId and the gateway-verified principal; the
     * returned binding is what the add-on's data requests execute against.
     * The production wiring resolves to the engine service's open workbook
     * (see addonEngineBinding.ts). When absent, /run falls back to the
     * local-dev seam: an in-memory grid seeded from the request's `sheets`
     * field. A resolver failure fails the run closed — there is no silent
     * fallback to the seed grid.
     */
    resolveBinding?: (documentId: string, reqCtx: {
        principal: string;
        authorization?: string;
    }) => DocumentBinding | Promise<DocumentBinding>;
}
export declare function createAddonListener(deps?: AddonServiceDeps): RequestListener;
