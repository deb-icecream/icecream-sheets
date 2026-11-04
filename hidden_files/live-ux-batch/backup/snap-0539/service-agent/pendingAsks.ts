/**
 * Human-in-the-loop pending-ask store (design-docs/ai-agent.md §12).
 *
 * "Human-in-the-loop is also a tool call. When the agent needs the user, it
 * calls a tool: asking a question, offering options to choose from, or
 * requesting approval. The tool call pauses the agent until the user
 * responds. There is no path around MCP."
 *
 * This is the ONE implementation of that pause. The MCP server's
 * agent.ask_question / agent.offer_options / agent.request_approval tools
 * create a record here and block (waitForAnswer) until agent.answer_pending
 * delivers the human's answer; the agent runtime reaches the same store
 * only through those versioned tools — never a parallel pause
 * implementation.
 *
 * Records are written through to the service metadata store, so pending
 * asks survive restarts (per-user, like conversation threads in
 * threads.ts). In-process waiters are notified immediately; reads are
 * read-through (the metadata cache is invalidated first) so two store
 * instances over the same persistence — e.g. two MCP server instances in
 * one process — see each other's writes, and waitForAnswer also polls the
 * store so an answer recorded by another instance still unblocks the
 * waiter.
 *
 * Persistence is always encrypted at rest (AsyncMetadataStore over
 * EncryptedPersistence — see createEncryptedPendingAskStore in
 * secureStore.ts); the storage backend is async because WebCrypto is.
 *
 * Browser-safe: no node builtins (the web app bundles this module).
 */

/** Default cap on how long a HITL tool call waits for the human. Never hangs forever. */
export const DEFAULT_HITL_TIMEOUT_MS = 10 * 60 * 1000;

/** Metadata-store key for pending asks (per deployment; records carry their principal). */
export const PENDING_ASK_KEY = 'icecream-sheets.agent.pending-asks.v1';

/** Current pending-ask record schema version. */
export const PENDING_ASK_VERSION = 1;

/** How often a blocked waiter re-reads the store (catches answers from other instances). */
const WAIT_POLL_MS = 500;

export type PendingAskKind = 'question' | 'options' | 'approval';

/** One human-in-the-loop request waiting for (or holding) an answer. */
export interface PendingAsk {
  id: string;
  kind: PendingAskKind;
  /** The user the agent was acting as when it asked (ai-agent.md §3). */
  principal: string;
  /** Free-text question (kind 'question' | 'options'). */
  question?: string;
  /** Offered choices (kind 'options'). The recorded answer must be one of these. */
  options?: string[];
  /** Short action label (kind 'approval'), e.g. 'write_cells'. */
  action?: string;
  /** Human-readable description of what needs approval (kind 'approval'). */
  detail?: string;
  createdAt: number;
  /** The human's answer once delivered via answer(). */
  answer?: string;
  /** Optional note attached to the answer (used by approval requests). */
  note?: string;
  answeredAt?: number;
}

/** Sanitized view returned by list_pending (principal-scoped). */
export interface PendingAskView {
  id: string;
  kind: PendingAskKind;
  principal: string;
  question?: string;
  options?: string[];
  action?: string;
  detail?: string;
  createdAt: number;
  answered: boolean;
}

export interface CreatePendingAsk {
  kind: PendingAskKind;
  principal: string;
  question?: string;
  options?: string[];
  action?: string;
  detail?: string;
}

interface Waiter {
  resolve: (ask: PendingAsk) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function sanitizeAsk(raw: unknown): PendingAsk | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (raw.kind !== 'question' && raw.kind !== 'options' && raw.kind !== 'approval') return null;
  if (typeof raw.principal !== 'string' || raw.principal.length === 0) return null;
  const ask: PendingAsk = {
    id: raw.id,
    kind: raw.kind,
    principal: raw.principal,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  };
  if (typeof raw.question === 'string') ask.question = raw.question;
  if (
    Array.isArray(raw.options) &&
    raw.options.length > 0 &&
    raw.options.every((o) => typeof o === 'string')
  ) {
    ask.options = raw.options as string[];
  }
  if (typeof raw.action === 'string') ask.action = raw.action;
  if (typeof raw.detail === 'string') ask.detail = raw.detail;
  if (typeof raw.answer === 'string') ask.answer = raw.answer;
  if (typeof raw.note === 'string') ask.note = raw.note;
  if (typeof raw.answeredAt === 'number') ask.answeredAt = raw.answeredAt;
  return ask;
}

