/**
 * Workbook and sheet protection (track 19).
 *
 * Follows design-docs/workbook-protection-and-encryption.md:
 * - §1 Permission enforcement: protection is enforced by wrapping the
 *   Authorizer's Policy. Every mutation still goes through authorize();
 *   there is no bypass.
 * - §4 Password protection: passwords are salted + hashed (SHA-256, pure
 *   TS so the engine stays dependency-free). Passwords are never stored.
 * - §5 XLSX round-trip: protection flags serialize to workbook metadata
 *   (`icecream.protection.*`) so adapters can persist them as hints, and
 *   per-cell style flags (`icecream.protection.cellflags.*`) ride along
 *   for styles.xml fidelity. Adapters additionally mirror the state into
 *   native `<sheetProtection>` / `<workbookProtection>` / xf protection so
 *   real Excel files interoperate. Service-enforced permissions do not
 *   travel in the file.
 * - §8 Audit: protect/unprotect/failed-unlock attempts are recorded on the
 *   ProtectionManager's own audit log (in addition to the Authorizer log).
 *
 * Design ruling (2026-10-18): the design docs win — v1 is protection AND
 * at-rest encryption. §3 requires workbook data encrypted at rest with
 * service-managed keys (implemented in @icecream-sheets/service crypto.ts /
 * KeyManager); §4 requires password-to-open where the password DERIVES the
 * encryption key (PBKDF2, passwords never stored). This module owns the
 * protection-enforcement half: sheet/workbook protection flags, the
 * Authorizer policy wrapper (§1), XLSX hint round-trip (§5) and the audit
 * log (§8). §9 out of scope for v1: customer-managed keys, field-level
 * encryption, digital signatures.
 */

