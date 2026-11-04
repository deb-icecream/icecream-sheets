/**
 * Stable named identities — design-docs/named-ranges-and-named-functions.md §§1-7.
 *
 * Every named range has a STABLE OBJECT ID independent of the cells it
 * covers. The name binds to the identity; HyperFormula's named expressions
 * track the underlying range as rows/columns are inserted, deleted or moved.
 * Deleting all covered cells leaves a dangling name resolving to #REF!,
 * never to whatever moves into the address (§1).
 *
 * Scope: workbook-scoped by default; sheet-scoped names shadow the workbook
 * name within their sheet. Names are case-insensitive and must not parse as
 * a cell reference or collide (case-insensitively) within their scope (§2).
 *
 * Named functions bind a name to user-defined logic (Python, JavaScript,
 * TypeScript, or a LAMBDA expression). They compile to the sandboxed
 * custom-function runtime — the same sandbox formulas can call (§6).
 * Definitions are versioned; formulas evaluate against the current version
 * and old versions are retained for audit/rollback (§7).
 *
 * Permission targets (§4): `name:<id>` (actions name.define/name.delete/
 * name.read) and `function:<id>` (actions function.manage/function.read).
 * The registries take an optional authorize hook installed by the host
 * (EngineHost); with no hook installed every check passes (default-allow
 * single-user policy — the enforcement point is what matters).
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { getPythonProvider } from './extended-functions11.js';

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

const A1_CELL_REF = /^[A-Za-z]+[0-9]+$/;
const R1C1_CELL_REF = /^[Rr][0-9]+[Cc][0-9]+$/;

/**
 * Excel/OpenDocument name syntax: starts with a letter or underscore,
 * continues with letters/digits/underscores/dots, and does not look like a
 * cell reference. HyperFormula (the backing store) follows OpenDocument and
 * rejects ANY letters-followed-by-digits (`[A-Za-z]+[0-9]+`) — stricter than
 * Excel's 3-letter column limit — so the validator matches HF exactly.
 * (design §2: "must not parse as a cell reference or a function name" —
 * function-name collisions are checked against HyperFormula separately.)
 */
export function isValidDefinedName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return false;
  if (A1_CELL_REF.test(name)) return false;
  if (R1C1_CELL_REF.test(name)) return false;
  return true;
}

/** Collision key: scope + case-folded name (design §2: case-insensitive). */
function nameKey(scope: NameScope, name: string): string {
  return `${scope}\n${name.toLowerCase()}`;
}

/** Stable id: `nr_`/`nf_` + 12 hex chars. Never reused, never derived. */
function stableId(prefix: 'nr' | 'nf'): string {
  const hex: string[] = [];
  for (let i = 0; i < 12; i++) hex.push(Math.floor(Math.random() * 16).toString(16));
  return `${prefix}_${hex.join('')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * HyperFormula's unquoted sheet-name charset (hyperformula parser-consts:
 * `[A-Za-z\u00C0-\u02AF0-9_]+`). Sheet names with any other character —
 * notably Cyrillic/CJK scripts — MUST be single-quoted in formulas, or the
 * parse fails ("unexpected character").
 */
const HF_UNQUOTED_SHEET = /^[A-Za-z\u00C0-\u02AF0-9_]+$/;

/**
 * Quote sheet-name prefixes in a refersTo/expression fragment so HyperFormula
 * can parse them: `Лист1!$A$1` → `'Лист1'!$A$1`. Already-quoted names, error
 * tokens (#REF!), names HyperFormula accepts bare, and double-quoted string
 * literals are left untouched.
 */
export function quoteSheetNames(fragment: string): string {
  // Split out "..." literals ("" = escaped quote) so `!` inside strings is safe.
  const parts = fragment.split(/("(?:[^"]|"")*")/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!.replace(
      /(^|[^'’\w])([^'!\s][^'!]*?)!/g,
      (full: string, pre: string, name: string) => {
        if (
          name.length === 0 ||
          name.startsWith('#') ||
          HF_UNQUOTED_SHEET.test(name) ||
          !/\p{L}/u.test(name)
        ) {
          return full;
        }
        return `${pre}'${name.replace(/'/g, "''")}'!`;
      },
    );
  }
  return parts.join('');
}

/** Workbook scope, or a sheet name for sheet-scoped names. */
export type NameScope = 'workbook' | string;

/** Optional host authorize hook: (action, target) => allowed. */
export type NameAuthorizeHook = (action: string, target: string) => boolean;