export function serializePendingAsks(asks: PendingAsk[]): string {
  return JSON.stringify({ version: PENDING_ASK_VERSION, asks });
}

export function deserializePendingAsks(json: string): PendingAsk[] {
  try {
    const p = JSON.parse(json) as { asks?: unknown };
    if (!Array.isArray(p.asks)) return [];
    return p.asks.map(sanitizeAsk).filter((a): a is PendingAsk => a !== null);
  } catch {
    return [];
  }
}

/** View projection for list_pending. */
export function toPendingAskView(ask: PendingAsk): PendingAskView {
  return {
    id: ask.id,
    kind: ask.kind,
    principal: ask.principal,
    ...(ask.question !== undefined ? { question: ask.question } : {}),
    ...(ask.options !== undefined ? { options: [...ask.options] } : {}),
    ...(ask.action !== undefined ? { action: ask.action } : {}),
    ...(ask.detail !== undefined ? { detail: ask.detail } : {}),
    createdAt: ask.createdAt,
    answered: ask.answer !== undefined,
  };
}

/**
 * Interpret a free-text answer to an approval request.
 * Affirmative → approved; negative → denied; anything else is kept as a
 * note with approved=false (the agent must not guess at ambiguous answers).
 */
export function parseApprovalAnswer(answer: string): { approved: boolean; note?: string } {
  const t = answer.trim().toLowerCase();
  if (/^(y|yes|yeah|yep|ok|okay|approve|approved|confirm|confirmed|proceed|sure|do it)\b/.test(t)) {
    return { approved: true };
  }
  if (
    /^(n|no|nope|deny|denied|reject|rejected|decline|declined|cancel|cancelled|stop|don't|do not)\b/.test(
      t,
    )
  ) {
    return { approved: false };
  }
  return { approved: false, note: answer };
}

/**
 * Async storage backend for pending asks. AsyncMetadataStore<PendingAsk>
 * (secureStore.ts) satisfies this structurally — in production it is built
 * over EncryptedPersistence, so records are encrypted at rest.
 */
export interface PendingAskBackend {
  all(): Promise<PendingAsk[]>;
  saveAll(items: PendingAsk[]): Promise<void>;
  invalidate(): void;
}

export class PendingAskStore {
  private waiters = new Map<string, Set<Waiter>>();
  private seq = 0;

  constructor(private readonly store: PendingAskBackend) {}

  private async fresh(): Promise<PendingAsk[]> {
    this.store.invalidate();
    return this.store.all();
  }

  private async persist(asks: PendingAsk[]): Promise<void> {
    await this.store.saveAll(asks);
  }

  private newId(): string {
    this.seq += 1;
    return `ask_${Date.now().toString(36)}_${this.seq.toString(36)}${Math.floor(
      Math.random() * 0xffffff,
    ).toString(36)}`;
  }

  /** Create a pending ask. Validates kind-specific payloads. */
  async create(input: CreatePendingAsk): Promise<PendingAsk> {
    if (!input.principal || input.principal.length === 0) {
      throw new Error('principal is required');
    }
    if (input.kind === 'question' || input.kind === 'options') {
      if (!input.question || input.question.length === 0) {
        throw new Error(`question is required for kind '${input.kind}'`);
      }
    }
    if (input.kind === 'options') {
      if (!input.options || input.options.length < 2) {
        throw new Error("options requires at least 2 choices");
      }
    }
    if (input.kind === 'approval') {
      if (!input.action || input.action.length === 0) throw new Error('action is required for kind approval');
      if (!input.detail || input.detail.length === 0) throw new Error('detail is required for kind approval');
    }
    const ask: PendingAsk = {
      id: this.newId(),
      kind: input.kind,
      principal: input.principal,
      createdAt: Date.now(),
    };
    if (input.question !== undefined) ask.question = input.question;
    if (input.options !== undefined) ask.options = [...input.options];
    if (input.action !== undefined) ask.action = input.action;
    if (input.detail !== undefined) ask.detail = input.detail;
    const asks = await this.fresh();
    asks.push(ask);
    await this.persist(asks);
    return ask;
  }

  /** Read one ask by id (read-through). */
  async get(id: string): Promise<PendingAsk | undefined> {
    return (await this.fresh()).find((a) => a.id === id);
  }

