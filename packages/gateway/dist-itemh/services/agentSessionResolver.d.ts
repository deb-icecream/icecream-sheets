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
import { type FileRegistryRecord } from '../deploy/fileRegistry.js';
/**
 * A registry record as read from disk. Identical to FileRegistryRecord,
 * plus an OPTIONAL participants list: today's writer (gateway /api/engine/
 * open) does not record participants in the registry (they live in the
 * engine's in-memory session state), but a record that carries them —
 * as strings, { principal } objects, or a principal→role map — is honored.
 */
export interface AgentSessionRecord extends FileRegistryRecord {
    participants?: unknown;
}
/** The principal's active session, ready to bind a remote host to. */
export interface ResolvedAgentSession {
    fileId: string;
    sessionId: string;
    /** The owning engine instance's base URL (record's ownerEndpoint). */
    engineUrl: string;
    /** Fencing token from the registry record (§9). */
    ownershipEpoch: number;
    creatorPrincipal: string;
    /** Registry revision counters at resolve time (host seed). */
    currentRevision: number;
    updatedAt: number;
}
export type AgentSessionRecordSource = Iterable<AgentSessionRecord> | (() => Iterable<AgentSessionRecord> | Promise<Iterable<AgentSessionRecord>>);
export interface AgentSessionResolverOptions {
    /** Record source override (tests / future prod adapter). Default: local registry file. */
    records?: AgentSessionRecordSource;
    /** Env for the default record source + fallback engine URL. Default process.env. */
    env?: NodeJS.ProcessEnv;
    /** Clock override (tests). Default Date.now(). */
    nowMs?: () => number;
    /**
     * Engine URL used when a record carries no ownerEndpoint.
     * Default: $ENGINE_PUBLIC_URL, else http://127.0.0.1:8101.
     */
    fallbackEngineUrl?: string;
}
/** Principals recorded as participants on a record, in any carried shape. */
export declare function participantPrincipals(rec: AgentSessionRecord): string[];
/** True when the principal created the session or is a recorded participant. */
export declare function recordMatchesPrincipal(rec: AgentSessionRecord, principal: string): boolean;
/**
 * Pure selection: from candidate records pick the principal's active
 * session — live lease, principal is creator/participant, most recently
 * updated wins (ownershipEpoch breaks ties: a re-claimed session is
 * newer than the record it replaced). Records without a usable session
 * id / file id / engine endpoint never resolve.
 */
export declare function pickActiveSession(records: Iterable<AgentSessionRecord>, principal: string, opts?: AgentSessionResolverOptions): ResolvedAgentSession | null;
/**
 * Default record source: the local registry file. A missing file is an
 * empty registry (no sessions — not an error). A corrupt file THROWS:
 * the registry elsewhere fails closed on corruption, and the caller
 * (agentSvc) treats a resolver throw as "no binding" rather than risk
 * binding the agent to a session read from ambiguous state.
 */
export declare function readLocalRegistryRecords(env?: NodeJS.ProcessEnv): AgentSessionRecord[];
/** Build the resolver the agent service uses per /message. */
export declare function createAgentSessionResolver(opts?: AgentSessionResolverOptions): (principal: string) => Promise<ResolvedAgentSession | null>;
