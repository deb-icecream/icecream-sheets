/**
 * NamedRangeStore — the service-layer model for named ranges.
 *
 * Design-docs/named-ranges-and-named-functions.md:
 * - §1: every named range has a stable object id independent of its cells.
 *   The name binds to the identity; the identity tracks the range through
 *   insert/delete/move (tracked by the engine's named expressions — see
 *   syncFromEngine). Deleting all covered cells leaves a dangling name
 *   (ref null) that resolves to #REF!, never to moved-in cells.
 * - §2: workbook scope by default; sheet scope shadows the workbook name
 *   within that sheet; case-insensitive; collisions rejected (never
 *   silently renamed); names must not parse as cell refs or function names.
 * - §3: definitions live in the service metadata store, keyed by stable id
 *   (`icecream-sheets.names.v1.<workbookId>`); never in workbook bytes.
 *   The XLSX adapter mirrors them to the defined-names table on save and
 *   reads them back on open (toDefinedNames / importDefinedNames).
 * - §4: defining/editing a name requires write on the underlying range
 *   (via the injected authorize hook); reading through a name enforces the
 *   same authorize() checks as addressing the cells directly
 *   (resolveForSubject / bindForSubject in engineBinding.ts).
 *
 * Browser-safe: no Node builtins. Engine binding goes through the
 * NameEnginePort interface (engineBinding.ts) so this module never imports
 * the engine package.
 */
import type { Persistence } from '../metadataStore.js';
import { KeyManager } from '../crypto.js';
import { EncryptedPersistence, type AsyncPersistence } from '../secureStore.js';
import {
  NameError,
  nameKey,
  scopeKey,
  validateNameSyntax,
  type NamedRangeDef,
  type NameRangeRef,
  type NameScope,
  type NameValidationOptions,
} from './types.js';
import { formatAbsoluteRef, parseDefinedNameRef, refToTarget } from './a1.js';

/** Structural defined-name shape (mirrors the engine's DefinedName). */
export interface DefinedNameLike {
  name: string;
  ref: string;
  /** 0-based sheet index for sheet-scoped names; undefined = workbook scope. */
  sheet?: number;
}

/**
 * Authorize hook: (action, target, ctx) => allowed. Actions reuse the
 * permission model's vocabulary ('cell.write', 'range.read', ...); targets
 * are engine-style ('Sheet1!A1:B2', '' for the workbook root). When omitted,
 * all mutations are allowed (single-user local default).
 */
export type AuthorizeFn = (
  action: string,
  target: string,
  ctx: { principal: string },
) => boolean;

export interface NamedRangeStoreOptions extends NameValidationOptions {
  persistence: Persistence;
  /** Workbook this store belongs to (scopes the metadata-store key). */
  workbookId: string;
  authorize?: AuthorizeFn;
}

/**
 * Options for NamedRangeStore.create(): the plain options plus the
 * KeyManager. Definitions are encrypted at rest under a per-workbook key
 * (§7: the EncryptedPersistence scope is the workbookId).
 */
export interface CreateNamedRangeStoreOptions extends NamedRangeStoreOptions {
  keys: KeyManager;
}

export interface DefineNameInput {
  name: string;
  scope?: NameScope;
  ref: NameRangeRef;
  principal: string;
}

export type NameResolution =
  | { status: 'ok'; def: NamedRangeDef }
  | { status: 'dangling'; def: NamedRangeDef }
  | { status: 'denied'; def: NamedRangeDef }
  | { status: 'unknown' };

const STORE_VERSION = 1;

/** Logical store key. EncryptedPersistence namespaces it per workbook
 * (scope = workbookId), so one constant key serves all workbooks. */
const NAMES_STORE_KEY = 'icecream-sheets.names.v1';

interface StoredNames {
  version: number;
  defs: NamedRangeDef[];
}

