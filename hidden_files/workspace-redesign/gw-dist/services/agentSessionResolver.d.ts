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
import { type FileRegistry, type FileRegistryRecord } from '../deploy/fileRegistry.js';
/**
 * A registry record as read from disk. The static type is the current
 * writer's shape (FileRegistryRecord: participants is a principal →
 * role map, recorded by the gateway at /api/engine/open JOIN time),
 * but records on disk can predate it and carry the legacy shapes
 * (string lists, { principal } objects) — participantPrincipals /
 * participantRole therefore read the field defensively as unknown and
 * honor every shape at runtime.
 */
export type AgentSessionRecord = FileRegistryRecord;
/** The principal's active session, ready to bind a remote host to. */
export interface ResolvedAgentSession {
    fileId: string;
    sessionId: string;
    /** The owning engine instance's base URL (record's ownerEndpoint). */
    engineUrl: string;
    /** Fencing token from the registry record (§9). */
    ownershipEpoch: number;
    creatorPrincipal: string;
    /**
     * THIS principal's role in the session (FIX-B residual 4): the
     * creator is always 'editor'; a recorded participant gets the role
     * the gateway minted their join token with; a participant recorded
     * without a role (legacy shapes) gets 'viewer' — the fail-safe,
     * because an agent token is minted from this role and the engine
     * refuses a viewer's writes.
     */
    role: 'editor' | 'viewer';
    /** Registry revision counters at resolve time (host seed). */
    currentRevision: number;
    updatedAt: number;
}
export type AgentSessionRecordSource = Iterable<AgentSessionRecord> | (() => Iterable<AgentSessionRecord> | Promise<Iterable<AgentSessionRecord>>);
export interface AgentSessionResolverOptions {
    /** Record source override (tests). Default: the registry (opts.registry) or the local registry file. */
    records?: AgentSessionRecordSource;
    /**
     * The session ownership registry to enumerate via listAll() — the
     * production (Firestore-backed) source. Ignored when `records` is
     * given. When neither is given, the local registry file is read.
     */
    registry?: FileRegistry;
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
 * The role a record assigns to a participant, or null when the record
 * lists the participant without a usable role (bare string entries and
 * { principal } objects without a role — written before roles were
 * recorded). Map shape: { principal: 'editor' | 'viewer' }.
 */
export declare function participantRole(rec: AgentSessionRecord, principal: string): 'editor' | 'viewer' | null;
/**
 * The role the resolved session carries FOR THIS PRINCIPAL: creator →
 * 'editor'; participant → their recorded role, defaulting to 'viewer'
 * when the record carries none (fail-safe — see ResolvedAgentSession).
 */
export declare function roleForPrincipal(rec: AgentSessionRecord, principal: string): 'editor' | 'viewer';
/**
 * Pure selection: from candidate records pick the principal's active
 * session — live lease, principal is creator/participant, most recently
 * updated wins (ownershipEpoch breaks ties: a re-claimed session is
 * newer than the record it replaced). Records without a usable session
 * id / file id / engine endpoint never resolve.
 */
export declare function pickActiveSession(records: Iterable<AgentSessionRecord>, principal: string, opts?: AgentSessionResolverOptions): ResolvedAgentSession | null;
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
export declare function pickSessionForFile(records: Iterable<AgentSessionRecord>, principal: string, fileId: string, opts?: AgentSessionResolverOptions): ResolvedAgentSession | null;
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
/**
 * Build the file-scoped resolver the add-on binding uses per /run:
 * (principal, fileId) → that file's live session for the principal,
 * or null when the document is not open in a session the principal
 * belongs to.
 */
export declare function createFileSessionResolver(opts?: AgentSessionResolverOptions): (principal: string, fileId: string) => Promise<ResolvedAgentSession | null>;
