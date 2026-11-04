/**
 * Named functions — design-docs/named-ranges-and-named-functions.md §§6-7.
 * Split from names.ts for size; shares its collision map and validation.
 *
 * A named function binds a name to user-defined logic written in Python,
 * JavaScript, TypeScript, or as a LAMBDA expression.
 *
 * - `lambda`: bound as a HyperFormula named expression holding the LAMBDA;
 *   calls evaluate through the engine's ICENAMEDFUNC dispatcher (the tested
 *   parse-time rewrite path — HyperFormula plugins are static/global, so
 *   per-workbook user functions cannot be registered as real functions).
 * - `javascript` / `typescript`: compiled to a restricted synchronous
 *   runner (node:vm under Node, restricted Function scope in browsers) and
 *   invoked by the ICENAMEDFUNC dispatcher, which resolves the CURRENT
 *   version's runner from the ambient call context. TypeScript is limited
 *   to erasable annotations (see stripTypeScript).
 * - `python`: executed through the synchronous Python provider seam
 *   (getPythonProvider — the same sandbox PY() uses).
 *
 * Definitions are versioned (§7): formulas evaluate against the CURRENT
 * version; old versions are retained in `history` for audit/rollback.
 * Updates swap the implementation in place — no formula edits needed.
 * Deleting a function makes calls resolve to #NAME? (correct Excel behavior).
 *
 * Permission targets: `function:<id>` with actions `function.manage`
 * (define/update/delete — §7: "Editing a function requires the manage
 * right on the workbook") and `function.read` ("Using one in a formula
 * requires read"). Denied use evaluates to #PERM!, never #NAME?.
 */
import {
  CellError,
  ErrorType,
  type HyperFormula,
} from 'hyperformula';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { getPythonProvider } from './extended-functions11.js';
import { isValidDefinedName, type NameAuthorizeHook } from './names.js';

export type NamedFunctionLanguage = 'lambda' | 'javascript' | 'typescript' | 'python';
export type NamedFunctionType = 'number' | 'string' | 'boolean' | 'array' | 'any';

export interface NamedFunctionParam {
  name: string;
  type: NamedFunctionType;
}

export interface NamedFunctionSignature {
  params: NamedFunctionParam[];
  returns: NamedFunctionType;
}

export interface NamedFunctionVersion {
  version: number;
  source: string;
  language: NamedFunctionLanguage;
  at: string;
}

export interface NamedFunctionDef {
  /** Stable object id. */
  id: string;
  /** Workbook-scoped, case-insensitive. */
  name: string;
  /** Current version; starts at 1. */
  version: number;
  signature: NamedFunctionSignature;
  language: NamedFunctionLanguage;
  /** LAMBDA expression, JS/TS function body (or arrow), or Python body. */
  source: string;
  /** Old versions, oldest first — audit and rollback (§7). */
  history: NamedFunctionVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface DefineFunctionInput {
  name: string;
  signature: NamedFunctionSignature;
  language: NamedFunctionLanguage;
  source: string;
}

const KNOWN_TYPES: NamedFunctionType[] = ['number', 'string', 'boolean', 'array', 'any'];
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function nowIso(): string {
  return new Date().toISOString();
}

function stableId(): string {
  const hex: string[] = [];
  for (let i = 0; i < 12; i++) hex.push(Math.floor(Math.random() * 16).toString(16));
  return `nf_${hex.join('')}`;
}

function validateSignature(sig: NamedFunctionSignature): void {
  if (!sig || !Array.isArray(sig.params)) throw new Error('Signature needs a params array.');
  const seen = new Set<string>();
  for (const p of sig.params) {
    if (!p || typeof p.name !== 'string' || !IDENT.test(p.name)) {
      throw new Error(`Invalid parameter name: ${JSON.stringify(p?.name)}`);
    }
    if (!KNOWN_TYPES.includes(p.type)) {
      throw new Error(`Unknown parameter type "${p.type}" (use number, string, boolean, array, any).`);
    }
    const lower = p.name.toLowerCase();
    if (seen.has(lower)) throw new Error(`Duplicate parameter name: ${p.name}`);
    seen.add(lower);
  }
  if (!KNOWN_TYPES.includes(sig.returns)) {
    throw new Error(`Unknown return type "${sig.returns}".`);
  }
}

/**
 * Ambient call context for the delegating plugin: which registry's
 * implementation to run, and whose authority to check. HyperFormula
 * evaluates synchronously on one thread and formulas cannot cross
 * workbook instances, so the ambient is always correct. Installed by
 * EngineWorkbook around evaluation (see withFunctionCallContext).
 */
export interface FunctionCallContext {
  registry: NamedFunctionRegistry;
  auth: { principal: string } | undefined;
}

let activeCallContext: FunctionCallContext | undefined;

export function withFunctionCallContext<T>(
  registry: NamedFunctionRegistry,
  auth: { principal: string } | undefined,
  fn: () => T,
): T {
  const prev = activeCallContext;
  activeCallContext = { registry, auth };
  try {
    return fn();
  } finally {
    activeCallContext = prev;
  }
}

/**
 * Thrown (not returned) when a denied function.read is hit inside formula
 * evaluation. EngineWorkbook catches it at the evaluation boundary and
 * maps it to the engine-level #PERM! value — HyperFormula's ErrorType has
 * no permission code, so the mapping lives at our boundary.
 */
export class NamePermissionError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`Permission denied: ${target}`);
    this.name = 'NamePermissionError';
    this.target = target;
  }
}

