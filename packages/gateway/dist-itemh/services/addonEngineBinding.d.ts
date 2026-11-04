/**
 * Production document binding for the add-on service: a DocumentBinding
 * that resolves against the engine service's open workbook over HTTP
 * (design-docs/add-on-model.md §5 — "resolved through the adapter's
 * metadata capabilities").
 *
 * The add-ons service runs in its own process; the open workbook lives in
 * the engine service. Every op the binding performs is an engine-service
 * call made AS THE GRANTING USER (x-principal, plus the caller's bearer
 * token forwarded when present):
 * - reads  → POST /read   (host.readCell/readRange: typed view through
 *            authorize() per cell, hidden-cell filtering, #PERM! on denial)
 * - writes → POST /execute (host.execute: cell.write through authorize())
 * - sheets → GET  /snapshot (permission-filtered per principal)
 *
 * That is the same code path the UI uses (RemoteEngineHost calls the same
 * endpoints), and the engine service is the enforcement point for its data:
 * the add-on can only touch what the granting user is allowed to touch —
 * it never elevates. Error values (including #PERM!) and images never cross
 * the add-on boundary: they coerce to null.
 *
 * The add-on worker's op-level authorize() in the add-ons service uses
 * createDelegatingAddonAuthorizer() below: it records every decision with
 * both identities (user principal + addon:<id>) and allows, because
 * object-level enforcement happens inside the binding, in the engine
 * service, with the real principal. The grant + capability gates in
 * AddonService.run()/executeOp() still apply on top.
 */
import { type AuthorizerLike, type DocumentBinding } from '@icecream-sheets/service';
export interface EngineServiceBindingOptions {
    /** Base URL of the engine service, e.g. http://127.0.0.1:8101. */
    engineBaseUrl: string;
    /** The bound document's id (matches the grant's documentId). */
    documentId: string;
    /** The granting user's principal — enforced by the engine service. */
    principal: string;
    /** The caller's bearer token, forwarded so the engine service sees the same auth. */
    authorization?: string;
    /** Override for tests. Defaults to global fetch. */
    fetchImpl?: typeof fetch;
}
export declare function createEngineServiceBinding(opts: EngineServiceBindingOptions): DocumentBinding;
export interface AddonAuthRecord {
    principal: string;
    addonId: string | null;
    action: string;
    target: string;
    allowed: boolean;
    at: string;
}
/**
 * The add-on worker's op-level authorizer for the production (engine-service)
 * binding. Every decision is recorded with both identities — the granting
 * user's principal and the add-on id from the auth context's grants field —
 * and allowed: object-level enforcement is delegated to the engine service,
 * which runs authorize() with the real principal on the same code path the
 * UI uses (host.readCell/readRange/execute). The add-on never elevates
 * beyond the granting user because the binding itself cannot return or
 * write anything the user is not allowed to touch.
 *
 * This is NOT the local-dev allow-all seam: that one records nothing and
 * documents "no enforcement anywhere". Here enforcement is real — it just
 * lives in the binding, one hop away.
 */
export declare function createDelegatingAddonAuthorizer(): AuthorizerLike & {
    auditLog(): AddonAuthRecord[];
};