// ---------------------------------------------------------------------------
// Named ranges (§§1-5)
// ---------------------------------------------------------------------------

export interface NamedRangeDef {
  /** Stable object id, independent of the cells covered. */
  id: string;
  /** Display name (case preserved; resolution is case-insensitive). */
  name: string;
  /** 'workbook', or the owning sheet's name. */
  scope: NameScope;
  /** Refers-to as authored, e.g. "Sheet1!$A$1:$A$10". */
  refersTo: string;
  createdAt: string;
  updatedAt: string;
}

/** A def plus its live state, re-serialized from HyperFormula. */
export interface ResolvedNamedRange extends NamedRangeDef {
  /**
   * Current refers-to after structural edits (HyperFormula tracks the
   * identity). Equals the authored ref when nothing moved.
   */
  liveRefersTo: string;
  /** True when every covered cell was deleted — resolves to #REF!. */
  dangling: boolean;
}

/**
 * Registry of named ranges. Backed by HyperFormula named expressions, which
 * track range identity across row/column insert/delete/move. The registry
 * adds what HyperFormula lacks: stable ids, scope/shadowing rules,
 * case-insensitive collision detection, and permission targets.
 */
/**
 * Options for the named-range registry.
 */
export interface NamedRangeRegistryOptions {
  /**
   * True when `name` is already taken by the engine's legacy named-function
   * path. Ranges and functions share one namespace (§2); a range may not
   * take a legacy function name either.
   */
  isLegacyFunctionName?: (name: string) => boolean;
}

export class NamedRangeRegistry {
  private readonly hf: HyperFormula;
  private readonly sheetIdOf: (name: string) => number | undefined;
  private readonly sheetNameOf: (id: number) => string | undefined;
  private readonly defs = new Map<string, NamedRangeDef>();
  /** scopeKey|lowerName -> id. Shared with the function registry. */
  private readonly keys: Map<string, string>;
  private readonly opts: NamedRangeRegistryOptions;
  private authorize: NameAuthorizeHook | undefined;

  constructor(
    hf: HyperFormula,
    sheetIdOf: (name: string) => number | undefined,
    sheetNameOf: (id: number) => string | undefined,
    sharedKeys?: Map<string, string>,
    opts?: NamedRangeRegistryOptions,
  ) {
    this.hf = hf;
    this.sheetIdOf = sheetIdOf;
    this.sheetNameOf = sheetNameOf;
    this.keys = sharedKeys ?? new Map();
    this.opts = opts ?? {};
  }

  /** Install the host authorize hook (EngineHost wires its Authorizer). */
  setAuthorizeHook(hook: NameAuthorizeHook | undefined): void {
    this.authorize = hook;
  }

  private check(action: string, target: string): void {
    if (this.authorize && !this.authorize(action, target)) {
      throw new Error(`Denied by policy: ${action} ${target}`);
    }
  }

  private scopeId(scope: NameScope): number | undefined {
    if (scope === 'workbook') return undefined;
    const id = this.sheetIdOf(scope);
    if (id === undefined) throw new Error(`Unknown sheet for name scope: ${scope}`);
    return id;
  }