/** A compiled, callable implementation: JS args in, JS value (or throw) out. */
type Runner = (args: unknown[]) => unknown;

/**
 * Read the ambient call context (installed by EngineWorkbook around
 * evaluation). Used by the ICENAMEDFUNC dispatcher to attribute a call to
 * the right workbook's registry. Undefined outside evaluation.
 */
export function getFunctionCallContext(): FunctionCallContext | undefined {
  return activeCallContext;
}

/**
 * Invoke a registry runner with typed-signature enforcement (design §7):
 * arity and per-argument types are checked, then the return type. Any
 * violation — or a runner throw — becomes a #VALUE! CellError, never an
 * exception escaping the interpreter.
 */
export function invokeRunner(
  entry: { def: NamedFunctionDef; runner: Runner },
  jsArgs: unknown[],
): InterpreterValue {
  try {
    checkArity(entry.def, jsArgs);
    jsArgs.forEach((v, i) =>
      checkValueType(v, entry.def.signature.params[i]!.type, `argument ${i + 1}`),
    );
    const out = entry.runner(jsArgs);
    checkValueType(out, entry.def.signature.returns, 'return value');
    return jsToInterpreter(out);
  } catch (e) {
    return new CellError(
      ErrorType.VALUE,
      e instanceof Error ? e.message : String(e),
    ) as unknown as InterpreterValue;
  }
}

function checkArity(def: NamedFunctionDef, args: unknown[]): void {
  const expected = def.signature.params.length;
  if (args.length !== expected) {
    throw new Error(
      `${def.name} expects ${expected} argument(s), got ${args.length}.`,
    );
  }
}

function checkValueType(v: unknown, t: NamedFunctionType, what: string): void {
  switch (t) {
    case 'any':
      return;
    case 'number':
      if (typeof v !== 'number') throw new Error(`${what} must be a number.`);
      return;
    case 'string':
      if (typeof v !== 'string') throw new Error(`${what} must be a string.`);
      return;
    case 'boolean':
      if (typeof v !== 'boolean') throw new Error(`${what} must be a boolean.`);
      return;
    case 'array':
      if (!Array.isArray(v)) throw new Error(`${what} must be an array.`);
      return;
  }
}

/** InterpreterValue → plain JS (ranges duck-typed via `.data`). */
export function interpreterToJs(v: InterpreterValue): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(interpreterToJs);
  if (typeof v === 'object') {
    const rec = v as unknown as Record<string, unknown>;
    // SimpleRangeValue (duck-typed — do not import HF internals): read .data.
    if (Array.isArray(rec['data'])) return (rec['data'] as unknown[]).map((x: unknown) => interpreterToJs(x as InterpreterValue));
    if (typeof rec['value'] !== 'undefined') return interpreterToJs(rec['value'] as InterpreterValue);
  }
  return null;
}

