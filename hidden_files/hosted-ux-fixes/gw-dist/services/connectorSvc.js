/**
 * Connectors service: the server-side home of the Open Data Source
 * Gallery's secret handling and SQL driver (CONTRACT.md,
 * hidden_files/idea-datasource-gallery).
 *
 * Why server-side: specs NEVER carry secrets (connectors/spec.ts). The
 * browser sends a secret exactly once, over the authenticated gateway
 * route /api/connectors, to this service, which stores it in the vault
 * service (VAULT_URL, default http://127.0.0.1:8102) under a ref derived
 * SERVER-SIDE from the gateway-injected x-principal — the same rule
 * vaultSvc enforces (refs must start with `${principal}:`). From then
 * on only the opaque credentialRef travels: in specs, in bindings, and
 * back here when a query needs the connection string resolved.
 *
 * Endpoints:
 * - GET  /health
 * - POST /credential/store      { name, secret, kind?: 'rest'|'sql' }
 *                               → vault store `${principal}:ds:<kind>:<name>`; { ref }
 * - POST /sql/store-connection  { connection, connectionString }
 *                               → vault store `${principal}:ds:sql:<connection>`; { ref }
 * - POST /sql/tables            { connection } → tables+views from sqlite_master
 * - POST /sql/schema            { connection, table } → PRAGMA table_info + row count
 * - POST /sql/query             { connection, query, params } → { columns, rows, truncated }
 *
 * SQL driver: node:sqlite DatabaseSync, opened READ-ONLY. Statement
 * allowlist (single statement; SELECT / WITH…SELECT / EXPLAIN / read
 * PRAGMA), hard row cap 10_000 with a `truncated` flag. Connection
 * strings: sqlite://<path>, sqlite:<path>, or a bare absolute path —
 * any other scheme is rejected with a clear error (only the sqlite
 * driver ships in this build).
 */
import { createRequire } from 'node:module';
import { handlePreflight, readBody, requestPrincipal, sendError, sendJson } from '../httpUtils.js';
// node:sqlite postdates the Vite/vitest builtin lists in this repo, so a
// static import breaks the test loader ("Failed to load url sqlite").
// Load it through createRequire instead: identical at runtime in the
// built service, invisible to Vite's module resolution.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');
/** Hard cap on rows returned by /sql/query (contract). */
export const SQL_ROW_CAP = 10_000;
/** Names become ref segments: no colons/slashes/whitespace (ref injection guard). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function assertName(value, field) {
    if (typeof value !== 'string' || !NAME_RE.test(value.trim())) {
        throw new HttpError(400, `${field} must be a non-empty name ([A-Za-z0-9._-], no spaces or colons)`);
    }
    return value.trim();
}
/**
 * Resolve a stored connection string to a sqlite filesystem path.
 * Accepted forms: sqlite://<path>, sqlite:<path>, bare absolute path,
 * and ':memory:' (via any sqlite: form). Anything else — postgres://,
 * mysql://, relative paths — is rejected with a clear error.
 */
export function sqlitePathFromConnectionString(connectionString) {
    const cs = connectionString.trim();
    if (cs === '')
        throw new HttpError(400, 'connection string is empty');
    let path;
    if (cs.startsWith('sqlite://')) {
        path = cs.slice('sqlite://'.length);
    }
    else if (cs.startsWith('sqlite:')) {
        path = cs.slice('sqlite:'.length);
    }
    else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(cs) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(cs)) {
        const scheme = cs.slice(0, cs.indexOf(':'));
        throw new HttpError(400, `unsupported connection scheme "${scheme}": only the sqlite driver ships in this build ` +
            '(use sqlite://<path>, sqlite:<path>, or a bare absolute path)');
    }
    else if (cs.startsWith('/')) {
        path = cs;
    }
    else {
        throw new HttpError(400, 'connection string must be sqlite://<path>, sqlite:<path>, or a bare absolute path');
    }
    if (path === '')
        throw new HttpError(400, 'connection string has no database path');
    return path;
}
/** Read-only PRAGMAs allowed through the statement allowlist. */
const READ_PRAGMAS = new Set([
    'table_info',
    'table_xinfo',
    'table_list',
    'database_list',
    'index_list',
    'index_info',
    'index_xinfo',
    'foreign_key_list',
    'foreign_key_check',
    'schema_version',
    'user_version',
    'application_id',
    'encoding',
    'collation_list',
    'function_list',
    'module_list',
    'pragma_list',
]);
/**
 * Strip string literals / quoted identifiers / comments so keyword
 * scanning cannot be fooled by (or falsely trip on) their contents.
 */