  /** Pending asks for one principal, oldest first. Answered-but-unconsumed asks are included (answered: true). */
  async listFor(principal: string): Promise<PendingAsk[]> {
    return (await this.fresh())
      .filter((a) => a.principal === principal)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Remove an ask (e.g. withdrawn). Principal-scoped like answer(). */
  async remove(id: string, principal?: string): Promise<void> {
    const asks = await this.fresh();
    const ask = asks.find((a) => a.id === id);
    if (!ask) return;
    if (principal !== undefined && ask.principal !== principal) {
      throw new Error(`not authorized to remove ask ${id}`);
    }
    this.failWaiters(id, new Error(`pending ask ${id} was removed`));
    await this.persist(asks.filter((a) => a.id !== id));
  }

  /**
   * Record the human's answer. Principal-scoped: a user can only answer
   * their own pending asks. Notifies in-process waiters immediately; the
   * persisted record lets waiters on other store instances pick it up via
   * their poll.
   */
  async answer(id: string, answer: string, principal: string, note?: string): Promise<PendingAsk> {
    const asks = await this.fresh();
    const ask = asks.find((a) => a.id === id);
    if (!ask) throw new Error(`unknown pending ask: ${id}`);
    if (ask.principal !== principal) {
      throw new Error(`not authorized to answer ask ${id} (owned by another principal)`);
    }
    if (ask.answer !== undefined) throw new Error(`pending ask ${id} was already answered`);
    if (ask.kind === 'options' && !(ask.options ?? []).includes(answer)) {
      throw new Error(`answer must be one of the offered options: ${(ask.options ?? []).join(', ')}`);
    }
    ask.answer = answer;
    if (note !== undefined) ask.note = note;
    ask.answeredAt = Date.now();
    await this.persist(asks);
    this.resolveWaiters(id, ask);
    return ask;
  }

  /**
   * Block until the human answers (or the timeout elapses). Resolves with
   * the answered record; rejects on timeout or unknown id — never hangs
   * forever. Consumes (deletes) the record on settle.
   */
  async waitForAnswer(id: string, timeoutMs: number): Promise<PendingAsk> {
    if (!(timeoutMs > 0)) throw new Error('timeoutMs must be positive');
    const existing = await this.get(id);
    if (!existing) return Promise.reject(new Error(`unknown pending ask: ${id}`));
    if (existing.answer !== undefined) {
      await this.consume(id);
      return existing;
    }
    return new Promise<PendingAsk>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.get(id)?.delete(waiter);
        fn();
      };
      const timer = setTimeout(() => {
        // Nobody answered in time: drop the stale ask so the UI and
        // list_pending don't show a question nobody is waiting for.
        void this.consume(id).finally(() => {
          done(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for an answer`)));
        });
      }, timeoutMs);
      // Never hold the process open for a human who may never answer.
      (timer as unknown as { unref?: () => void }).unref?.();
      const poll = setInterval(() => {
        void (async () => {
          const cur = await this.get(id);
          if (cur?.answer !== undefined) {
            clearInterval(poll);
            await this.consume(id);
            done(() => resolve(cur));
          } else if (!cur) {
            // Removed out from under us (timeout on another instance, etc.).
            clearInterval(poll);
            done(() => reject(new Error(`pending ask ${id} is gone`)));
          }
        })();
      }, WAIT_POLL_MS);
      (poll as unknown as { unref?: () => void }).unref?.();
      const waiter: Waiter = {
        resolve: (ask: PendingAsk) => {
          clearInterval(poll);
          void this.consume(id).finally(() => done(() => resolve(ask)));
        },
        reject: (err: Error) => {
          clearInterval(poll);
          done(() => reject(err));
        },
        timer,
      };
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      set.add(waiter);
    });
  }

  private async consume(id: string): Promise<void> {
    const asks = (await this.fresh()).filter((a) => a.id !== id);
    await this.persist(asks);
  }

  private resolveWaiters(id: string, ask: PendingAsk): void {
    const set = this.waiters.get(id);
    this.waiters.delete(id);
    for (const w of set ?? []) w.resolve(ask);
  }

  private failWaiters(id: string, err: Error): void {
    const set = this.waiters.get(id);
    this.waiters.delete(id);
    for (const w of set ?? []) w.reject(err);
  }
}

/**
 * Build a PendingAskStore over an explicit async backend. In production
 * the backend is an AsyncMetadataStore over EncryptedPersistence (see
 * createEncryptedPendingAskStore in secureStore.ts) so records are
 * encrypted at rest.
 *
 * There is deliberately no plaintext default factory: pending asks carry
 * free-text questions/answers that may include sensitive workbook content,
 * so every persisted record must be ciphertext.
 */
export function createPendingAskStoreOver(backend: PendingAskBackend): PendingAskStore {
  if (!backend) throw new Error('pendingAsks: backend is required');
  return new PendingAskStore(backend);
}