/** Plain JS → InterpreterValue. */
function jsToInterpreter(v: unknown): InterpreterValue {
  if (v === null || v === undefined) return null as unknown as InterpreterValue;
  if (typeof v === 'number') {
    return (Number.isFinite(v) ? v : new CellError(ErrorType.NUM, 'Non-finite number result.')) as InterpreterValue;
  }
  if (typeof v === 'string' || typeof v === 'boolean') return v as InterpreterValue;
  if (v instanceof CellError) return v as unknown as InterpreterValue;
  if (Array.isArray(v)) {
    const rows = (v.length > 0 && Array.isArray(v[0]) ? v : [v]) as unknown[][];
    const out = rows.map((row) =>
      row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === 'number' || typeof cell === 'string' || typeof cell === 'boolean') return cell;
        throw new Error('Array results must contain only numbers, strings, or booleans.');
      }),
    );
    return out as unknown as InterpreterValue;
  }
  throw new Error('Unsupported return value: use a number, string, boolean, or array.');
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript runners
// ---------------------------------------------------------------------------

type JsRunnerFn = (paramNames: string[], body: string, args: unknown[]) => unknown;

/**
 * Restricted synchronous JS execution. Under Node this is a real vm
 * sandbox (fresh context, Math/JSON only, 1s timeout). In browsers there
 * is no vm — the fallback shadows dangerous globals via parameters
 * (best-effort; documented). For untrusted code, hosts should use the
 * MCP sandbox service instead.
 */
function getJsRunner(): JsRunnerFn {
  try {
    const proc = (globalThis as Record<string, unknown>)['process'] as
      | { getBuiltinModule?: (id: string) => unknown }
      | undefined;
    const getBuiltin = proc?.getBuiltinModule?.bind(proc);
    const vm = getBuiltin?.('node:vm') as
      | { runInNewContext?: (code: string, sandbox: Record<string, unknown>, opts?: Record<string, unknown>) => unknown }
      | undefined;
    if (vm && typeof vm.runInNewContext === 'function') {
      const runInNewContext = vm.runInNewContext.bind(vm);
      return (paramNames, body, args) => {
        const sandbox: Record<string, unknown> = { Math, JSON };
        for (let i = 0; i < paramNames.length; i++) sandbox[paramNames[i] as string] = args[i];
        const code = `(((${paramNames.join(',')}) => { "use strict";\n${body}\n}))(${paramNames.join(',')})`;
        return runInNewContext(code, sandbox, { timeout: 1000 });
      };
    }
  } catch {
    // Fall through to the Function fallback.
  }
  const BLOCKED = [
    'window', 'document', 'globalThis', 'self', 'global', 'process',
    'require', 'module', 'exports', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker',
  ];
  return (paramNames, body, args) => {
    const fn = new Function(
      ...paramNames,
      ...BLOCKED,
      `"use strict";\n${body}`,
    ) as (...a: unknown[]) => unknown;
    return fn(...args, ...BLOCKED.map(() => undefined));
  };
}