function stripLiterals(sql) {
    return sql
        .replace(/--[^\n]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/"(?:[^"]|"")*"/g, '""')
        .replace(/`(?:[^`]|``)*`/g, '``')
        .replace(/\[[^\]]*\]/g, '[]');
}
/**
 * Enforce the read-only statement allowlist. Returns the single
 * statement (one trailing ';' removed). Throws HttpError(400) on
 * multi-statement input or any non-read statement.
 */
export function assertReadOnlyStatement(raw) {
    const sql = raw.trim();
    if (sql === '')
        throw new HttpError(400, 'query is empty');
    const stripped = stripLiterals(sql);
    // Single statement only: a ';' anywhere except as the final character.
    const semi = stripped.indexOf(';');
    if (semi !== -1 && stripped.slice(semi + 1).trim() !== '') {
        throw new HttpError(400, 'only a single statement is allowed');
    }
    const body = sql.replace(/;\s*$/, '').trim();
    const clean = stripLiterals(body);
    const first = /^\s*\(?\s*([A-Za-z]+)/.exec(clean)?.[1]?.toUpperCase() ?? '';
    switch (first) {
        case 'SELECT':
            return body;
        case 'EXPLAIN': {
            // EXPLAIN [QUERY PLAN] <read statement> only.
            const rest = clean.replace(/^\s*EXPLAIN\s+(QUERY\s+PLAN\s+)?/i, '');
            const inner = /^\s*([A-Za-z]+)/.exec(rest)?.[1]?.toUpperCase() ?? '';
            if (inner === 'SELECT' || inner === 'WITH' || inner === 'PRAGMA')
                return body;
            throw new HttpError(400, 'EXPLAIN is only allowed over read statements');
        }
        case 'PRAGMA': {
            const m = /^\s*PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(clean);
            const name = (m?.[1] ?? '').toLowerCase();
            // A PRAGMA with '=' is a write (e.g. PRAGMA user_version=3).
            if (!READ_PRAGMAS.has(name) || /^\s*PRAGMA\b[^()]*=/i.test(clean)) {
                throw new HttpError(400, `PRAGMA ${name || '?'} is not a read pragma`);
            }
            return body;
        }
        case 'WITH': {
            // The main statement verb is the first SELECT/INSERT/UPDATE/DELETE
            // keyword at paren depth 0 after the CTE definitions.
            const verb = mainVerbOfWith(clean);
            if (verb === 'SELECT')
                return body;
            throw new HttpError(400, 'WITH is only allowed when the main statement is a SELECT');
        }
        default:
            throw new HttpError(400, `statement rejected: only read queries are allowed (SELECT / WITH…SELECT / EXPLAIN / read PRAGMA), got "${first || '?'}"`);
    }
}
/** First depth-0 statement verb after a leading WITH's CTE list. */
function mainVerbOfWith(clean) {
    let depth = 0;
    const tokenRe = /\(|\)|[A-Za-z]+/g;
    let m;
    let sawWith = false;
    while ((m = tokenRe.exec(clean)) !== null) {
        const tok = m[0];
        if (tok === '(')
            depth++;
        else if (tok === ')')
            depth--;
        else if (depth === 0) {
            const kw = tok.toUpperCase();
            if (!sawWith) {
                if (kw === 'WITH')
                    sawWith = true;
                continue;
            }
            if (kw === 'SELECT' || kw === 'INSERT' || kw === 'UPDATE' || kw === 'DELETE')
                return kw;
        }
    }
    return '';
}
/** Convert a node:sqlite value to the SqlRow JSON shape. */
function cellValue(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === 'string' || typeof v === 'boolean')
        return v;
    if (typeof v === 'number')
        return v;
    if (typeof v === 'bigint')
        return Number(v);
    return null; // BLOBs are not part of the table contract.
}
function openReadOnly(path) {
    try {
        return new DatabaseSync(path, { readOnly: true });
    }
    catch (e) {
        throw new HttpError(400, `cannot open sqlite database: ${e instanceof Error ? e.message : String(e)}`);
    }
}
export function createConnectorListener(opts = {}) {
    const vaultUrl = (opts.vaultUrl ?? process.env.VAULT_URL ?? 'http://127.0.0.1:8102').replace(/\/+$/, '');
    /** Call the vault service as the requesting principal (x-principal forwarded). */
    async function vaultCall(principal, path, body) {
        let res;
        try {
            res = await fetch(`${vaultUrl}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-principal': principal },
                body: JSON.stringify(body),
            });
        }
        catch (e) {
            throw new HttpError(502, `vault service unreachable: ${e instanceof Error ? e.message : String(e)}`);
        }
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        }
        catch {
            json = null;
        }
        if (!res.ok) {
            throw new HttpError(res.status, json?.error ?? `vault ${path} failed: HTTP ${res.status}`);
        }
        return json;
    }
    async function vaultStore(principal, ref, secret) {
        await vaultCall(principal, '/store', { ref, secret });
    }
    async function vaultRetrieve(principal, ref) {
        const json = (await vaultCall(principal, '/retrieve', { ref }));
        if (typeof json?.secret !== 'string')
            throw new HttpError(502, 'vault returned no secret');
        return json.secret;
    }
    /** Resolve a connection NAME to its sqlite path via the vault. */
    async function connectionPath(principal, connection) {
        const ref = `${principal}:ds:sql:${connection}`;
        let cs;
        try {
            cs = await vaultRetrieve(principal, ref);
        }
        catch (e) {
            if (e instanceof HttpError && e.status === 404) {
                throw new HttpError(404, `unknown connection "${connection}": store it first via /sql/store-connection`);
            }
            throw e;
        }
        return sqlitePathFromConnectionString(cs);
    }
    return async (req, res) => {
        if (handlePreflight(req, res))
            return;
        const url = new URL(req.url ?? '/', 'http://connectors');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const principal = requestPrincipal(req);
        try {
            if (path === '/health' && method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'connectors' });
            }
            if (path === '/credential/store' && method === 'POST') {
                const body = (await readBody(req));
                const name = assertName(body?.name, 'name');
                if (typeof body?.secret !== 'string' || body.secret.length === 0) {
                    throw new HttpError(400, 'secret must be a non-empty string');
                }
                const kind = body?.kind === undefined ? 'rest' : body.kind;
                if (kind !== 'rest' && kind !== 'sql') {
                    throw new HttpError(400, "kind must be 'rest' or 'sql'");
                }
                const ref = `${principal}:ds:${kind}:${name}`;
                await vaultStore(principal, ref, body.secret);
                return sendJson(res, 200, { ok: true, ref });
            }
            if (path === '/sql/store-connection' && method === 'POST') {
                const body = (await readBody(req));
                const connection = assertName(body?.connection, 'connection');
                if (typeof body?.connectionString !== 'string' || body.connectionString.trim() === '') {
                    throw new HttpError(400, 'connectionString must be a non-empty string');
                }
                // Validate the scheme eagerly so a bad string fails at store time.
                sqlitePathFromConnectionString(body.connectionString);
                const ref = `${principal}:ds:sql:${connection}`;
                await vaultStore(principal, ref, body.connectionString);
                return sendJson(res, 200, { ok: true, ref });
            }
            if (path === '/sql/tables' && method === 'POST') {
                const body = (await readBody(req));
                const connection = assertName(body?.connection, 'connection');
                const db = openReadOnly(await connectionPath(principal, connection));
                try {
                    const rows = db
                        .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
                        .all();
                    return sendJson(res, 200, {
                        ok: true,
                        tables: rows.map((r) => ({ name: r.name, type: r.type })),
                    });
                }
                finally {
                    db.close();
                }
            }
            if (path === '/sql/schema' && method === 'POST') {
                const body = (await readBody(req));
                const connection = assertName(body?.connection, 'connection');
                if (typeof body?.table !== 'string' || body.table.trim() === '') {
                    throw new HttpError(400, 'table must be a non-empty string');
                }
                const table = body.table.trim();
                const db = openReadOnly(await connectionPath(principal, connection));
                try {
                    const quoted = `"${table.replace(/"/g, '""')}"`;
                    const cols = db.prepare(`PRAGMA table_info(${quoted})`).all();
                    if (cols.length === 0)
                        throw new HttpError(404, `unknown table "${table}"`);
                    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get();
                    return sendJson(res, 200, {
                        ok: true,
                        table,
                        columns: cols.map((c) => ({
                            name: c.name,
                            type: c.type || 'TEXT',
                            notnull: c.notnull === 1,
                            pk: c.pk > 0,
                        })),
                        rowCount: Number(countRow.n),
                    });
                }
                finally {
                    db.close();
                }
            }
            if (path === '/sql/query' && method === 'POST') {
                const body = (await readBody(req));
                const connection = assertName(body?.connection, 'connection');
                if (typeof body?.query !== 'string')
                    throw new HttpError(400, 'query must be a string');
                const params = body?.params === undefined ? [] : body.params;
                if (!Array.isArray(params))
                    throw new HttpError(400, 'params must be an array');
                const statement = assertReadOnlyStatement(body.query);
                const db = openReadOnly(await connectionPath(principal, connection));
                try {
                    const stmt = db.prepare(statement);
                    const columns = stmt.columns().map((c) => c.name);
                    const rawRows = stmt.all(...params);
                    const truncated = rawRows.length > SQL_ROW_CAP;
                    const rows = rawRows.slice(0, SQL_ROW_CAP).map((r) => {
                        const out = {};
                        for (const c of columns)
                            out[c] = cellValue(r[c]);
                        return out;
                    });
                    return sendJson(res, 200, { ok: true, columns, rows, truncated });
                }
                catch (e) {
                    if (e instanceof HttpError)
                        throw e;
                    throw new HttpError(400, `query failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                finally {
                    db.close();
                }
            }
            return sendError(res, 404, `not found: ${path}`);
        }
        catch (e) {
            if (e instanceof HttpError)
                return sendError(res, e.status, e.message);
            const msg = e instanceof Error ? e.message : String(e);
            return sendError(res, 500, `connectors error: ${msg}`);
        }
    };
}
