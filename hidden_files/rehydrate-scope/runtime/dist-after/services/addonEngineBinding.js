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
import { AddonAuthError, } from '@icecream-sheets/service';
import { engineAccessSecret, issueEngineAccessToken, } from '../deploy/engineAccess.js';
import { createFileSessionResolver, } from './agentSessionResolver.js';
/** Coerce an engine-service TypedValue to a CellValue. Errors/images → null. */
function toCellValue(v) {
    if (v !== null && typeof v === 'object') {
        const tv = v;
        if ((tv.kind === 'number' || tv.kind === 'string' || tv.kind === 'boolean' || tv.kind === 'null') &&
            (tv.value === null ||
                typeof tv.value === 'string' ||
                typeof tv.value === 'number' ||
                typeof tv.value === 'boolean')) {
            return tv.value;
        }
    }
    // 'error' (incl. #PERM! from authorize()/hidden checks) and 'image':
    // never cross the add-on boundary.
    return null;
}
export function createEngineServiceBinding(opts) {
    const base = opts.engineBaseUrl.replace(/\/+$/, '');
    const fetchImpl = opts.fetchImpl ?? fetch;
    const headers = async () => {
        const h = {
            'content-type': 'application/json',
            'x-principal': opts.principal,
        };
        const authz = opts.getAuthorization
            ? await opts.getAuthorization()
            : opts.authorization;
        if (authz)
            h['authorization'] = authz;
        return h;
    };
    async function call(path, method, body) {
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: await headers(),
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        }
        catch (e) {
            throw new AddonAuthError('denied', `engine service unreachable: ${e.message}`);
        }
        let json = null;
        try {
            json = await res.json();
        }
        catch {
            // leave null
        }
        if (!res.ok) {
            const msg = json !== null && typeof json === 'object' && 'error' in json
                ? String(json.error)
                : `engine service ${res.status}`;
            throw new AddonAuthError('denied', msg);
        }
        return json;
    }
    const cellRef = (a) => ({ sheet: a.sheet, row: a.row, col: a.col });
    async function writeOne(sheet, row, col, value) {
        const result = (await call('/execute', 'POST', {
            cmd: { cmd: 'setCell', ref: { sheet, row, col }, value },
        }));
        // The engine service stamps the real principal into cmd.auth and runs
        // authorize('cell.write', ...) — a denial arrives here as { ok: false }.
        if (!result || result.ok !== true) {
            throw new AddonAuthError('denied', `engine refused write: ${typeof result?.error === 'string' ? result.error : 'unknown'}`);
        }
    }
    return {
        documentId: opts.documentId,
        listSheets: async () => {
            const snap = (await call('/snapshot', 'GET'));
            return (snap.sheets ?? []).map((s) => String(s.name ?? ''));
        },
        readCell: async (a) => {
            const out = (await call('/read', 'POST', { kind: 'cell', ref: cellRef(a) }));
            return toCellValue(out?.value);
        },
        readRange: async (r) => {
            const out = (await call('/read', 'POST', {
                kind: 'range',
                range: {
                    sheet: r.sheet,
                    startRow: r.startRow,
                    startCol: r.startCol,
                    endRow: r.endRow,
                    endCol: r.endCol,
                },
            }));
            const values = out?.values ?? [];
            return values.map((row) => row.map(toCellValue));
        },
        writeCell: async (a, value) => {
            await writeOne(a.sheet, a.row, a.col, value);
        },
        writeRange: async (r, values) => {
            for (let i = 0; i < values.length; i++) {
                const rowVals = values[i];
                for (let j = 0; j < rowVals.length; j++) {
                    await writeOne(r.sheet, r.startRow + i, r.startCol + j, rowVals[j]);
                }
            }
        },
    };
}
// ---------------------------------------------------------------------------
// Production /run binding resolver (FIX-R3)
// ---------------------------------------------------------------------------
/**
 * Engine-access tokens for add-on runs: SHORT-lived (2 min, the agent
 * path's TTL) and re-minted on EVERY engine call by the binding's
 * getAuthorization callback — never cached, never logged. The role is
 * the granting user's OWN session role from the registry record: the
 * add-on acts as the user (add-on-model.md §5), so a user who joined
 * the document as a viewer gets a viewer-scoped token and the engine
 * refuses its writes ('viewer-role'), while their reads still work.
 */
const ADDON_ENGINE_TOKEN_TTL_SECONDS = 120;
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
export function createProductionAddonResolveBinding(engineBaseUrl, opts = {}) {
    const env = opts.env ?? process.env;
    const resolveSession = opts.resolveSession ??
        createFileSessionResolver({
            records: opts.records,
            registry: opts.fileRegistry,
            env,
            nowMs: opts.nowMs,
        });
    const ttlSeconds = opts.tokenTtlSeconds ?? ADDON_ENGINE_TOKEN_TTL_SECONDS;
    return async (documentId, reqCtx) => {
        const session = await resolveSession(reqCtx.principal, documentId);
        if (!session) {
            throw new Error(`no live engine session for document ${documentId} for this user (open the document first)`);
        }
        const principal = reqCtx.principal;
        return createEngineServiceBinding({
            engineBaseUrl: session.engineUrl || engineBaseUrl,
            documentId,
            principal,
            getAuthorization: () => {
                const secret = engineAccessSecret(env);
                if (!secret)
                    return undefined;
                return `Bearer ${issueEngineAccessToken({
                    secret,
                    principal,
                    sessionId: session.sessionId,
                    fid: documentId,
                    role: session.role,
                    tier: 'standard',
                    ttlSeconds,
                }).token}`;
            },
        });
    };
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
export function createDelegatingAddonAuthorizer() {
    const log = [];
    const authorizer = {
        authorize(action, target, ctx) {
            if (!ctx || typeof ctx.principal !== 'string' || ctx.principal.length === 0) {
                throw new Error('authorize: missing principal (fail closed)');
            }
            const addonId = ctx.grants?.find((g) => g.startsWith('addon:'))?.slice('addon:'.length) ?? null;
            log.push({
                principal: ctx.principal,
                addonId,
                action,
                target,
                allowed: true,
                at: new Date().toISOString(),
            });
            return true;
        },
    };
    return Object.assign(authorizer, {
        auditLog: () => [...log],
    });
}