function newId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRangeRef(r: NameRangeRef): boolean {
  return (
    Number.isInteger(r.startRow) && Number.isInteger(r.startCol) &&
    Number.isInteger(r.endRow) && Number.isInteger(r.endCol) &&
    r.startRow >= 0 && r.startCol >= 0 && r.endRow >= r.startRow && r.endCol >= r.startCol &&
    typeof r.sheet === 'string' && r.sheet.length > 0
  );
}

export class NamedRangeStore {
  private readonly backend: AsyncPersistence;
  private readonly workbookId: string;
  private readonly authorize?: AuthorizeFn;
  private readonly reservedNames?: ReadonlySet<string>;
  private defs = new Map<string, NamedRangeDef>();
  /** scopeKey + '\n' + nameKey → id (collision detection). */
  private index = new Map<string, string>();

  private constructor(
    backend: AsyncPersistence,
    workbookId: string,
    authorize?: AuthorizeFn,
    reservedNames?: ReadonlySet<string>,
  ) {
    this.backend = backend;
    this.workbookId = workbookId;
    this.authorize = authorize;
    this.reservedNames = reservedNames;
  }

  /**
   * Build a store whose definitions are encrypted at rest under the
   * workbook's KeyManager key (§§3, 7: scope = workbookId). Loads
   * previously persisted definitions; fail-closed on tampered envelopes.
   *
   * Readers (get/list/resolve/...) stay synchronous — they serve the
   * in-memory defs. Every mutation is async because the encrypted write
   * is async.
   */
  static async create(opts: CreateNamedRangeStoreOptions): Promise<NamedRangeStore> {
    if (!opts.persistence) throw new Error('names: persistence adapter is required');
    if (!opts.keys) throw new Error('names: KeyManager is required');
    if (typeof opts.workbookId !== 'string' || opts.workbookId.length === 0) {
      throw new Error('names: workbookId must be a non-empty string');
    }
    const backend = await EncryptedPersistence.create(opts.persistence, opts.keys, opts.workbookId);
    const store = new NamedRangeStore(backend, opts.workbookId, opts.authorize, opts.reservedNames);
    await store.load();
    return store;
  }

  // -- definition ------------------------------------------------------

