/**
 * Engine binding for named ranges and named functions.
 *
 * Design-docs/named-ranges-and-named-functions.md:
 * - §5: the engine resolves a name to its stable id when the formula is
 *   parsed. The service keeps stable ids; the binding mirrors each
 *   definition into the engine as a HyperFormula named expression (via the
 *   NameEnginePort), which gives parse-time name→identity resolution,
 *   automatic tracking through insert/delete/move, and #REF! when all
 *   covered cells are deleted.
 * - §5: referencing a name the user cannot read evaluates to a permission
 *   error value — bindForSubject binds unreadable names to ICEPERMDENIED(),
 *   which the engine surfaces as the typed-view '#PERM!' value.
 * - §7: named functions bind their CURRENT LAMBDA as a named expression;
 *   the engine's ICENAMEDFUNC dispatcher resolves per evaluation, so version
 *   updates need no formula edits. Functions that don't compile to LAMBDA
 *   (Python, statement bodies) are bound as ICEPERMDENIED-free #VALUE!
 *   explainers... — actually as absent call bindings: calls evaluate to a
 *   #VALUE! naming the service runtime (see defineNamedFunction with
 *   lambda null in the engine).
 *
 * The port is structural so this module never imports the engine package:
 * EngineWorkbook satisfies it directly.
 */
import { formatAbsoluteRef } from './a1.js';
import type { NamedRangeDef } from './types.js';
import type { NamedFunctionDef } from './types.js';
import type { NamedRangeStore } from './namedRanges.js';
import type { NamedFunctionRegistry } from './namedFunctions.js';

/**
 * Minimal engine surface for name binding. Satisfied by EngineWorkbook
 * (packages/engine): addNamedExpression / defineNamedFunction /
 * getNamedExpressionFormula / sheetIndex / listNamedExpressions.
 */
export interface NameEnginePort {
  addNamedExpression(name: string, ref: string, sheetIndex?: number): void;
  changeNamedExpression(name: string, ref: string, sheetIndex?: number): void;
  removeNamedExpression(name: string, sheetIndex?: number): void;
  getNamedExpressionFormula(name: string, sheetIndex?: number): string | undefined;
  listNamedExpressions(sheetIndex?: number): string[];
  defineNamedFunction(name: string, lambda: string | null): void;
  removeNamedFunction(name: string): void;
  sheetIndex(name: string): number | undefined;
  sheetNames(): string[];
}

/** The permission-denied binding the engine renders as #PERM!. */
export const PERM_DENIED_EXPR = '=ICEPERMDENIED()';

export interface BindStats {
  bound: number;
  denied: number;
  dangling: number;
  functions: number;
  functionStubs: number;
}

/**
 * Bind every named range into the engine. With `subject` (+ the store's
 * authorize hook), unreadable names bind to ICEPERMDENIED() instead of their
 * range (§5); without a subject everything binds (single-user default).
 *
 * Dangling names bind as =#REF! (§1: never rebind to moved-in cells).
 */
export function bindNamedRanges(
  store: NamedRangeStore,
  port: NameEnginePort,
  subject?: { principal: string },
): BindStats {
  const stats: BindStats = { bound: 0, denied: 0, dangling: 0, functions: 0, functionStubs: 0 };
  for (const def of store.list()) {
    const scopeIndex = scopeSheetIndex(def, port);
    if (def.scope.kind === 'sheet' && scopeIndex === undefined) continue; // scope gone
    const expr = expressionForDef(store, def, subject);
    if (expr === PERM_DENIED_EXPR) stats.denied++;
    else if (expr === '=#REF!') stats.dangling++;
    else stats.bound++;
    try {
      // changeNamedExpression keeps identity; fall back to add when absent.
      port.changeNamedExpression(def.name, expr, scopeIndex);
    } catch {
      try {
        port.addNamedExpression(def.name, expr, scopeIndex);
      } catch {
        // Invalid in this engine (e.g. name became reserved): skip.
      }
    }
  }
  return stats;
}

function expressionForDef(
  store: NamedRangeStore,
  def: NamedRangeDef,
  subject: { principal: string } | undefined,
): string {
  if (def.ref === null) return '=#REF!';
  if (subject) {
    const r = store.resolveForSubject(def.name, subject.principal, scopeSheetOf(def));
    if (r.status === 'denied') return PERM_DENIED_EXPR;
  }
  return formatAbsoluteRef(def.ref);
}

function scopeSheetOf(def: NamedRangeDef): string | undefined {
  return def.scope.kind === 'sheet' ? def.scope.sheet : undefined;
}

function scopeSheetIndex(def: NamedRangeDef, port: NameEnginePort): number | undefined {
  if (def.scope.kind === 'workbook') return undefined;
  return port.sheetIndex(def.scope.sheet);
}

/**
 * Bind every named function into the engine: the CURRENT version's LAMBDA
 * as a named expression + the call binding for the ICENAMEDFUNC dispatcher
 * (§7). Functions without a LAMBDA compile bind with lambda null — their
 * calls evaluate to a #VALUE! explaining the service runtime is needed.
 */
export function bindNamedFunctions(
  registry: NamedFunctionRegistry,
  port: NameEnginePort,
  subject?: { principal: string },
): { functions: number; stubs: number; denied: number } {
  let functions = 0;
  let stubs = 0;
  let denied = 0;
  for (const def of registry.list()) {
    if (subject && !registry.checkUseAllowed(subject.principal)) {
      denied++;
      continue; // §7: using needs read — don't bind what can't be used
    }
    port.defineNamedFunction(def.name, def.lambda);
    if (def.lambda) functions++;
    else stubs++;
  }
  return { functions, stubs, denied };
}

/** Remove every binding this module created (workbook teardown / rebind). */
export function unbindAll(
  store: NamedRangeStore,
  registry: NamedFunctionRegistry,
  port: NameEnginePort,
): void {
  for (const def of store.list()) {
    try {
      port.removeNamedExpression(def.name, scopeSheetIndex(def, port));
    } catch {
      // Already absent.
    }
  }
  for (const def of registry.list()) {
    try {
      port.removeNamedFunction(def.name);
    } catch {
      // Already absent.
    }
  }
}

/**
 * Full per-subject bind: ranges + functions. Returns combined stats.
 * Use when (re)building a subject's engine view.
 */
export function bindForSubject(
  store: NamedRangeStore,
  registry: NamedFunctionRegistry,
  port: NameEnginePort,
  principal: string,
): BindStats {
  const subject = { principal };
  const rangeStats = bindNamedRanges(store, port, subject);
  const fnStats = bindNamedFunctions(registry, port, subject);
  return {
    ...rangeStats,
    functions: fnStats.functions,
    functionStubs: fnStats.stubs,
    denied: rangeStats.denied + fnStats.denied,
  };
}

/** Bind everything without subject filtering (owner / single-user view). */
export function bindAll(
  store: NamedRangeStore,
  registry: NamedFunctionRegistry,
  port: NameEnginePort,
): BindStats {
  const rangeStats = bindNamedRanges(store, port);
  const fnStats = bindNamedFunctions(registry, port);
  return { ...rangeStats, functions: fnStats.functions, functionStubs: fnStats.stubs };
}
