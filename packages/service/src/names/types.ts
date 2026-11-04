/**
 * Shared types for named ranges and named functions.
 *
 * Design-docs/named-ranges-and-named-functions.md:
 * - §1: every named range has a stable object id independent of its cells.
 * - §2: workbook scope by default; sheet scope shadows; case-insensitive;
 *   collisions rejected; names must not parse as cell refs or function names.
 * - §6: named functions bind a name to user logic with a typed signature.
 * - §7: versioned definitions; formulas use the current version.
 *
 * Browser-safe: no Node builtins. The sandboxed execution runtime lives in
 * './node.js' (the '@icecream-sheets/service/names-node' subpath), mirroring
 * the automation lane's browser-safe / node split.
 */

/** 0-based range reference on a sheet. */
export interface NameRangeRef {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Workbook scope (default) or sheet scope (addressed with sheet prefix). */
export type NameScope = { kind: 'workbook' } | { kind: 'sheet'; sheet: string };

/**
 * A named range definition. The stable `id` is the identity; `ref` is the
 * currently tracked range, or null when dangling (all covered cells
 * deleted → resolves to #REF!, never rebinds).
 */
export interface NamedRangeDef {
  /** Stable object id, e.g. 'nr:<uuid>'. Independent of cells. */
  id: string;
  /** Display name as typed by the user (case-insensitive for lookup). */
  name: string;
  scope: NameScope;
  /** Current range, or null when dangling. */
  ref: NameRangeRef | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Value types for named-function signatures (the typed view's scalars). */
export type NamedValueType = 'number' | 'string' | 'boolean' | 'null' | 'array' | 'any';

export const NAMED_VALUE_TYPES: readonly NamedValueType[] = [
  'number',
  'string',
  'boolean',
  'null',
  'array',
  'any',
];

export function isNamedValueType(t: unknown): t is NamedValueType {
  return typeof t === 'string' && (NAMED_VALUE_TYPES as readonly string[]).includes(t);
}

export interface NamedFunctionParam {
  name: string;
  type: NamedValueType;
}

/** Typed signature: argument types + return type (§6). */
export interface NamedFunctionSignature {
  params: NamedFunctionParam[];
  returns: NamedValueType;
}

/** Implementation language for a named function body. */
export type NamedFunctionLanguage = 'javascript' | 'typescript' | 'python';

export const NAMED_FUNCTION_LANGUAGES: readonly NamedFunctionLanguage[] = [
  'javascript',
  'typescript',
  'python',
];

export function isNamedFunctionLanguage(l: unknown): l is NamedFunctionLanguage {
  return typeof l === 'string' && (NAMED_FUNCTION_LANGUAGES as readonly string[]).includes(l);
}

/** One retained version of a named function (§7: audit and rollback). */
export interface NamedFunctionVersion {
  version: number;
  language: NamedFunctionLanguage;
  source: string;
  signature: NamedFunctionSignature;
  /** Compiled LAMBDA expression, or null when not LAMBDA-compilable. */
  lambda: string | null;
  updatedBy: string;
  updatedAt: string;
  note?: string;
}

/**
 * A named function definition: name bound to user logic with a typed
 * signature. `version` is the current version; `versions` retains every
 * superseded version (oldest first) for audit and rollback.
 */
export interface NamedFunctionDef {
  /** Stable object id, e.g. 'nf:<uuid>'. */
  id: string;
  /** Display name (case-insensitive for lookup). */
  name: string;
  language: NamedFunctionLanguage;
  /** Current body source. */
  source: string;
  signature: NamedFunctionSignature;
  /** Compiled LAMBDA expression for the current version (best effort). */
  lambda: string | null;
  version: number;
  versions: NamedFunctionVersion[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Error thrown for name/definition validation and permission failures. */
export class NameError extends Error {
  readonly code: NameErrorCode;
  constructor(code: NameErrorCode, message: string) {
    super(message);
    this.name = 'NameError';
    this.code = code;
  }
}

export type NameErrorCode =
  | 'invalid-name'
  | 'collision'
  | 'reserved'
  | 'not-found'
  | 'invalid-ref'
  | 'invalid-signature'
  | 'compile-failed'
  | 'permission'
  | 'invoke-failed';

/**
 * Case-insensitive lookup key. Excel names are case-insensitive; the store
 * preserves the user's display casing on the def.
 */
export function nameKey(name: string): string {
  return name.toLowerCase();
}

/** Scope key for collision detection: workbook names vs (sheet, name). */
export function scopeKey(scope: NameScope): string {
  return scope.kind === 'workbook' ? 'workbook' : `sheet:${scope.sheet.toLowerCase()}`;
}

// Matches A1-style cell references, e.g. A1, Z99, XFD1048576.
const A1_CELL_REF = /^[A-Za-z]{1,3}[0-9]+$/;
// Matches R1C1-style references, e.g. R1C1, R12C5.
const R1C1_CELL_REF = /^[Rr][0-9]+[Cc][0-9]+$/;

const NAME_SYNTAX = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const MAX_NAME_LENGTH = 255;

export interface NameValidationOptions {
  /**
   * Built-in function names (uppercase) that a defined name must not shadow.
   * The host injects the engine's function inventory; when omitted, only
   * syntax/cell-ref checks apply.
   */
  reservedNames?: ReadonlySet<string>;
}

/**
 * Validate a defined name per §2: syntax, not a cell reference, not a
 * function name. Throws NameError('invalid-name' | 'reserved').
 * Case-insensitivity is handled by callers via nameKey().
 */
export function validateNameSyntax(name: string, opts: NameValidationOptions = {}): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new NameError('invalid-name', `Invalid name: must be 1–${MAX_NAME_LENGTH} characters.`);
  }
  if (!NAME_SYNTAX.test(name)) {
    throw new NameError(
      'invalid-name',
      `Invalid name "${name}": start with a letter or underscore, then letters, digits, _ or .`,
    );
  }
  if (A1_CELL_REF.test(name) || R1C1_CELL_REF.test(name)) {
    throw new NameError('invalid-name', `Invalid name "${name}": must not look like a cell reference.`);
  }
  // Excel also rejects names that collide with R1C1 in any locale and
  // single letters c/C/r/R; the cell-ref regexes above cover the A1 shape.
  if (/^[cCrR]$/.test(name)) {
    throw new NameError('invalid-name', `Invalid name "${name}": reserved single letter.`);
  }
  if (opts.reservedNames?.has(name.toUpperCase())) {
    throw new NameError('reserved', `Invalid name "${name}": it is a built-in function name.`);
  }
}

/** True when `name` is syntactically valid (non-throwing probe). */
export function isValidDefinedName(name: string, opts: NameValidationOptions = {}): boolean {
  try {
    validateNameSyntax(name, opts);
    return true;
  } catch {
    return false;
  }
}