  /**
   * Define a named range (§4: requires write on the underlying range).
   * Rejects invalid names and scope collisions — never silently renames.
   */
  async define(input: DefineNameInput): Promise<NamedRangeDef> {
    const { principal } = input;
    assertPrincipal(principal);
    validateNameSyntax(input.name, { reservedNames: this.reservedNames });
    if (!isRangeRef(input.ref)) {
      throw new NameError('invalid-ref', `Invalid range for name "${input.name}".`);
    }
    const scope: NameScope = input.scope ?? { kind: 'workbook' };
    this.assertNoCollision(input.name, scope, null);
    this.checkWrite(input.ref, principal, 'define');
    const def: NamedRangeDef = {
      id: newId('nr'),
      name: input.name,
      scope,
      ref: { ...input.ref },
      createdBy: principal,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.defs.set(def.id, def);
    this.index.set(indexKey(scope, def.name), def.id);
    await this.save();
    return { ...def };
  }

  /**
   * Delete a name (§4: requires write on the underlying range).
   * Formulas referencing it become #NAME? (HyperFormula behavior).
   */
  async undefine(id: string, principal: string): Promise<void> {
    const def = this.require(id);
    this.checkWriteForDef(def, principal, 'delete');
    this.defs.delete(id);
    this.index.delete(indexKey(def.scope, def.name));
    await this.save();
  }

  /**
   * Point a name at a new range (§4: requires write on the NEW range).
   * The stable id is unchanged — formulas follow the identity.
   */
  async redefine(id: string, ref: NameRangeRef, principal: string): Promise<NamedRangeDef> {
    const def = this.require(id);
    if (!isRangeRef(ref)) throw new NameError('invalid-ref', `Invalid range for name "${def.name}".`);
    this.checkWrite(ref, principal, 'edit');
    def.ref = { ...ref };
    def.updatedAt = nowIso();
    await this.save();
    return { ...def };
  }

  /**
   * Rename a name, keeping the stable id and range. Collisions rejected.
   * (Engine formulas referencing the old name become #NAME? — HyperFormula
   * has no rename primitive; this matches define-then-delete semantics.)
   */
  async rename(id: string, newName: string, principal: string): Promise<NamedRangeDef> {
    const def = this.require(id);
    validateNameSyntax(newName, { reservedNames: this.reservedNames });
    this.assertNoCollision(newName, def.scope, id);
    this.checkWriteForDef(def, principal, 'rename');
    this.index.delete(indexKey(def.scope, def.name));
    def.name = newName;
    def.updatedAt = nowIso();
    this.index.set(indexKey(def.scope, def.name), def.id);
    await this.save();
    return { ...def };
  }

  /** Change a name's scope (workbook ↔ sheet). Collisions rejected. */
  async rescope(id: string, scope: NameScope, principal: string): Promise<NamedRangeDef> {
    const def = this.require(id);
    this.assertNoCollision(def.name, scope, id);
    this.checkWriteForDef(def, principal, 'rescope');
    this.index.delete(indexKey(def.scope, def.name));
    def.scope = scope;
    def.updatedAt = nowIso();
    this.index.set(indexKey(def.scope, def.name), def.id);
    await this.save();
    return { ...def };
  }

  // -- lookup ----------------------------------------------------------

  get(id: string): NamedRangeDef | undefined {
    const def = this.defs.get(id);
    return def ? { ...def, ref: def.ref ? { ...def.ref } : null } : undefined;
  }

  /** All definitions (display order: workbook scope first, then by name). */
  list(): NamedRangeDef[] {
    return [...this.defs.values()]
      .map((d) => ({ ...d, ref: d.ref ? { ...d.ref } : null }))
      .sort((a, b) => {
        const sa = a.scope.kind === 'workbook' ? 0 : 1;
        const sb = b.scope.kind === 'workbook' ? 0 : 1;
        return sa - sb || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
  }

  /**
   * Resolve a name (§2): case-insensitive; a sheet-scoped name shadows the
   * workbook name within that sheet. Pass the formula's sheet for `sheet`.
   */
  resolve(name: string, sheet?: string): NamedRangeDef | undefined {
    if (sheet) {
      const id = this.index.get(indexKey({ kind: 'sheet', sheet }, name));
      if (id) return this.get(id);
    }
    const id = this.index.get(indexKey({ kind: 'workbook' }, name));
    return id ? this.get(id) : undefined;
  }

  /**
   * Resolve for a subject (§4–§5): unknown → 'unknown' (#NAME?); unreadable
   * → 'denied' (#PERM!); dangling → 'dangling' (#REF!). Reading through the
   * name enforces the same authorize() checks as the cells directly.
   */
  resolveForSubject(name: string, principal: string, sheet?: string): NameResolution {
    const def = this.resolve(name, sheet);
    if (!def) return { status: 'unknown' };
    if (def.ref === null) return { status: 'dangling', def };
    if (!this.canRead(def, principal)) return { status: 'denied', def };
    return { status: 'ok', def };
  }

  // -- structural tracking ----------------------------------------------

  /**
   * Refresh tracked refs from the engine's named expressions. The engine
   * tracks ranges through insert/delete/move automatically; this pulls the
   * current formula text back into the metadata store so XLSX export and
   * the UI show the live range. Unparseable / #REF! → dangling (ref null).
   *
   * `sheetIndexOf` maps a scope sheet name to the engine's sheet index.
   */
  async syncFromEngine(
    getFormula: (name: string, sheetIndex?: number) => string | undefined,
    sheetIndexOf: (sheet: string) => number | undefined,
  ): Promise<void> {
    let changed = false;
    for (const def of this.defs.values()) {
      const scopeIndex =
        def.scope.kind === 'sheet' ? sheetIndexOf(def.scope.sheet) : undefined;
      if (def.scope.kind === 'sheet' && scopeIndex === undefined) {
        // Scope sheet is gone — the name can no longer resolve; keep the
        // def (audit trail) but mark it dangling.
        if (def.ref !== null) {
          def.ref = null;
          def.updatedAt = nowIso();
          changed = true;
        }
        continue;
      }
      const formula = getFormula(def.name, scopeIndex);
      if (formula === undefined) continue; // not bound in this engine; keep def
      const parsed = parseDefinedNameRef(formula);
      const same =
        (parsed === null && def.ref === null) ||
        (parsed !== null &&
          def.ref !== null &&
          parsed.sheet === def.ref.sheet &&
          parsed.startRow === def.ref.startRow &&
          parsed.startCol === def.ref.startCol &&
          parsed.endRow === def.ref.endRow &&
          parsed.endCol === def.ref.endCol);
      if (!same) {
        def.ref = parsed;
        def.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  /**
   * Rename a sheet: updates sheet-scoped name scopes and tracked ref sheets
   * optimistically. syncFromEngine corrects refs from engine tracking.
   */
  async renameSheet(oldName: string, newName: string): Promise<void> {
    let changed = false;
    for (const def of this.defs.values()) {
      if (def.scope.kind === 'sheet' && nameKey(def.scope.sheet) === nameKey(oldName)) {
        def.scope = { kind: 'sheet', sheet: newName };
        this.reindex(def);
        changed = true;
      }
      if (def.ref && nameKey(def.ref.sheet) === nameKey(oldName)) {
        def.ref.sheet = newName;
        def.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  /**
   * A sheet was deleted: refs pointing at it become dangling (ref null) —
   * #REF!, never rebound to moved-in cells. Sheet-scoped names keep their
   * scope (now scope-gone) as an audit trail, matching syncFromEngine.
   */
  async deleteSheetRefs(sheet: string): Promise<void> {
    let changed = false;
    for (const def of this.defs.values()) {
      if (def.ref && nameKey(def.ref.sheet) === nameKey(sheet)) {
        def.ref = null;
        def.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  // -- structural shifts (§1: the identity tracks insert/delete/move) ------
  //
  // The web app implements insert/delete rows/cols as cell copies rather
  // than HyperFormula structural ops, so the engine cannot track them —
  // the store shifts tracked refs explicitly and the host re-binds. Delete
  // paths that remove every covered cell leave a dangling name (ref null):
  // #REF!, never rebound to moved-in cells.

  /** Snapshot defs for undo (opaque, restorable). */
  snapshotDefs(): NamedRangeDef[] {
    return this.list();
  }

  /** Restore defs captured by snapshotDefs() (undo/redo). */
  async restoreDefs(defs: NamedRangeDef[]): Promise<void> {
    this.defs.clear();
    this.index.clear();
    for (const d of defs) {
      if (isStoredDef(d) && !this.defs.has(d.id)) {
        this.defs.set(d.id, { ...d, ref: d.ref ? { ...d.ref } : null });
        this.index.set(indexKey(d.scope, d.name), d.id);
      }
    }
    await this.save();
  }

  async applyInsertRows(sheet: string, atRow: number, count: number): Promise<void> {
    this.shift(sheet, 'row', (s, e) => shiftInsert(s, e, atRow, count));
  }

  async applyDeleteRows(sheet: string, atRow: number, count: number): Promise<void> {
    this.shift(sheet, 'row', (s, e) => shiftDelete(s, e, atRow, count));
  }

  async applyInsertCols(sheet: string, atCol: number, count: number): Promise<void> {
    this.shift(sheet, 'col', (s, e) => shiftInsert(s, e, atCol, count));
  }

  async applyDeleteCols(sheet: string, atCol: number, count: number): Promise<void> {
    this.shift(sheet, 'col', (s, e) => shiftDelete(s, e, atCol, count));
  }

  /**
   * Move rows [fromRow, fromRow+count) to `toRow`, where toRow is the
   * destination start index in the post-removal grid. Ranges fully inside
   * the block move with it; ranges outside shift; spanning ranges expand.
   */
  async applyMoveRows(sheet: string, fromRow: number, count: number, toRow: number): Promise<void> {
    this.shift(sheet, 'row', (s, e) => shiftMove(s, e, fromRow, count, toRow));
  }

  async applyMoveCols(sheet: string, fromCol: number, count: number, toCol: number): Promise<void> {
    this.shift(sheet, 'col', (s, e) => shiftMove(s, e, fromCol, count, toCol));
  }

  private async shift(
    sheet: string,
    dim: 'row' | 'col',
    fn: (start: number, end: number) => [number, number] | null,
  ): Promise<void> {
    let changed = false;
    for (const def of this.defs.values()) {
      if (!def.ref || nameKey(def.ref.sheet) !== nameKey(sheet)) continue;
      const s = dim === 'row' ? def.ref.startRow : def.ref.startCol;
      const e = dim === 'row' ? def.ref.endRow : def.ref.endCol;
      const next = fn(s, e);
      if (next === null) {
        def.ref = null; // dangling: #REF!
      } else {
        if (dim === 'row') {
          def.ref.startRow = next[0];
          def.ref.endRow = next[1];
        } else {
          def.ref.startCol = next[0];
          def.ref.endCol = next[1];
        }
      }
      def.updatedAt = nowIso();
      changed = true;
    }
    if (changed) await this.save();
  }

  // -- XLSX round-trip (§3) ----------------------------------------------

  /**
   * Mirror definitions to the file's defined-names table on save.
   * `sheetNames` maps scope sheets to 0-based indices. Dangling names are
   * exported as #REF! so Excel shows the same dangling state.
   */
  toDefinedNames(sheetNames: string[]): DefinedNameLike[] {
    const out: DefinedNameLike[] = [];
    for (const def of this.list()) {
      const entry: DefinedNameLike = {
        name: def.name,
        ref: def.ref ? formatAbsoluteRef(def.ref) : '#REF!',
      };
      if (def.scope.kind === 'sheet') {
        const idx = sheetNames.findIndex((s) => nameKey(s) === nameKey(def.scope.kind === 'sheet' ? def.scope.sheet : ''));
        if (idx >= 0) entry.sheet = idx;
        // Scope sheet missing from the file: export as workbook-scoped
        // rather than dropping the name (best effort; Excel keeps it).
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Read defined names back on open (XLSX adapter → DefinedNameLike[]).
   * Generates fresh stable ids. Non-range formulas (constants, arbitrary
   * expressions) are skipped — reported, never guessed. Collisions are
   * skipped, never silently renamed. Returns what was imported vs skipped.
   */
  async importDefinedNames(
    dns: DefinedNameLike[],
    sheetNames: string[],
    principal: string,
  ): Promise<{ imported: string[]; skipped: { name: string; reason: string }[] }> {
    assertPrincipal(principal);
    const imported: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const dn of dns) {
      if (typeof dn.name !== 'string' || typeof dn.ref !== 'string') {
        skipped.push({ name: String(dn.name ?? ''), reason: 'malformed entry' });
        continue;
      }
      try {
        validateNameSyntax(dn.name, { reservedNames: this.reservedNames });
      } catch (e) {
        skipped.push({ name: dn.name, reason: e instanceof Error ? e.message : 'invalid name' });
        continue;
      }
      let scope: NameScope = { kind: 'workbook' };
      if (dn.sheet !== undefined) {
        const sheet = sheetNames[dn.sheet];
        if (!sheet) {
          skipped.push({ name: dn.name, reason: `sheet index ${dn.sheet} out of range` });
          continue;
        }
        scope = { kind: 'sheet', sheet };
      }
      if (this.index.get(indexKey(scope, dn.name)) !== undefined) {
        skipped.push({ name: dn.name, reason: 'collides with an existing name (not renamed)' });
        continue;
      }
      // LAMBDA bodies belong to the function registry, not the range store.
      if (/^\s*=?\s*LAMBDA\s*\(/i.test(dn.ref)) {
        skipped.push({ name: dn.name, reason: 'LAMBDA expression — belongs to named functions' });
        continue;
      }
      const isDangling = /#REF!/i.test(dn.ref);
      const ref = isDangling ? null : parseDefinedNameRef(dn.ref);
      if (!isDangling && ref === null) {
        skipped.push({ name: dn.name, reason: 'not a plain range reference' });
        continue;
      }
      if (ref !== null && !isRangeRef(ref)) {
        skipped.push({ name: dn.name, reason: 'not a plain range reference' });
        continue;
      }
      if (ref !== null && ref.sheet === '') {
        skipped.push({ name: dn.name, reason: 'range has no sheet qualifier' });
        continue;
      }
      const def: NamedRangeDef = {
        id: newId('nr'),
        name: dn.name,
        scope,
        ref, // null = dangling (#REF! on import)
        createdBy: principal,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.defs.set(def.id, def);
      this.index.set(indexKey(scope, def.name), def.id);
      imported.push(def.id);
    }
    if (imported.length > 0) await this.save();
    return { imported, skipped };
  }

  // -- internals ----------------------------------------------------------

  private require(id: string): NamedRangeDef {
    const def = this.defs.get(id);
    if (!def) throw new NameError('not-found', `No named range with id '${id}'.`);
    return def;
  }

  private assertNoCollision(name: string, scope: NameScope, exceptId: string | null): void {
    const existing = this.index.get(indexKey(scope, name));
    if (existing !== undefined && existing !== exceptId) {
      const where = scope.kind === 'workbook' ? 'workbook scope' : `sheet "${scope.sheet}"`;
      throw new NameError('collision', `A name "${name}" already exists in ${where} — not renamed.`);
    }
  }

  private checkWrite(ref: NameRangeRef, principal: string, what: string): void {
    if (!this.authorize) return;
    const multi = ref.startRow !== ref.endRow || ref.startCol !== ref.endCol;
    const action = multi ? 'range.write' : 'cell.write';
    // The access policy's matrix knows 'cell.write'; 'range.write' is not a
    // matrix action — fall back to 'cell.write' so the default policy works.
    const actions = multi ? ['range.write', 'cell.write'] : ['cell.write'];
    const target = refToTarget(ref);
    const ctx = { principal };
    const allowed = actions.some((a) => {
      try {
        return this.authorize!(a, target, ctx);
      } catch {
        return false; // unknown action → denied by that probe; try next
      }
    });
    if (!allowed) {
      throw new NameError('permission', `Cannot ${what} name: '${principal}' lacks write on ${target}.`);
    }
  }

  private checkWriteForDef(def: NamedRangeDef, principal: string, what: string): void {
    if (def.ref === null) {
      // Dangling name: no cells left to hold write on. Require manage on
      // the workbook root instead of silently allowing.
      if (!this.authorize) return;
      if (!this.authorize('manage', '', { principal })) {
        throw new NameError('permission', `Cannot ${what} dangling name "${def.name}": manage right required.`);
      }
      return;
    }
    this.checkWrite(def.ref, principal, what);
  }

  /** Read gate for resolveForSubject: same checks as addressing cells. */
  private canRead(def: NamedRangeDef, principal: string): boolean {
    if (!this.authorize) return true; // no policy installed: single-user default
    if (def.ref === null) return true; // dangling: nothing to protect; resolves #REF!
    const multi = def.ref.startRow !== def.ref.endRow || def.ref.startCol !== def.ref.endCol;
    const actions = multi ? ['range.read', 'cell.read'] : ['cell.read'];
    const target = refToTarget(def.ref);
    const ctx = { principal };
    return actions.some((a) => {
      try {
        return this.authorize!(a, target, ctx);
      } catch {
        return false;
      }
    });
  }

  private reindex(def: NamedRangeDef): void {
    for (const [k, v] of this.index) {
      if (v === def.id) this.index.delete(k);
    }
    this.index.set(indexKey(def.scope, def.name), def.id);
  }

  private async load(): Promise<void> {
    const raw = await this.backend.load(NAMES_STORE_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredNames>;
      if (!Array.isArray(parsed.defs)) return;
      for (const d of parsed.defs) {
        if (isStoredDef(d) && !this.defs.has(d.id)) {
          this.defs.set(d.id, { ...d, ref: d.ref ? { ...d.ref } : null });
          this.index.set(indexKey(d.scope, d.name), d.id);
        }
      }
    } catch {
      // Corrupt store: start empty (fail closed on definitions).
    }
  }

  private async save(): Promise<void> {
    const stored: StoredNames = { version: STORE_VERSION, defs: [...this.defs.values()] };
    await this.backend.save(NAMES_STORE_KEY, JSON.stringify(stored));
  }
}

function indexKey(scope: NameScope, name: string): string {
  return `${scopeKey(scope)}\n${nameKey(name)}`;
}

/**
 * Insert `count` lines at `at`: lines at/after `at` shift down; a range
 * spanning `at` expands (Excel behavior).
 */
function shiftInsert(start: number, end: number, at: number, count: number): [number, number] {
  const s = start >= at ? start + count : start;
  const e = end >= at ? end + count : end;
  return [s, e];
}

/**
 * Delete lines [at, at+count): returns the surviving span, or null when the
 * whole range was deleted (→ dangling #REF!).
 */
function shiftDelete(
  start: number,
  end: number,
  at: number,
  count: number,
): [number, number] | null {
  const delStart = at;
  const delEnd = at + count - 1;
  if (end < delStart || start > delEnd) {
    // No overlap: shift when below the deletion.
    const d = start > delEnd ? count : 0;
    return [start - d, end - d];
  }
  if (start >= delStart && end <= delEnd) return null; // fully deleted → dangling
  // Partial overlap: clamp to survivors, shifting the below-deletion part up.
  const s = start < delStart ? start : delEnd + 1 - count;
  const e = end <= delEnd ? delStart - 1 : end - count;
  return [s, e];
}

/**
 * Move the block [from, from+count) to `to` (destination start in the
 * post-removal grid). Ranges inside the block move with it; ranges outside
 * shift; spanning ranges expand to cover.
 */
function shiftMove(
  start: number,
  end: number,
  from: number,
  count: number,
  to: number,
): [number, number] {
  const blockEnd = from + count; // exclusive
  const inBlock = (x: number): boolean => x >= from && x < blockEnd;
  const map = (x: number): number => {
    if (inBlock(x)) return to + (x - from);
    if (to < from) {
      // Block moved up: lines [to, from) shift down by count.
      if (x >= to && x < from) return x + count;
      return x;
    }
    if (to > from) {
      // Block moved down: lines [blockEnd, to+count) shift up by count.
      if (x >= blockEnd && x < to + count) return x - count;
      return x;
    }
    return x;
  };
  const s = map(start);
  const e = map(end);
  return [Math.min(s, e), Math.max(s, e)];
}

function assertPrincipal(principal: string): void {
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new NameError('permission', 'A principal is required (fail closed).');
  }
}

function isStoredDef(d: unknown): d is NamedRangeDef {
  if (typeof d !== 'object' || d === null) return false;
  const r = d as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || typeof r['name'] !== 'string') return false;
  const scope = r['scope'] as { kind?: unknown; sheet?: unknown } | null;
  if (!scope || (scope.kind !== 'workbook' && scope.kind !== 'sheet')) return false;
  if (scope.kind === 'sheet' && typeof scope.sheet !== 'string') return false;
  const ref = r['ref'];
  if (ref !== null && (typeof ref !== 'object' || ref === null)) return false;
  return true;
}
