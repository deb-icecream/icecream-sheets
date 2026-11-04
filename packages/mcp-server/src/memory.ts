/**
 * Service-metadata memory store for the AI Agent (track 29, §12 of
 * design-docs/ai-agent.md).
 *
 * Long-term memory is what the agent explicitly saves, and every operation
 * is a versioned MCP tool call (memory_load / memory_save / memory_update),
 * scoped per user. There is no private memory channel: this store lives in
 * the service metadata store (the single metadata authority), never in
 * workbook bytes and never in server-local-only state.
 *
 * Durable-store migration: the persistence seam is async (AsyncPersistence)
 * so the store can be backed by Firestore. The FIX-J read-modify-write
 * merge semantics are preserved exactly — only the I/O is awaited.
 */
import {
  memoryAsyncPersistence,
  type AsyncPersistence,
} from '@icecream-sheets/service';

const MEMORY_KEY = 'icecream-sheets.mcp.agent-memory.v1';

export class MemoryStore {
  /** userId -> key -> JSON value */
  private store = new Map<string, Map<string, unknown>>();
  private loaded = false;
  /**
   * Users this instance has explicitly cleared (clearUser). A plain
   * read-modify-write merge cannot express a deletion — the persisted
   * blob still holds the user's keys — so persist() drops these users
   * from the merged blob instead of resurrecting them.
   */
  private clearedUsers = new Set<string>();

  /**
   * Persistence defaults to in-memory; hosts inject their own (file,
   * Firestore, …) via ServerOptions. Always async (durable-store migration).
   */
  constructor(private readonly persistence: AsyncPersistence = memoryAsyncPersistence()) {}

  /**
   * Read and parse the persisted blob. Corrupt or missing data reads as
   * an empty store — never throws (the §12 tolerance contract).
   */
  private async readPersisted(): Promise<Map<string, Map<string, unknown>>> {
    const out = new Map<string, Map<string, unknown>>();
    try {
      const raw = await this.persistence.load(MEMORY_KEY);
      if (raw === null) return out;
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      if (!parsed || typeof parsed !== 'object') return out;
      for (const [userId, kv] of Object.entries(parsed)) {
        if (kv && typeof kv === 'object') out.set(userId, new Map(Object.entries(kv)));
      }
    } catch {
      // Corrupt persisted memory: start empty rather than failing.
    }
    return out;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    // A fresh instance over shared persistence recalls whatever an
    // earlier instance saved (this is what survives a gateway runtime
    // swap: the new runtime's store is a new instance, same blob).
    this.store = await this.readPersisted();
  }

  /**
   * Read-modify-write persist (FIX-J): several MemoryStore instances can
   * share one file-backed Persistence (one per coexisting gateway
   * runtime), so a whole-blob snapshot of this instance's possibly stale
   * in-memory state would clobber keys another instance saved after
   * this one loaded. Instead: reload the persisted blob, merge THIS
   * instance's in-memory state over it (this instance's keys win for
   * keys it holds; keys/users it never touched survive), drop users
   * this instance cleared, then save the merged blob and adopt it, so
   * this instance also picks up the other instances' keys.
   */
  private async persist(): Promise<void> {
    try {
      const merged = await this.readPersisted();
      for (const [userId, kv] of this.store) {
        const target = merged.get(userId) ?? new Map<string, unknown>();
        for (const [k, v] of kv) target.set(k, v);
        merged.set(userId, target);
      }
      for (const userId of this.clearedUsers) merged.delete(userId);
      const obj: Record<string, Record<string, unknown>> = {};
      for (const [userId, kv] of merged) obj[userId] = Object.fromEntries(kv);
      await this.persistence.save(MEMORY_KEY, JSON.stringify(obj));
      // Save succeeded: adopt the merged state and retire the clear
      // markers (the blob no longer holds those users).
      this.store = merged;
      this.clearedUsers.clear();
    } catch {
      // Persistence is best-effort; the in-memory store stays authoritative
      // for this process.
    }
  }

  private async ns(userId: string): Promise<Map<string, unknown>> {
    await this.ensureLoaded();
    // Writing to a user again un-clears them: a pending clear marker
    // (only possible if an earlier persist failed) must not drop the
    // new keys on the next merge.
    this.clearedUsers.delete(userId);
    let m = this.store.get(userId);
    if (!m) {
      m = new Map();
      this.store.set(userId, m);
    }
    return m;
  }

  async load(userId: string, key: string): Promise<{ found: boolean; value?: unknown }> {
    await this.ensureLoaded();
    const m = this.store.get(userId);
    if (!m || !m.has(key)) return { found: false };
    return { found: true, value: m.get(key) };
  }

  async save(userId: string, key: string, value: unknown): Promise<void> {
    (await this.ns(userId)).set(key, value);
    await this.persist();
  }

  /**
   * Patch semantics: when both the stored value and the patch are plain
   * objects, shallow-merge; otherwise replace. Returns the new value.
   */
  async update(userId: string, key: string, patch: unknown): Promise<unknown> {
    const m = await this.ns(userId);
    const cur = m.get(key);
    if (isPlainObject(cur) && isPlainObject(patch)) {
      const merged = { ...(cur as Record<string, unknown>), ...(patch as Record<string, unknown>) };
      m.set(key, merged);
      await this.persist();
      return merged;
    }
    m.set(key, patch);
    await this.persist();
    return patch;
  }

  async keys(userId: string): Promise<string[]> {
    await this.ensureLoaded();
    return [...(this.store.get(userId)?.keys() ?? [])];
  }

  /** Test/admin helper: drop a user's namespace. */
  async clearUser(userId: string): Promise<void> {
    await this.ensureLoaded();
    this.store.delete(userId);
    // Record the deletion so persist()'s merge drops the user from the
    // shared blob instead of merging their persisted keys back in.
    this.clearedUsers.add(userId);
    await this.persist();
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}
