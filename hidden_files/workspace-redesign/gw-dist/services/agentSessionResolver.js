/**
 * Agent ↔ workbook session resolver (FIX-B / F1, design-docs/ai-agent.md
 * §§2–3: the agent acts as the user, through MCP, on the user's workbook).
 *
 * In gateway mode the workbook the user is looking at lives in the ENGINE
 * service as a live session. The session ownership registry
 * (deploy/fileRegistry.ts, revision-model §9) is the authority on which
 * sessions are live and who they belong to: one record per file with
 * { fileId, sessionId, ownerInstance, ownerEndpoint, leaseExpiry,
 *   ownershipEpoch, currentRevision, storedRevision, updatedAt,
 *   creatorPrincipal }.
 *
 * This resolver answers one question for the agent service: "what is
 * THIS principal's active session?" — a record whose lease is still live
 * (isLiveOwner), whose creatorPrincipal is the principal (or which lists
 * the principal as a participant, when a record carries participants),
 * most recently updated first. No match → null, and the agent keeps its
 * private-host fallback (pre-F1 behavior).
 *
 * The file-scoped variant (pickSessionForFile / createFileSessionResolver,
 * FIX-R3) answers the add-on binding's question — "what is THIS
 * principal's live session on THIS file?" — with the same liveness,
 * principal-match and role rules.
 *
 * Record source: by default the LOCAL registry file
 * (<FILE_REGISTRY_DIR>/file-registry.json, see fileRegistryDir()) is read
 * fresh on every resolve — the agent process and the engine/gateway
 * processes share that directory in the local topology, and a fresh read
 * means a session opened a second ago is visible without any caching or
 * invalidation protocol. In production the registry is Firestore-backed
 * and there is no shared registry file: the resolvers then take the
 * FileRegistry itself (opts.registry) and enumerate it via its
 * listAll() — every adapter (Local / Memory / Firestore) lists with the
 * same semantics, and the liveness + principal filters below apply
 * identically to records from any source, so dead-lease records are
 * excluded exactly as they are for the local file. An explicit record
 * source (opts.records, tests) still wins over both.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileRegistryDir, isLiveOwner, } from '../deploy/fileRegistry.js';
/** Principals recorded as participants on a record, in any carried shape. */
export function participantPrincipals(rec) {
    const p = rec.participants;
    if (Array.isArray(p)) {
        const out = [];
        for (const entry of p) {
            if (typeof entry === 'string' && entry.length > 0)
                out.push(entry);
            else if (entry !== null &&
                typeof entry === 'object' &&
                typeof entry.principal === 'string') {
                out.push(entry.principal);
            }
        }
        return out;
    }
    if (p !== null && typeof p === 'object')
        return Object.keys(p);
    return [];
}
/** True when the principal created the session or is a recorded participant. */
export function recordMatchesPrincipal(rec, principal) {
    return rec.creatorPrincipal === principal || participantPrincipals(rec).includes(principal);
}
function asRole(v) {
    return v === 'editor' || v === 'viewer' ? v : null;
}
/**
 * The role a record assigns to a participant, or null when the record
 * lists the participant without a usable role (bare string entries and
 * { principal } objects without a role — written before roles were
 * recorded). Map shape: { principal: 'editor' | 'viewer' }.
 */
export function participantRole(rec, principal) {
    const p = rec.participants;
    if (Array.isArray(p)) {
        for (const entry of p) {
            if (entry !== null && typeof entry === 'object') {
                const e = entry;
                if (e.principal === principal)
                    return asRole(e.role);
            }
        }
        return null;
    }
    if (p !== null && typeof p === 'object') {
        return asRole(p[principal]);
    }
    return null;
}
/**
 * The role the resolved session carries FOR THIS PRINCIPAL: creator →
 * 'editor'; participant → their recorded role, defaulting to 'viewer'
 * when the record carries none (fail-safe — see ResolvedAgentSession).
 */
