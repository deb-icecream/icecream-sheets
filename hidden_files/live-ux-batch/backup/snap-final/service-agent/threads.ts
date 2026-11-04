/**
 * Agent conversation threads in the service metadata store
 * (design-docs/ai-agent.md §9: "Conversation state lives in the service
 * metadata store, per user, never in workbook bytes").
 *
 * Each thread is a versioned record: id, owning user, title and message
 * history (capped). Human-in-the-loop pauses are NOT stored here: §12
 * pauses live in the shared PendingAskStore (pendingAsks.ts) behind the
 * versioned agent.* MCP tools — one implementation, no parallel pause
 * state. The AgentRuntime keeps an in-memory cache over this store and
 * writes through on every turn.
 */
import type { AgentMessage } from './types.js';
import type { Persistence } from '../metadataStore.js';
import { MetadataStore } from '../metadataStore.js';


/**
 * Current thread-record schema version. Bumped to 2 when the runtime-level
 * paused-turn field was removed (pauses moved to the PendingAskStore
 * behind the agent.* MCP tools); v1 records migrate forward by dropping
 * the obsolete `pending` field.
 */
export const AGENT_THREAD_VERSION = 2;

/** Max messages kept per thread (older ones are dropped, newest win). */
export const MAX_THREAD_MESSAGES = 200;

/** Storage key prefix; the full key is `<prefix>.<userId>`. */
export const AGENT_THREAD_KEY_PREFIX = 'icecream-sheets.agent-threads.v1';

/** One conversation thread, versioned for forward migration. */
export interface AgentThread {
  version: number;
  threadId: string;
  userId: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
}

/** On-disk envelope for a user's thread list. */
export interface StoredThreads {
  version: number;
  userId: string;
  threads: AgentThread[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function sanitizeMessage(raw: unknown): AgentMessage | null {
  if (!isObject(raw)) return null;
  if (raw.role !== 'user' && raw.role !== 'agent' && raw.role !== 'system') return null;
  if (typeof raw.text !== 'string') return null;
  return {
    role: raw.role,
    text: raw.text,
    ts: typeof raw.ts === 'number' ? raw.ts : Date.now(),
  };
}

/** Migrate one stored thread record forward to the current version. */
export function migrateThread(raw: unknown): AgentThread | null {
  if (!isObject(raw)) return null;
  if (typeof raw.threadId !== 'string' || raw.threadId.length === 0) return null;
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > AGENT_THREAD_VERSION) return null; // from the future — don't guess
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(sanitizeMessage).filter((m): m is AgentMessage => m !== null)
    : [];
  const thread: AgentThread = {
    version: AGENT_THREAD_VERSION,
    threadId: raw.threadId,
    userId: typeof raw.userId === 'string' ? raw.userId : '',
    title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : raw.threadId,
    messages: messages.slice(-MAX_THREAD_MESSAGES),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    // NOTE: v1 records may carry a `pending` paused-turn field; it is
    // deliberately dropped — pauses live in the PendingAskStore now.
  };
  return thread;
}

/** Create a fresh thread record. */
export function newThread(threadId: string, userId: string, title?: string): AgentThread {
  const at = Date.now();
  return {
    version: AGENT_THREAD_VERSION,
    threadId,
    userId,
    title: title && title.length > 0 ? title : threadId,
    messages: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** Serialize a user's threads for the metadata store. */
export function serializeThreads(userId: string, threads: AgentThread[]): string {
  const stored: StoredThreads = { version: AGENT_THREAD_VERSION, userId, threads };
  return JSON.stringify(stored);
}

/**
 * Deserialize threads, migrating older versions forward.
 * Returns an empty list (not an exception) for corrupt payloads.
 */
export function deserializeThreads(json: string): AgentThread[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const stored = parsed as Partial<StoredThreads>;
  if (!Array.isArray(stored.threads)) return [];
  const seen = new Set<string>();
  const out: AgentThread[] = [];
  for (const raw of stored.threads) {
    const t = migrateThread(raw);
    if (t && !seen.has(t.threadId)) {
      seen.add(t.threadId);
      out.push(t);
    }
  }
  return out;
}

/**
 * Per-user agent-thread store (ai-agent.md §9). Threads are keyed
 * `icecream-sheets.agent-threads.v1.<userId>` — per user, never in
 * workbook bytes.
 */
export function createAgentThreadStore(
  persistence: Persistence,
  userId: string,
): MetadataStore<AgentThread> {
  if (!persistence) throw new Error('createAgentThreadStore requires a Persistence adapter');
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('createAgentThreadStore requires a non-empty userId');
  }
  return new MetadataStore<AgentThread>(
    `${AGENT_THREAD_KEY_PREFIX}.${userId}`,
    persistence,
    (threads) => serializeThreads(userId, threads),
    deserializeThreads,
  );
}
