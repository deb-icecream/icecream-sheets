/**
 * Function inventory for the Insert Function dialog.
 * Generated from the engine versioned function registry
 * (design-docs/platform-shell.md §5) — see ./functionList.ts.
 */
import { ALL_FUNCTIONS, FUNCTION_LIST_VERSION, type FunctionInfo } from './functionList';
import { FUNCTION_REGISTRY_VERSION } from '@icecream-sheets/engine';

export type { FunctionInfo };
export { ALL_FUNCTIONS };
export { FUNCTION_LIST_VERSION };

/**
 * True when the bundled function list was generated from an older registry
 * version than the engine currently reports — i.e. the list is stale and
 * should be regenerated (`node scripts/gen-function-list.mjs` from
 * packages/engine). The Help pane surfaces this to the user.
 */
export function isFunctionListStale(): boolean {
  // Both versions are literal-typed generated constants; the widening
  // cast keeps the cross-version comparison legal for tsc without
  // changing its meaning (flagged by the agent-features coordinator,
  // 2026-10-21: this comparison blocked the web build's tsc step).
  return (FUNCTION_LIST_VERSION as number) !== FUNCTION_REGISTRY_VERSION;
}

/** Group functions by category for the dialog. */
export function getFunctionsByCategory(): Map<string, FunctionInfo[]> {
  const map = new Map<string, FunctionInfo[]>();
  for (const fn of ALL_FUNCTIONS) {
    const list = map.get(fn.category) ?? [];
    list.push(fn);
    map.set(fn.category, list);
  }
  return map;
}

/** Search functions by name prefix/substring. */
export function searchFunctions(query: string): FunctionInfo[] {
  const q = query.trim().toUpperCase();
  if (!q) return ALL_FUNCTIONS;
  return ALL_FUNCTIONS.filter((f) => f.name.includes(q));
}