  /**
   * Define a name. Rejects: invalid syntax, cell-ref-like names, function
   * names, and case-insensitive collisions within the scope (design §2:
   * "Creating a colliding name is rejected, never silently renamed").
   */
  define(name: string, refersTo: string, scope: NameScope = 'workbook'): NamedRangeDef {
    const cleanName = name.trim();
    if (!isValidDefinedName(cleanName)) {
      throw new Error(`Invalid name "${name}": use letters, digits, _ and .; must not look like a cell reference.`);
    }
    if (this.isFunctionName(cleanName)) {
      throw new Error(`"${cleanName}" is a function name and cannot be used as a defined name.`);
    }
    if (this.opts.isLegacyFunctionName?.(cleanName)) {
      throw new Error(`"${cleanName}" is already defined as a legacy named function.`);
    }
    const key = nameKey(scope, cleanName);
    if (this.keys.has(key)) {
      throw new Error(`A name "${cleanName}" already exists in ${scope === 'workbook' ? 'workbook' : `sheet "${scope}"`} scope.`);
    }
    const scopeId = this.scopeId(scope);
    // Quote sheet names HyperFormula cannot parse bare (e.g. Cyrillic):
    // without this the named expression holds a "Parsing error" and every
    // formula using the name is #ERROR.
    const cleanRef = quoteSheetNames(refersTo);
    const expr = cleanRef.startsWith('=') ? cleanRef : `=${cleanRef}`;
    this.check('name.define', `name:${cleanName}`);
    try {
      this.hf.addNamedExpression(cleanName, expr, scopeId);
    } catch (e) {
      throw new Error(`Cannot define name "${cleanName}": ${e instanceof Error ? e.message : String(e)}`);
    }
    const def: NamedRangeDef = {
      id: stableId('nr'),
      name: cleanName,
      scope,
      refersTo: expr.slice(1),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.defs.set(def.id, def);
    this.keys.set(key, def.id);
    return { ...def };
  }

  /** Change what an existing name refers to (identity — and id — preserved). */
  updateRefersTo(id: string, refersTo: string): NamedRangeDef {
    const def = this.require(id);
    this.check('name.define', `name:${def.id}`);
    const cleanRef = quoteSheetNames(refersTo);
    const expr = cleanRef.startsWith('=') ? cleanRef : `=${cleanRef}`;
    try {
      this.hf.changeNamedExpression(def.name, expr, this.scopeId(def.scope));
    } catch (e) {
      throw new Error(`Cannot update name "${def.name}": ${e instanceof Error ? e.message : String(e)}`);
    }
    def.refersTo = expr.slice(1);
    def.updatedAt = nowIso();
    return { ...def };
  }

  /** Rename a name: the stable id survives the rename. */
  rename(id: string, newName: string): NamedRangeDef {
    const def = this.require(id);
    const cleanName = newName.trim();
    if (!isValidDefinedName(cleanName)) {
      throw new Error(`Invalid name "${newName}".`);
    }
    if (this.isFunctionName(cleanName)) {
      throw new Error(`"${cleanName}" is a function name and cannot be used as a defined name.`);
    }
    const key = nameKey(def.scope, cleanName);
    const occupant = this.keys.get(key);
    if (occupant !== undefined && occupant !== id) {
      throw new Error(`A name "${cleanName}" already exists in scope.`);
    }
    this.check('name.define', `name:${def.id}`);
    // HyperFormula has no rename: capture the live expression, remove, re-add.
    const live = this.liveExpression(def);
    const scopeId = this.scopeId(def.scope);
    this.hf.removeNamedExpression(def.name, scopeId);
    this.keys.delete(nameKey(def.scope, def.name));
    try {
      this.hf.addNamedExpression(cleanName, live, scopeId);
    } catch (e) {
      // Roll back: restore the old name so the registry never loses it.
      this.hf.addNamedExpression(def.name, live, scopeId);
      this.keys.set(nameKey(def.scope, def.name), id);
      throw new Error(`Cannot rename to "${cleanName}": ${e instanceof Error ? e.message : String(e)}`);
    }
    def.name = cleanName;
    def.updatedAt = nowIso();
    this.keys.set(key, id);
    return { ...def };
  }

  /** Delete a name by stable id. */
  delete(id: string): void {
    const def = this.require(id);
    this.check('name.delete', `name:${def.id}`);
    this.hf.removeNamedExpression(def.name, this.scopeId(def.scope));
    this.keys.delete(nameKey(def.scope, def.name));
    this.defs.delete(id);
  }

  get(id: string): NamedRangeDef | undefined {
    const def = this.defs.get(id);
    return def ? { ...def } : undefined;
  }

  /**
   * Resolve a name for formula use: case-insensitive; a sheet-scoped name
   * shadows the workbook name within its sheet (design §2).
   */
  resolve(name: string, sheetScope?: string): NamedRangeDef | undefined {
    const lower = name.toLowerCase();
    if (sheetScope !== undefined) {
      const id = this.keys.get(nameKey(sheetScope, lower));
      if (id !== undefined) {
        const def = this.defs.get(id);
        if (def) return { ...def };
      }
    }
    const id = this.keys.get(nameKey('workbook', lower));
    if (id === undefined) return undefined;
    const def = this.defs.get(id);
    return def ? { ...def } : undefined;
  }

  /**
   * All defs with live state. liveRefersTo is re-serialized from
   * HyperFormula, so it reflects row/column insert/delete/move; dangling
   * is true when the whole range was deleted (resolves to #REF!, §1).
   */
  list(): ResolvedNamedRange[] {
    const serialized = this.hf.getAllNamedExpressionsSerialized();
    const liveByKey = new Map<string, string>();
    for (const s of serialized) {
      const scopeName =
        s.scope === undefined ? 'workbook' : (this.sheetNameOf(s.scope) ?? `#sheet${s.scope}`);
      liveByKey.set(nameKey(scopeName, s.name), String(s.expression));
    }
    const out: ResolvedNamedRange[] = [];
    for (const def of this.defs.values()) {
      const live = liveByKey.get(nameKey(def.scope, def.name));
      const liveRefersTo = live !== undefined ? live.replace(/^=/, '') : def.refersTo;
      out.push({
        ...def,
        liveRefersTo,
        dangling: /#REF!/.test(liveRefersTo),
      });
    }
    out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return out;
  }

  /**
   * Names referenced by a formula string (case-insensitive token scan).
   * Used by the host for name.read permission checks (design §5).
   * Over-matching (e.g. inside string literals) is fail-safe: it only adds
   * authorize() calls, never skips one.
   */
  namesInFormula(formula: string): NamedRangeDef[] {
    if (this.defs.size === 0) return [];
    const names = [...this.defs.values()].map((d) => d.name).sort((a, b) => b.length - a.length);
    const pattern = names.map(escapeRegExp).join('|');
    const re = new RegExp(`(?<![A-Za-z0-9_.])(?:${pattern})(?![A-Za-z0-9_.])`, 'gi');
    const found = new Map<string, NamedRangeDef>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(formula)) !== null) {
      const def = this.resolve(m[0]);
      // Prefer the sheet-agnostic (workbook) hit; sheet-scoped resolution
      // needs the formula's sheet, handled by the caller via resolve().
      if (def && !found.has(def.id)) found.set(def.id, def);
    }
    return [...found.values()];
  }

  /** Evaluate a name's current value (follows identity through edits). */
  evaluate(name: string, scope?: number): unknown {
    return this.hf.getNamedExpressionValue(name, scope);
  }

  /**
   * name.read check for a range id (design §5). No hook or no auth context
   * = allow (the host installs its Authorizer-backed hook; unauthenticated
   * engine-direct use stays permissive).
   */
  checkRead(id: string, auth: { principal: string } | undefined): boolean {
    if (!this.authorize) return true;
    if (!auth || typeof auth.principal !== 'string' || auth.principal.length === 0) return true;
    return this.authorize('name.read', `name:${id}`);
  }

  private require(id: string): NamedRangeDef {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Unknown named range id: ${id}`);
    return def;
  }

  private liveExpression(def: NamedRangeDef): string {
    for (const s of this.hf.getAllNamedExpressionsSerialized()) {
      const scopeName =
        s.scope === undefined ? 'workbook' : (this.sheetNameOf(s.scope) ?? '');
      if (scopeName === def.scope && s.name.toLowerCase() === def.name.toLowerCase()) {
        return String(s.expression);
      }
    }
    return `=${def.refersTo}`;
  }

  /**
   * True when the name is a known function name (design §2: a defined name
   * "must not parse as ... a function name"). HyperFormula itself allows
   * `=SUM` as a defined name (verified empirically), so the guard is ours.
   * Probe: `=CANDIDATE(1)` evaluates to #NAME? "not recognized" iff the
   * candidate is NOT a function; any other outcome means it is one.
   */
  private readonly functionNameCache = new Map<string, boolean>();
  private isFunctionName(name: string): boolean {
    if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(name)) return false;
    const lower = name.toLowerCase();
    const hit = this.functionNameCache.get(lower);
    if (hit !== undefined) return hit;
    let result = false;
    const probeName = `__fnprobe_${lower}`;
    try {
      this.hf.addNamedExpression(probeName, `=${name}(1)`);
      const value = this.hf.getNamedExpressionValue(probeName) as unknown;
      // Not a function  <=>  #NAME? whose message says "not recognized".
      result = !isNotRecognized(value);
    } catch {
      // Parse-level failure (not a callable shape) → not a function name.
      result = false;
    } finally {
      try {
        this.hf.removeNamedExpression(probeName);
      } catch {
        // Never fails the define for probe cleanup.
      }
    }
    this.functionNameCache.set(lower, result);
    return result;
  }
}

/** #NAME? with HyperFormula's "not recognized" message. */
function isNotRecognized(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    rec['type'] === 'NAME' &&
    typeof rec['message'] === 'string' &&
    /not recognized/i.test(rec['message'])
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
