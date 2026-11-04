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
 * Record source: by default the LOCAL registry file
 * (<FILE_REGISTRY_DIR>/file-registry.json, see fileRegistryDir()) is read
 * fresh on every resolve — the agent process and the engine/gateway
 * processes share that directory in the local topology, and a fresh read
 * means a session opened a second ago is visible without any caching or
 * invalidation protocol. The source is injectable for tests and for a
 * future prod (Firestore) listing adapter; the FileRegistry interface
 * itself is point-lookup only (lookup by fileId), so enumeration lives
 * here, not there.
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
function fallbackEngineUrl(opts) {
    const env = opts.env ?? process.env;
    return (opts.fallbackEngineUrl ??
        ((env.ENGINE_PUBLIC_URL ?? '').trim() || 'http://127.0.0.1:8101')).replace(/\/+$/, '');
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
    const fallback = fallbackEngineUrl(opts);
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
    const engineUrl = ((rec.ownerEndpoint ?? '').trim() || fallback).replace(/\/+$/, '');
    if (engineUrl.length === 0)
        return null;
    return {
        fileId: rec.fileId,
        sessionId: rec.sessionId,
        engineUrl,
        ownershipEpoch: rec.ownershipEpoch,
        creatorPrincipal: rec.creatorPrincipal,
        currentRevision: typeof rec.currentRevision === 'number' && Number.isFinite(rec.currentRevision)
            ? rec.currentRevision
            : 0,
        updatedAt: rec.updatedAt,
    };
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
/** Build the resolver the agent service uses per /message. */
export function createAgentSessionResolver(opts = {}) {
    return async (principal) => {
        let records;
        if (opts.records === undefined) {
            records = readLocalRegistryRecords(opts.env ?? process.env);
        }
        else if (typeof opts.records === 'function') {
            records = await opts.records();
        }
        else {
            records = opts.records;
        }
        return pickActiveSession(records, principal, opts);
    };
}
