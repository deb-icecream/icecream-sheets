/**
 * Production document binding for the add-on service: a DocumentBinding
 * that resolves against the engine service's open workbook over HTTP
 * (design-docs/add-on-model.md §5 — "resolved through the adapter's
 * metadata capabilities").
 *
 * The add-ons service runs in its own process; the open workbook lives in
 * the engine service. Every op the binding performs is an engine-service
 * call made AS THE GRANTING USER (x-principal, plus an engine-access
 * token minted for the user's own session on this document — see
 * createProductionAddonResolveBinding; the caller's gateway JWT is NOT
 * forwarded: in signed mode the engine verifies bearer tokens as
 * engine-access tokens and rejects the 3-part gateway JWT as malformed):
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
import { type AgentSessionRecordSource, type ResolvedAgentSession } from './agentSessionResolver.js';
import type { FileRegistry } from '../deploy/fileRegistry.js';
export interface EngineServiceBindingOptions {
    /** Base URL of the engine service, e.g. http://127.0.0.1:8101. */
    engineBaseUrl: string;
    /** The bound document's id (matches the grant's documentId). */
    documentId: string;
    /** The granting user's principal — enforced by the engine service. */
    principal: string;
    /**
     * Static bearer header value, sent verbatim when no getAuthorization
     * is configured (tests / unsigned deployments). Production wiring
     * uses getAuthorization instead: the gateway JWT must never be
     * forwarded to a signed-mode engine (it is not an engine-access
     * token and verifies as "malformed").
     */
    authorization?: string;
    /**
     * Per-call bearer header value (e.g. "Bearer <engine-access token>").
     * Called fresh for EVERY engine request, so a short-lived token can
     * be re-minted per call and never expires mid-run. Wins over the
     * static `authorization` when both are set. Returning undefined
     * sends no bearer header (unsigned engine: x-principal only).
     */
    getAuthorization?: () => string | undefined | Promise<string | undefined>;
    /** Override for tests. Defaults to global fetch. */
    fetchImpl?: typeof fetch;
}
export declare function createEngineServiceBinding(opts: EngineServiceBindingOptions): DocumentBinding;
export interface ProductionAddonBindingOptions {
    /** Session resolver override (tests). Default: the registry file-scoped resolver. */
    resolveSession?: (principal: string, fileId: string) => Promise<ResolvedAgentSession | null>;
    /** Registry record source override (tests), forwarded to the default resolver. */
    records?: AgentSessionRecordSource;
    /**
     * The session ownership registry the default resolver enumerates
     * (listAll) — the production wiring: in prod the registry is
     * Firestore-backed and there is no on-disk registry file. Forwarded
     * to the default resolver; an explicit `records` source still wins.
     */
    fileRegistry?: FileRegistry;
    /** Env for the registry source + the engine-access secret. Default process.env. */
    env?: NodeJS.ProcessEnv;
    /** Clock override (tests). Default Date.now(). */
    nowMs?: () => number;
    /** Token TTL override (tests). Default ADDON_ENGINE_TOKEN_TTL_SECONDS. */
    tokenTtlSeconds?: number;
}
/**
 * The production resolveBinding shared by bin/addons.ts and the combined
 * service package (servicePackage.ts) — one wiring, by construction.
 *
 * Per /run: resolve the document's LIVE session for the requesting
 * principal from the session ownership registry (file-scoped: the
 * principal must be the session's creator or a recorded participant).
 * No live session → throw, and addonSvc fails the run closed (502):
 * an add-on binds to the OPEN workbook, and a document that is not
 * open has nothing to bind to. The binding targets the session's
 * owning engine endpoint and authenticates with a freshly minted
 * engine-access token scoped { sub: principal, sid, fid, role } —
 * NEVER the caller's gateway JWT (the pre-FIX-R3 wiring forwarded it,
 * and a signed-mode engine rejects it as "malformed"; the original
 * case-11 failure). When no ENGINE_ACCESS_SECRET is configured the
 * binding sends no bearer header — the unsigned-engine contract
 * (x-principal only), identical to the agent path's posture.
 */
export declare function createProductionAddonResolveBinding(engineBaseUrl: string, opts?: ProductionAddonBindingOptions): (documentId: string, reqCtx: {
    principal: string;
    authorization?: string;
}) => Promise<DocumentBinding>;
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
