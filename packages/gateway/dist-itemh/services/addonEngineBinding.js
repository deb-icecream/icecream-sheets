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
import { AddonAuthError, } from '@icecream-sheets/service';
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
    const headers = () => {
        const h = {
            'content-type': 'application/json',
            'x-principal': opts.principal,
        };
        if (opts.authorization)
            h['authorization'] = opts.authorization;
        return h;
    };
    async function call(path, method, body) {
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: headers(),
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