// ---------------------------------------------------------------------------
// Pure-TypeScript SHA-256 (keeps the engine dependency-free)
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  // Padding: 0x80 then zeros until length ≡ 56 (mod 64), then 64-bit length.
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 64-bit big-endian bit length (high 32 bits are 0 for realistic inputs).
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array<number>(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

/** Salted password hash. The salt is stored; the password never is. */
export function hashPassword(password: string, salt: string): string {
  return sha256Hex(`icecream-sheets:v1:${salt}:${password}`);
}

/** Random 16-byte hex salt. */
export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Protection model
// ---------------------------------------------------------------------------

/** What remains allowed on a protected sheet (Excel-like defaults). */
export interface SheetProtectionOptions {
  /** Allow selecting locked cells (default true, Excel default). */
  selectLockedCells: boolean;
  /** Allow selecting unlocked cells (default true). */
  selectUnlockedCells: boolean;
  /** Allow formatting cells. */
  formatCells: boolean;
  /** Allow formatting columns / rows (Excel's separate checkboxes). */
  formatColumns: boolean;
  formatRows: boolean;
  /** Allow inserting rows/columns. */
  insertRows: boolean;
  insertColumns: boolean;
  /** Allow inserting hyperlinks. */
  insertHyperlinks: boolean;
  /** Allow deleting rows/columns. */
  deleteRows: boolean;
  deleteColumns: boolean;
  /** Allow sorting / filtering. */
  sort: boolean;
  autoFilter: boolean;
  /** Allow pivot tables. */
  pivotTables: boolean;
  /** Allow selecting/using drawing objects (default true, Excel default). */
  objects: boolean;
  /** Allow scenarios (default true, Excel default). */
  scenarios: boolean;
}

export const DEFAULT_SHEET_OPTIONS: SheetProtectionOptions = {
  selectLockedCells: true,
  selectUnlockedCells: true,
  formatCells: false,
  formatColumns: false,
  formatRows: false,
  insertRows: false,
  insertColumns: false,
  insertHyperlinks: false,
  deleteRows: false,
  deleteColumns: false,
  sort: false,
  autoFilter: false,
  pivotTables: false,
  objects: true,
  scenarios: true,
};

/**
 * Workbook-metadata keys carrying protection state (design §5: hints).
 * Single source of truth — the XLSX adapter and the web app use these.
 */
export const PROTECTION_WORKBOOK_META_KEY = 'icecream.protection.workbook';
export const PROTECTION_SHEET_META_PREFIX = 'icecream.protection.sheet.';
export const PROTECTION_HIDDEN_META_PREFIX = 'icecream.protection.hidden.';
/**
 * Per-cell style protection flags (Excel cellXfs locked/hidden), keyed
 * `icecream.protection.cellflags.<sheet>`. Pure file fidelity: the flags
 * are cell properties independent of whether the sheet is protected, so
 * they live outside the sheet-protection state (unprotecting a sheet does
 * not clear them). Enforcement reads the sheet-protection state only.
 */
export const PROTECTION_CELLFLAGS_META_PREFIX = 'icecream.protection.cellflags.';

/**
 * Non-default per-cell protection flags from the file's styles. Only cells
 * differing from the Excel default (locked, formula visible) are present:
 * - `locked: false` — the cell is explicitly unlocked (folded into the
 *   sheet's unlockedRanges on import when the sheet is protected).
 * - `hidden: true` — Excel's "Hidden" xf flag: the cell's FORMULA is hidden
 *   on a protected sheet (the value still shows). This is NOT the face-e
 *   hidden-cell feature (values unreadable to unauthorized principals);
 *   it is preserved here for styles.xml fidelity only.
 */
export interface CellProtectionFlags {
  locked?: false;
  hidden?: true;
}

export interface SheetProtectionState {
  enabled: boolean;
  /** Salted hash; absent when protected without a password. */
  passwordHash?: string;
  salt?: string;
  options: SheetProtectionOptions;
  /** Locked ranges as A1 strings; default is "whole sheet locked". */
  lockedRanges: string[];
  /** Explicitly unlocked ranges (take precedence over lockedRanges). */
  unlockedRanges: string[];
}

export interface WorkbookProtectionState {
  /** Prevent add/delete/rename/hide of sheets. */
  structure: boolean;
  /** Prevent window arrange/resize (desktop). */
  windows: boolean;
  passwordHash?: string;
  salt?: string;
}

export interface ProtectionAuditRecord {
  action:
    | 'sheet.protect'
    | 'sheet.unprotect'
    | 'workbook.protect'
    | 'workbook.unprotect'
    | 'unlock.failed'
    | 'ranges.hide'
    | 'ranges.unhide'
    | 'read.denied';
  target: string;
  principal: string;
  at: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// ProtectionManager
// ---------------------------------------------------------------------------

export class ProtectionManager {
  private sheets = new Map<string, SheetProtectionState>();
  private workbook: WorkbookProtectionState = { structure: false, windows: false };
  private audit: ProtectionAuditRecord[] = [];
  /** sheet -> hidden A1 ranges (face e). */
  private hidden = new Map<string, string[]>();
  /** Principals exempt from hiding (owner always sees). */
  private hiddenExempt = new Set<string>();
  /**
   * Per-cell style protection flags (Excel cellXfs), sheet -> "row:col" ->
   * flags. Fidelity channel for styles.xml round-trip; never consulted by
   * enforcement (see CellProtectionFlags).
   */
  private cellFlags = new Map<string, Record<string, CellProtectionFlags>>();

  /**
   * Replace the per-cell style protection flags for a sheet (from the
   * adapter's styles.xml parse). Entries with no flags are dropped.
   */
  setCellProtectionFlags(sheet: string, flags: Record<string, CellProtectionFlags>): void {
    const clean: Record<string, CellProtectionFlags> = {};
    for (const [key, value] of Object.entries(flags)) {
      if (!/^\d+:\d+$/.test(key) || typeof value !== 'object' || value === null) continue;
      const entry: CellProtectionFlags = {};
      if (value.locked === false) entry.locked = false;
      if (value.hidden === true) entry.hidden = true;
      if (entry.locked !== undefined || entry.hidden !== undefined) clean[key] = entry;
    }
    if (Object.keys(clean).length > 0) this.cellFlags.set(sheet, clean);
    else this.cellFlags.delete(sheet);
  }

  /** Per-cell style protection flags for a sheet ("row:col" -> flags). */
  getCellProtectionFlags(sheet: string): Record<string, CellProtectionFlags> {
    return { ...(this.cellFlags.get(sheet) ?? {}) };
  }

  // -- Sheet protection -----------------------------------------------------

  protectSheet(
    sheet: string,
    password: string | undefined,
    options: Partial<SheetProtectionOptions> = {},
    ctx: { principal: string } = { principal: 'user' },
  ): void {
    const salt = password ? randomSalt() : undefined;
    this.sheets.set(sheet, {
      enabled: true,
      passwordHash: password ? hashPassword(password, salt as string) : undefined,
      salt,
      options: { ...DEFAULT_SHEET_OPTIONS, ...options },
      lockedRanges: [],
      unlockedRanges: [],
    });
    this.log('sheet.protect', sheet, ctx.principal);
  }

  unprotectSheet(sheet: string, password: string | undefined, ctx: { principal: string } = { principal: 'user' }): boolean {
    const state = this.sheets.get(sheet);
    if (!state?.enabled) return true; // not protected: no-op success
    if (state.passwordHash) {
      if (password === undefined || hashPassword(password, state.salt as string) !== state.passwordHash) {
        this.log('unlock.failed', sheet, ctx.principal, 'sheet');
        return false;
      }
    }
    state.enabled = false;
    this.log('sheet.unprotect', sheet, ctx.principal);
    return true;
  }

  isSheetProtected(sheet: string): boolean {
    return this.sheets.get(sheet)?.enabled === true;
  }

  getSheetProtection(sheet: string): SheetProtectionState | undefined {
    return this.sheets.get(sheet);
  }

  /** Mark ranges as locked/unlocked (A1 notation). Unlocked wins on overlap. */
  setLockedRanges(sheet: string, locked: string[], unlocked: string[] = []): void {
    const state = this.sheets.get(sheet);
    if (!state) throw new Error(`ProtectionManager: sheet "${sheet}" has no protection state`);
    state.lockedRanges = [...locked];
    state.unlockedRanges = [...unlocked];
  }

  // -- Hidden ranges (face e: hidden cells are unreadable, everywhere) ------

  /**
   * Hide ranges on a sheet. A hidden cell's value is unreadable to any
   * principal that is not exempt: direct reads return #PERM!, and formulas
   * referencing hidden cells evaluate to #PERM! for those readers (no leak
   * through INDIRECT either). Unlike locked cells, hidden cells show NO
   * indicator to unauthorized viewers — hidden means hidden.
   */
  hideRanges(sheet: string, ranges: string[], ctx: { principal: string } = { principal: 'user' }): void {
    this.hidden.set(sheet, [...ranges]);
    this.log('ranges.hide', sheet, ctx.principal, ranges.join(','));
  }

  unhideRanges(sheet: string, ctx: { principal: string } = { principal: 'user' }): void {
    this.hidden.delete(sheet);
    this.log('ranges.unhide', sheet, ctx.principal);
  }

  getHiddenRanges(sheet: string): string[] {
    return [...(this.hidden.get(sheet) ?? [])];
  }

  /** Principals that may see hidden cells (e.g. the workbook owner). */
  setHiddenExemptPrincipals(principals: string[]): void {
    this.hiddenExempt = new Set(principals);
  }

  isCellHidden(sheet: string, row: number, col: number): boolean {
    const ranges = this.hidden.get(sheet);
    if (!ranges || ranges.length === 0) return false;
    return ranges.some((r) => rangeContains(r, toA1(row, col)));
  }

  /** Is this cell hidden FROM this principal? */
  isHiddenFrom(sheet: string, row: number, col: number, principal: string): boolean {
    if (this.hiddenExempt.has(principal)) return false;
    return this.isCellHidden(sheet, row, col);
  }

  /**
   * Is a cell editable? In Excel, protection locks ALL cells by default;
   * unlockedRanges carve out editable areas.
   */
  isCellEditable(sheet: string, row: number, col: number): boolean {
    const state = this.sheets.get(sheet);
    if (!state?.enabled) return true;
    const a1 = toA1(row, col);
    if (state.unlockedRanges.some((r) => rangeContains(r, a1))) return true;
    if (state.lockedRanges.length === 0) return false; // default: everything locked
    return !state.lockedRanges.some((r) => rangeContains(r, a1));
  }

  // -- Workbook protection ---------------------------------------------------

  protectWorkbook(password: string | undefined, opts: { windows?: boolean } = {}, ctx: { principal: string } = { principal: 'user' }): void {
    const salt = password ? randomSalt() : undefined;
    this.workbook = {
      structure: true,
      windows: opts.windows ?? false,
      passwordHash: password ? hashPassword(password, salt as string) : undefined,
      salt,
    };
    this.log('workbook.protect', '(workbook)', ctx.principal);
  }

  unprotectWorkbook(password: string | undefined, ctx: { principal: string } = { principal: 'user' }): boolean {
    if (!this.workbook.structure && !this.workbook.windows) return true;
    if (this.workbook.passwordHash) {
      if (password === undefined || hashPassword(password, this.workbook.salt as string) !== this.workbook.passwordHash) {
        this.log('unlock.failed', '(workbook)', ctx.principal, 'workbook');
        return false;
      }
    }
    this.workbook = { structure: false, windows: false };
    this.log('workbook.unprotect', '(workbook)', ctx.principal);
    return true;
  }

  isWorkbookProtected(): boolean {
    return this.workbook.structure || this.workbook.windows;
  }

  getWorkbookProtection(): WorkbookProtectionState {
    return { ...this.workbook };
  }

  // -- Policy integration (design §1: enforcement through authorize()) --------

  /**
   * Wrap an inner Policy with protection enforcement. Denied actions:
   * - cell.write / cell.clear on a locked cell of a protected sheet
   *   (face d: locked cells can't be written by unauthorized principals)
   * - cell.read on a hidden cell for a non-exempt principal
   *   (face e: hidden cells are unreadable, no indicator, no leak)
   * - sheet.add / sheet.delete / sheet.rename / sheet.hide when workbook
   *   structure is protected
   * Targets use the EngineHost conventions: cell targets are "Sheet!A1",
   * sheet targets are sheet names.
   */
  protectionPolicy(inner: (action: string, target: string, ctx: { principal: string }) => boolean) {
    return (action: string, target: string, ctx: { principal: string }): boolean => {
      const parsed = parseCellTarget(target);
      if (parsed && (action === 'cell.write' || action === 'cell.clear')) {
        if (!this.isCellEditable(parsed.sheet, parsed.row, parsed.col)) {
          return false;
        }
      }
      if (parsed && action === 'cell.read') {
        if (this.isHiddenFrom(parsed.sheet, parsed.row, parsed.col, ctx.principal)) {
          return false;
        }
      }
      if (
        (action === 'sheet.add' || action === 'sheet.delete' || action === 'sheet.rename' || action === 'sheet.hide') &&
        this.workbook.structure
      ) {
        return false;
      }
      return inner(action, target, ctx);
    };
  }

  // -- XLSX round-trip (design §5: flags travel as hints) ----------------------

  /** Serialize protection flags into workbook metadata. */
  toMetadata(): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (this.isWorkbookProtected()) {
      meta[PROTECTION_WORKBOOK_META_KEY] = {
        structure: this.workbook.structure,
        windows: this.workbook.windows,
        hasPassword: !!this.workbook.passwordHash,
      };
    }
    for (const [sheet, state] of this.sheets) {
      if (state.enabled) {
        meta[`${PROTECTION_SHEET_META_PREFIX}${sheet}`] = {
          options: state.options,
          lockedRanges: state.lockedRanges,
          unlockedRanges: state.unlockedRanges,
          hasPassword: !!state.passwordHash,
        };
      }
    }
    for (const [sheet, ranges] of this.hidden) {
      if (ranges.length > 0) {
        // Hidden ranges travel as hints (design §5). The exempt-principal
        // list is service state and never travels in the file.
        meta[`${PROTECTION_HIDDEN_META_PREFIX}${sheet}`] = { ranges: [...ranges] };
      }
    }
    for (const [sheet, flags] of this.cellFlags) {
      if (Object.keys(flags).length > 0) {
        // Per-cell xf flags are file fidelity (styles.xml), independent of
        // the protection state — they travel even for unprotected sheets.
        meta[`${PROTECTION_CELLFLAGS_META_PREFIX}${sheet}`] = { ...flags };
      }
    }
    return meta;
  }

  /**
   * Restore protection flags from metadata. Password hashes are NOT
   * restored (design §4: passwords are never stored; §5: file-embedded
   * protection is hint-only). Restored sheets are protected without a
   * password until the user re-protects with one.
   */
  fromMetadata(meta: Record<string, unknown>): void {
    const wb = meta[PROTECTION_WORKBOOK_META_KEY] as
      | { structure?: boolean; windows?: boolean }
      | undefined;
    if (wb && (wb.structure || wb.windows)) {
      this.workbook = { structure: !!wb.structure, windows: !!wb.windows };
    }
    for (const [key, value] of Object.entries(meta)) {
      const m = new RegExp(`^${escapeRegExp(PROTECTION_SHEET_META_PREFIX)}(.+)$`).exec(key);
      if (!m || typeof value !== 'object' || value === null) continue;
      const v = value as {
        options?: Partial<SheetProtectionOptions>;
        lockedRanges?: string[];
        unlockedRanges?: string[];
      };
      this.sheets.set(m[1], {
        enabled: true,
        options: { ...DEFAULT_SHEET_OPTIONS, ...v.options },
        lockedRanges: v.lockedRanges ?? [],
        unlockedRanges: v.unlockedRanges ?? [],
      });
    }
    for (const [key, value] of Object.entries(meta)) {
      const m = new RegExp(`^${escapeRegExp(PROTECTION_HIDDEN_META_PREFIX)}(.+)$`).exec(key);
      if (!m || typeof value !== 'object' || value === null) continue;
      const v = value as { ranges?: string[] };
      if (Array.isArray(v.ranges) && v.ranges.length > 0) {
        this.hidden.set(m[1], [...v.ranges]);
      }
    }
    for (const [key, value] of Object.entries(meta)) {
      const m = new RegExp(`^${escapeRegExp(PROTECTION_CELLFLAGS_META_PREFIX)}(.+)$`).exec(key);
      if (!m || typeof value !== 'object' || value === null) continue;
      this.setCellProtectionFlags(m[1], value as Record<string, CellProtectionFlags>);
    }
  }

  // -- Audit (design §8) ------------------------------------------------------

  auditLog(): ProtectionAuditRecord[] {
    return [...this.audit];
  }

  private log(action: ProtectionAuditRecord['action'], target: string, principal: string, detail?: string): void {
    this.audit.push({ action, target, principal, at: new Date().toISOString(), detail });
  }
}

// ---------------------------------------------------------------------------
// A1 helpers (minimal; the engine's toA1 covers formatting)
// ---------------------------------------------------------------------------

/**
 * Parse "A1", "$A$1", "Sheet1!A1" or "Sheet1!$A$1" into a CellRef.
 * defaultSheet is used when the text has no sheet prefix. Returns null when
 * the text is not a cell reference. Used by the formula-leak scanner to
 * resolve INDIRECT("A1")-style dynamic references.
 */
export function parseA1CellRef(
  text: string,
  defaultSheet: string,
): { sheet: string; row: number; col: number } | null {
  const t = text.trim().replace(/\$/g, '');
  const bang = t.lastIndexOf('!');
  let sheet = defaultSheet;
  let cell = t;
  if (bang >= 0) {
    sheet = t.slice(0, bang).replace(/^'|'$/g, '');
    cell = t.slice(bang + 1);
    if (!sheet) return null;
  }
  const rc = a1ToRowCol(cell);
  if (!rc) return null;
  return { sheet, row: rc.row, col: rc.col };
}

/**
 * Parse "A1:B2" (or a single cell) into a range. Returns null when the text
 * is not a range reference.
 */
export function parseA1RangeRef(
  text: string,
  defaultSheet: string,
): { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number } | null {
  const t = text.trim();
  const parts = t.split(':');
  const start = parseA1CellRef(parts[0] ?? '', defaultSheet);
  if (!start) return null;
  const end = parts.length > 1 ? parseA1CellRef(parts[1] ?? '', start.sheet) : start;
  if (!end) return null;
  return {
    sheet: start.sheet,
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toA1(row: number, col: number): string {
  let letters = '';
  let c = col;
  do {
    letters = String.fromCharCode(65 + (c % 26)) + letters;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${letters}${row + 1}`;
}

function a1ToRowCol(a1: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(a1.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

function rangeContains(range: string, a1: string): boolean {
  const cell = a1ToRowCol(a1);
  if (!cell) return false;
  const parts = range.split(':');
  const start = a1ToRowCol(parts[0]);
  if (!start) return false;
  const end = parts[1] ? a1ToRowCol(parts[1]) : start;
  if (!end) return false;
  return (
    cell.row >= Math.min(start.row, end.row) &&
    cell.row <= Math.max(start.row, end.row) &&
    cell.col >= Math.min(start.col, end.col) &&
    cell.col <= Math.max(start.col, end.col)
  );
}

function parseCellTarget(target: string): { sheet: string; row: number; col: number } | null {
  // EngineHost targets come in two shapes: "Sheet1!A1" (reads) and
  // "Sheet1!1,0" (col,row — writes via execute()).
  const bang = target.lastIndexOf('!');
  if (bang < 0) return null;
  const sheet = target.slice(0, bang);
  const rest = target.slice(bang + 1);
  const rc = a1ToRowCol(rest);
  if (rc) return { sheet, row: rc.row, col: rc.col };
  const m = /^(\d+),(\d+)$/.exec(rest);
  if (m) return { sheet, row: Number(m[2]), col: Number(m[1]) };
  return null;
}