export function roleForPrincipal(rec, principal) {
    if (rec.creatorPrincipal === principal)
        return 'editor';
    return participantRole(rec, principal) ?? 'viewer';
}
function fallbackEngineUrl(opts) {
    const env = opts.env ?? process.env;
    return (opts.fallbackEngineUrl ??
        ((env.ENGINE_PUBLIC_URL ?? '').trim() || 'http://127.0.0.1:8101')).replace(/\/+$/, '');
}
/** Shape one selected record into the resolved session for a principal. */
function toResolvedSession(rec, principal, opts) {
    const engineUrl = ((rec.ownerEndpoint ?? '').trim() || fallbackEngineUrl(opts)).replace(/\/+$/, '');
    if (engineUrl.length === 0)
        return null;
    return {
        fileId: rec.fileId,
        sessionId: rec.sessionId,
        engineUrl,
        ownershipEpoch: rec.ownershipEpoch,
        creatorPrincipal: rec.creatorPrincipal,
        role: roleForPrincipal(rec, principal),
        currentRevision: typeof rec.currentRevision === 'number' && Number.isFinite(rec.currentRevision)
            ? rec.currentRevision
            : 0,
        updatedAt: rec.updatedAt,
    };
}
/**
 * Pure selection: from candidate records pick the principal's active
 * session — live lease, principal is creator/participant, most recently
 * updated wins (ownershipEpoch breaks ties: a re-claimed session is
 * newer than the record it replaced). Records without a usable session
 * id / file id / engine endpoint never resolve.
 */
export function pickActiveSession(records, principal, opts = {}) {
    const now = (opts.nowMs ?? Date.now)();
    const candidates = [];
    for (const rec of records) {
        if (!rec || typeof rec !== 'object')
            continue;
        if (typeof rec.fileId !== 'string' || rec.fileId.length === 0)
            continue;
        if (typeof rec.sessionId !== 'string' || rec.sessionId.length === 0)
            continue;
        if (!isLiveOwner(rec, now))
            continue;
        if (!recordMatchesPrincipal(rec, principal))
            continue;
        candidates.push(rec);
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt || b.ownershipEpoch - a.ownershipEpoch);
    const rec = candidates[0];
    if (!rec)
        return null;
    return toResolvedSession(rec, principal, opts);
}
/**
 * File-scoped selection (FIX-R3): the principal's live session FOR ONE
 * FILE — the question the add-on document binding asks ("which session
 * hosts THIS document, and what is this user's role in it?"). Same
 * liveness and principal-match rules as pickActiveSession; the registry
 * holds one record per file, so at most one candidate is expected —
 * ownershipEpoch/updatedAt ordering only guards legacy duplicates.
 * A principal who neither created nor participates in the file's
 * session resolves to null (the add-on acts as the user; a user with
 * no session on the document has nothing to bind to).
 */
export function pickSessionForFile(records, principal, fileId, opts = {}) {
    const now = (opts.nowMs ?? Date.now)();
    const candidates = [];
    for (const rec of records) {
        if (!rec || typeof rec !== 'object')
            continue;
        if (rec.fileId !== fileId)
            continue;
        if (typeof rec.sessionId !== 'string' || rec.sessionId.length === 0)
            continue;
        if (!isLiveOwner(rec, now))
            continue;
        if (!recordMatchesPrincipal(rec, principal))
            continue;
        candidates.push(rec);
    }
    candidates.sort((a, b) => b.ownershipEpoch - a.ownershipEpoch || b.updatedAt - a.updatedAt);
    const rec = candidates[0];
    if (!rec)
        return null;
    return toResolvedSession(rec, principal, opts);
}
/**
 * Default record source: the local registry file. A missing file is an
 * empty registry (no sessions — not an error). A corrupt file THROWS:
 * the registry elsewhere fails closed on corruption, and the caller
 * (agentSvc) treats a resolver throw as "no binding" rather than risk
 * binding the agent to a session read from ambiguous state.
 */
export function readLocalRegistryRecords(env = process.env) {
    const file = join(fileRegistryDir(env), 'file-registry.json');
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (e) {
        if (e?.code === 'ENOENT')
            return [];
        throw e;
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('agent session resolver: corrupt file registry (fail closed)');
    }
    return Object.values(parsed);
}
/** Load the candidate records from the configured source. */
async function loadRecords(opts) {
    if (opts.records === undefined) {
        if (opts.registry !== undefined) {
            return await opts.registry.listAll();
        }
        return readLocalRegistryRecords(opts.env ?? process.env);
    }
    if (typeof opts.records === 'function') {
        return await opts.records();
    }
    return opts.records;
}
/** Build the resolver the agent service uses per /message. */
export function createAgentSessionResolver(opts = {}) {
    return async (principal) => {
        return pickActiveSession(await loadRecords(opts), principal, opts);
    };
}
/**
 * Build the file-scoped resolver the add-on binding uses per /run:
 * (principal, fileId) → that file's live session for the principal,
 * or null when the document is not open in a session the principal
 * belongs to.
 */
export function createFileSessionResolver(opts = {}) {
    return async (principal, fileId) => {
        return pickSessionForFile(await loadRecords(opts), principal, fileId, opts);
    };
}
