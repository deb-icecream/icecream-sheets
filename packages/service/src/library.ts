/**
 * Workbook library — the host layer's view of the workbook lifecycle
 * (design-docs/platform-shell.md §2).
 *
 * "New, Open, Make a copy and Move to trash operate on the service metadata
 * store. ... Make a copy duplicates bytes and metadata under a new id and
 * needs the manage right on the workbook."
 *
 * This module owns the "Make a copy" operation: it duplicates the workbook
 * bytes and the metadata-store entry under a new id, and it calls
 * authorize() for the manage right on the workbook BEFORE any byte is
 * read or duplicated. A denied or failing policy throws (fail closed);
 * nothing is copied on denial.
 *
 * The byte store is host-injected (the library never touches storage
 * adapters directly); metadata entries live in the service metadata store.
 */

import { workbookObjectId } from './access.js';

/** Structural authorize() port — mirrors the engine's Policy signature. */
export interface AuthorizePort {
  (action: string, target: string, ctx: { principal: string }): boolean;
}

/**
 * One workbook's metadata entry (platform-shell.md §2: Open lists the
 * user's workbooks with owner, created and modified times, size and
 * storage backend).
 */
export interface WorkbookEntry {
  id: string;
  name: string;
  owner: string;
  createdAt: string;
  modifiedAt: string;
  /** Byte size of the workbook payload. */
  sizeBytes: number;
  /** Storage backend id (e.g. 'local', 'drive', 's3'). */
  backend: string;
}

/** Host-injected workbook byte storage. */
export interface WorkbookByteStore {
  readBytes(workbookId: string): Promise<Uint8Array>;
  writeBytes(workbookId: string, bytes: Uint8Array): Promise<void>;
}

export interface WorkbookLibraryOptions {
  now?: () => Date;
  /** Id generator for copies; defaults to a random `wb_<...>` id. */
  newId?: () => string;
}

function defaultNewId(): string {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `wb_${Date.now().toString(36)}_${rand}`;
}

function assertNonEmpty(v: string, name: string): void {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`library: ${name} must be a non-empty string`);
  }
}

function assertPrincipal(principal: string): void {
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new Error('library: missing principal (fail closed)');
  }
}

/**
 * The workbook library: metadata entries plus the host's byte store.
 * Entries are kept in insertion order; the caller owns persistence (the
 * service metadata store).
 */
export class WorkbookLibrary {
  private readonly entries = new Map<string, WorkbookEntry>();
  private readonly bytes: WorkbookByteStore;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(entries: WorkbookEntry[], bytes: WorkbookByteStore, options?: WorkbookLibraryOptions) {
    this.bytes = bytes;
    this.now = options?.now ?? (() => new Date());
    this.newId = options?.newId ?? defaultNewId;
    for (const e of entries) this.entries.set(e.id, { ...e });
  }

  /** All workbook entries (platform-shell.md §2: the Open listing). */
  list(): WorkbookEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  get(workbookId: string): WorkbookEntry | undefined {
    const e = this.entries.get(workbookId);
    return e ? { ...e } : undefined;
  }

  /**
   * Make a copy (platform-shell.md §2): duplicates bytes and metadata
   * under a new id. Requires the manage right on the workbook — the
   * authorize() check runs FIRST, before any byte is read; a denial or a
   * throwing policy aborts the copy with nothing duplicated.
   */
  async copy(
    workbookId: string,
    auth: { authorize: AuthorizePort; principal: string },
    options?: { name?: string },
  ): Promise<WorkbookEntry> {
    assertNonEmpty(workbookId, 'workbookId');
    assertPrincipal(auth.principal);
    const source = this.entries.get(workbookId);
    if (!source) {
      throw new Error(`library: unknown workbook '${workbookId}'`);
    }
    // The manage-right gate: runs before any read/duplicate work.
    let allowed = false;
    try {
      allowed = auth.authorize('manage', workbookObjectId(workbookId), { principal: auth.principal }) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new Error(
        `library: denied — principal '${auth.principal}' lacks the manage right on workbook '${workbookId}' (platform-shell.md §2)`,
      );
    }

    const payload = await this.bytes.readBytes(workbookId);
    const id = this.newId();
    if (this.entries.has(id)) {
      throw new Error(`library: copy id collision on '${id}'`);
    }
    await this.bytes.writeBytes(id, payload);
    const stamp = this.now().toISOString();
    const entry: WorkbookEntry = {
      id,
      name: options?.name?.trim() ? (options.name as string).trim() : `Copy of ${source.name}`,
      owner: auth.principal,
      createdAt: stamp,
      modifiedAt: stamp,
      sizeBytes: payload.byteLength,
      backend: source.backend,
    };
    this.entries.set(id, entry);
    return { ...entry };
  }
}