/** Split `([params]) => [body]` — null when the source is a plain body. */
function splitArrow(src: string): { params: string[]; body: string } | null {
  const m = /^\s*(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*([\s\S]*)$/.exec(src.trim());
  if (!m) return null;
  const raw = (m[1] !== undefined ? m[1] : m[2]) ?? '';
  const params = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const expr = (m[3] ?? '').trim();
  const body = expr.startsWith('{') ? expr : `return (${expr});`;
  return { params, body };
}

const KNOWN_PRIMITIVES = new Set([
  'number', 'string', 'boolean', 'any', 'void', 'unknown', 'never',
  'null', 'undefined', 'object', 'bigint', 'symbol', 'Array', 'Record',
  'Partial', 'Pick', 'Omit', 'Readonly',
]);

/**
 * Strip TypeScript's erasable annotations. Convention-based and documented:
 * a `: Type` annotation is stripped when Type starts with an UPPERCASE
 * letter or is a known primitive — so `{a: foo}` (object literal over a
 * variable) is preserved while `(a: number)` and `(a: Customer)` are not.
 * `as` casts, optional `?` markers, and non-null `!` are handled. Anything
 * non-erasable (interfaces, type aliases, enums) is rejected with a clear
 * error rather than silently miscompiled.
 */
export function stripTypeScript(src: string): string {
  if (/\b(interface|enum|namespace)\s+[A-Za-z_]/.test(src)) {
    throw new Error(
      'Named function TypeScript supports erasable annotations only (no interfaces, enums, or namespaces).',
    );
  }
  if (/^\s*type\s+[A-Za-z_][\w$]*\s*=/m.test(src)) {
    throw new Error('Named function TypeScript supports erasable annotations only (no type aliases).');
  }
  let out = src;
  // `as Type` casts.
  out = out.replace(/\s+as\s+[A-Za-z_][\w$]*/g, '');
  // `: Type` annotations — Type starts uppercase or is a known primitive.
  // Applied iteratively: strips one annotation per pass, up to N passes.
  const typeName = `(?:[A-Z][\\w$]*|[a-z][\\w$]*)`;
  for (let pass = 0; pass < 10; pass++) {
    const next = out.replace(
      new RegExp(`:\\s*${typeName}(?:\\s*<[^(){};]*>)?(?:\\s*\\[\\])?(?:\\s*\\|\\s*${typeName}(?:\\s*<[^(){};]*>)?(?:\\s*\\[\\])?)*`, 'g'),
      (match) => {
        const name = match.replace(/^:\s*/, '').split(/[<|\[]/)[0]?.trim() ?? '';
        if (/^[A-Z]/.test(name) || KNOWN_PRIMITIVES.has(name)) return '';
        return match; // lowercase unknown identifier — probably a value; keep.
      },
    );
    if (next === out) break;
    out = next;
  }
  // Optional `?` markers left behind: `(a?, b)` → `(a, b)`. `?.` and ternary untouched.
  out = out.replace(/\?(\s*[,)])/g, '$1');
  // Non-null assertions: `x!` → `x` (not `!=` / `!==`).
  out = out.replace(/!([.,();\s]|$)/g, '$1');
  return out;
}

function compileJavaScript(
  def: NamedFunctionDef,
  source: string,
): Runner {
  const paramNames = def.signature.params.map((p) => p.name);
  let body: string;
  const arrow = splitArrow(source);
  if (arrow) {
    if (arrow.params.length !== paramNames.length) {
      throw new Error(
        `${def.name}: arrow function has ${arrow.params.length} parameter(s), signature declares ${paramNames.length}.`,
      );
    }
    for (const p of arrow.params) {
      if (!IDENT.test(p)) throw new Error(`${def.name}: invalid parameter name "${p}".`);
    }
    body = arrow.body;
    // Rebind to the arrow's own parameter names.
    const runner = getJsRunner();
    const names = arrow.params;
    return (args) => runner(names, body, args);
  }
  for (const p of paramNames) {
    if (!IDENT.test(p)) throw new Error(`${def.name}: invalid parameter name "${p}".`);
  }
  body = source;
  const runner = getJsRunner();
  return (args) => runner(paramNames, body, args);
}

function compilePython(def: NamedFunctionDef): Runner {
  const paramNames = def.signature.params.map((p) => p.name);
  for (const p of paramNames) {
    if (!IDENT.test(p)) throw new Error(`${def.name}: invalid parameter name "${p}".`);
  }
  const indented = def.source
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : `    ${line}`))
    .join('\n');
  const code =
    `def __named_fn(${paramNames.join(', ')}):\n${indented}\n` + `result = __named_fn(*args)`;
  return (args: unknown[]) => {
    const provider = getPythonProvider();
    const res = provider.run(code, args);
    if ('error' in res) throw new Error(`Python error in ${def.name}: ${res.error}`);
    return res.value;
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Options for the named-function registry.
 */
export interface NamedFunctionRegistryOptions {
  /**
   * True when `name` is already taken by the engine's legacy named-function
   * path (workbook.defineNamedFunction / the ICENAMEDFUNC dispatcher). A name
   * lives in exactly one system; the registry rejects collisions both ways.
   */
  isLegacyFunctionName?: (name: string) => boolean;
  /**
   * Binder for LAMBDA functions. When provided, LAMBDA call evaluation is
   * delegated to the engine's existing, tested path (named expression +
   * parse-time ICENAMEDFUNC rewrite): bind on define, rebind on update,
   * unbind on delete. The registry keeps owning metadata (ID, typed
   * signature, version history). When absent, the registry binds the LAMBDA
   * named expression directly.
   */
  lambdaBinder?: {
    bind: (name: string, source: string) => void;
    rebind: (name: string, source: string) => void;
    unbind: (name: string) => void;
  };
}

/** Names the engine reserves for its own dispatch machinery. */
const RESERVED_FUNCTION_NAMES = new Set(['ICENAMEDFUNC', 'ICEPERMDENIED']);

export class NamedFunctionRegistry {
  private readonly hf: HyperFormula;
  /** scopeKey|lowerName -> owner id. Shared with the range registry. */
  private readonly keys: Map<string, string>;
  private readonly defs = new Map<string, NamedFunctionDef>();
  /** canonical UPPER name -> { def, runner }. Swapped on version update. */
  private readonly impls = new Map<string, { def: NamedFunctionDef; runner: Runner }>();
  /** Canonical names whose LAMBDA is bound (via binder or directly). */
  private readonly lambdaBound = new Set<string>();
  private readonly opts: NamedFunctionRegistryOptions;
  private authorize: NameAuthorizeHook | undefined;

  constructor(hf: HyperFormula, sharedKeys?: Map<string, string>, opts?: NamedFunctionRegistryOptions) {
    this.hf = hf;
    this.keys = sharedKeys ?? new Map();
    this.opts = opts ?? {};
  }

  setAuthorizeHook(hook: NameAuthorizeHook | undefined): void {
    this.authorize = hook;
  }

  private check(action: string, target: string): void {
    if (this.authorize && !this.authorize(action, target)) {
      throw new Error(`Denied by policy: ${action} ${target}`);
    }
  }

  /** Used by the delegating plugin (ambient call context). */
  runnerFor(canonicalName: string): { def: NamedFunctionDef; runner: Runner } | undefined {
    return this.impls.get(canonicalName);
  }

  /** function.read check for the delegating plugin. */
  checkRead(id: string, auth: { principal: string } | undefined): boolean {
    if (!this.authorize) return true;
    if (!auth || typeof auth.principal !== 'string' || auth.principal.length === 0) return true;
    return this.authorize('function.read', `function:${id}`);
  }

  /**
   * Define a named function (design §7: defining/editing requires the
   * manage right — enforced by the host via the authorize hook).
   */
  define(input: DefineFunctionInput): NamedFunctionDef {
    const name = input.name.trim();
    if (!isValidDefinedName(name)) {
      throw new Error(`Invalid function name "${input.name}".`);
    }
    if (RESERVED_FUNCTION_NAMES.has(name.toUpperCase())) {
      throw new Error(`Reserved name: '${name}' is used by the engine.`);
    }
    if (this.opts.isLegacyFunctionName?.(name)) {
      throw new Error(`"${name}" is already defined as a legacy named function.`);
    }
    const key = `workbook\n${name.toLowerCase()}`;
    if (this.keys.has(key)) {
      throw new Error(`A name "${name}" already exists (names and functions share one namespace).`);
    }
    validateSignature(input.signature);
    this.check('function.manage', `function:${name}`);
    const def: NamedFunctionDef = {
      id: stableId(),
      name,
      version: 1,
      signature: JSON.parse(JSON.stringify(input.signature)) as NamedFunctionSignature,
      language: input.language,
      source: input.source,
      history: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.compileAndRegister(def);
    this.defs.set(def.id, def);
    this.keys.set(key, def.id);
    return cloneDef(def);
  }

  /**
   * Update a function: version bumps, old source retained in history (§7).
   * Formulas evaluate against the new version immediately.
   */
  update(
    id: string,
    patch: { source?: string; signature?: NamedFunctionSignature; language?: NamedFunctionLanguage },
  ): NamedFunctionDef {
    const def = this.require(id);
    this.check('function.manage', `function:${def.id}`);
    def.history.push({
      version: def.version,
      source: def.source,
      language: def.language,
      at: def.updatedAt,
    });
    if (patch.signature !== undefined) {
      validateSignature(patch.signature);
      def.signature = JSON.parse(JSON.stringify(patch.signature)) as NamedFunctionSignature;
    }
    if (patch.language !== undefined) def.language = patch.language;
    if (patch.source !== undefined) def.source = patch.source;
    def.version += 1;
    def.updatedAt = nowIso();
    this.compileAndRegister(def);
    return cloneDef(def);
  }

  /** Roll back to a retained version (audit/rollback, §7). */
  rollback(id: string, version: number): NamedFunctionDef {
    const def = this.require(id);
    this.check('function.manage', `function:${def.id}`);
    const snap = def.history.find((h) => h.version === version);
    if (!snap) throw new Error(`No retained version ${version} for function "${def.name}".`);
    return this.update(id, { source: snap.source, language: snap.language });
  }

  /** Delete: calls resolve to #NAME? afterwards (Excel behavior). */
  delete(id: string): void {
    const def = this.require(id);
    this.check('function.manage', `function:${def.id}`);
    if (def.language === 'lambda') {
      this.lambdaBound.delete(def.name.toUpperCase());
      if (this.opts.lambdaBinder) {
        this.opts.lambdaBinder.unbind(def.name);
      } else {
        try {
          this.hf.removeNamedExpression(def.name);
        } catch {
          // Already gone; the registry is the source of truth.
        }
      }
    } else {
      this.impls.delete(def.name.toUpperCase());
    }
    this.keys.delete(`workbook\n${def.name.toLowerCase()}`);
    this.defs.delete(id);
  }

  get(id: string): NamedFunctionDef | undefined {
    const def = this.defs.get(id);
    return def ? cloneDef(def) : undefined;
  }

  /** Workbook-scoped, case-insensitive. */
  resolve(name: string): NamedFunctionDef | undefined {
    const id = this.keys.get(`workbook\n${name.toLowerCase()}`);
    if (id === undefined) return undefined;
    const def = this.defs.get(id);
    return def ? cloneDef(def) : undefined;
  }

  list(): NamedFunctionDef[] {
    return [...this.defs.values()].map(cloneDef).sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  }

  /** Function names referenced by a formula (for function.read checks). */
  functionsInFormula(formula: string): NamedFunctionDef[] {
    if (this.defs.size === 0) return [];
    const names = [...this.defs.values()].map((d) => d.name).sort((a, b) => b.length - a.length);
    const pattern = names.map(escapeRegExp).join('|');
    // A call site: NAME followed by `(`.
    const re = new RegExp(`(?<![A-Za-z0-9_.])(?:${pattern})(?=\\s*\\()`, 'gi');
    const found = new Map<string, NamedFunctionDef>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(formula)) !== null) {
      const def = this.resolve(m[0]);
      if (def && !found.has(def.id)) found.set(def.id, def);
    }
    return [...found.values()];
  }

  private require(id: string): NamedFunctionDef {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Unknown named function id: ${id}`);
    return def;
  }

  private compileAndRegister(def: NamedFunctionDef): void {
    const canonical = def.name.toUpperCase();
    if (def.language === 'lambda') {
      const src = def.source.trim();
      if (!/^\s*=?\s*LAMBDA\s*\(/i.test(src)) {
        throw new Error(
          `Named function "${def.name}": lambda source must be a LAMBDA expression (e.g. =LAMBDA(x, x*2)).`,
        );
      }
      const expr = src.startsWith('=') ? src : `=${src}`;
      const binder = this.opts.lambdaBinder;
      try {
        if (binder) {
          // The engine's tested LAMBDA call path (named expression +
          // parse-time ICENAMEDFUNC rewrite) evaluates the function; the
          // registry owns only the metadata/versioning.
          if (this.lambdaBound.has(canonical)) binder.rebind(def.name, expr);
          else binder.bind(def.name, expr);
        } else if (this.lambdaBound.has(canonical)) {
          this.hf.changeNamedExpression(def.name, expr);
        } else {
          this.hf.addNamedExpression(def.name, expr);
        }
      } catch (e) {
        throw new Error(
          `Cannot register lambda "${def.name}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      this.lambdaBound.add(canonical);
      // Lambda evaluation goes through the ICENAMEDFUNC dispatcher (bound via
      // the lambda binder); the registry keeps no runner for it.
      return;
    }
    let runner: Runner;
    if (def.language === 'python') {
      runner = compilePython(def);
    } else {
      const jsSource = def.language === 'typescript' ? stripTypeScript(def.source) : def.source;
      runner = compileJavaScript(def, jsSource);
    }
    // Smoke-compile now so definition-time errors surface at define(),
    // not at first call. For JS: build the function eagerly.
    this.impls.set(canonical, { def, runner });
  }

  /**
   * lowerName → display name for every defined function. The workbook feeds
   * this into the parse-time call rewrite (setFormula) alongside the legacy
   * named-function table.
   */
  callNames(): Map<string, string> {
    const out = new Map<string, string>();
    for (const def of this.defs.values()) out.set(def.name.toLowerCase(), def.name);
    return out;
  }
}

function cloneDef(def: NamedFunctionDef): NamedFunctionDef {
  return JSON.parse(JSON.stringify(def)) as NamedFunctionDef;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
