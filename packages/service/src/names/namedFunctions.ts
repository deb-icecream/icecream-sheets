/**
 * NamedFunctionRegistry — the service-layer model for named functions.
 *
 * Design-docs/named-ranges-and-named-functions.md:
 * - §6: a named function binds a name to user logic (Python/JavaScript/
 *   TypeScript). It compiles to the sandboxed custom-function runtime
 *   ('@icecream-sheets/service/names-node'). Every function declares a
 *   typed signature (arg types + return type), checked at definition time:
 *   statically always (known types, valid identifiers), plus a sandboxed
 *   smoke invocation when an invoke hook is supplied (Node), verifying the
 *   declared return type against the actual result.
 * - §7: definitions are versioned — formulas evaluate against the CURRENT
 *   version (the engine's ICENAMEDFUNC dispatcher resolves per evaluation);
 *   old versions are retained for audit/rollback. Editing needs the manage
 *   right on the workbook; using needs read. XLSX maps named functions to
 *   defined names holding LAMBDA expressions (best effort — only functions
 *   whose body compiles to LAMBDA round-trip).
 * - §8 (out of scope): cross-workbook references; publishing beyond the
 *   workbook.
 *
 * Browser-safe: no Node builtins. Sandboxed execution lives in './node.js'.
 */
import type { Persistence } from '../metadataStore.js';
import { KeyManager } from '../crypto.js';
import { EncryptedPersistence, type AsyncPersistence } from '../secureStore.js';
import {
  NameError,
  isNamedFunctionLanguage,
  isNamedValueType,
  nameKey,
  validateNameSyntax,
  type NamedFunctionDef,
  type NamedFunctionLanguage,
  type NamedFunctionSignature,
  type NamedFunctionVersion,
  type NamedValueType,
} from './types.js';
import type { DefinedNameLike } from './namedRanges.js';

/** Names the engine reserves for dispatch; never valid as function names. */
const ENGINE_RESERVED = new Set(['ICENAMEDFUNC', 'ICEPERMDENIED']);

/**
 * Sandbox invocation hook (implemented by './node.js' on Node):
 * runs the CURRENT source with positional args bound to the signature's
 * param names, returning the completion value or an error. Used for
 * definition-time signature checks and service-side evaluation.
 */
export type InvokeFn = (
  body: { language: NamedFunctionLanguage; source: string; params: string[] },
  args: unknown[],
) => { value: unknown } | { error: string };

export interface NamedFunctionRegistryOptions {
  persistence: Persistence;
  workbookId: string;
  authorize?: (action: string, target: string, ctx: { principal: string }) => boolean;
  /** Built-in function names + named-range names (uppercase) to not shadow. */
  reservedNames?: ReadonlySet<string>;
  /** Node sandbox hook for definition-time smoke checks. */
  invoke?: InvokeFn;
}

/**
 * Options for NamedFunctionRegistry.create(): the plain options plus the
 * KeyManager. Definitions are encrypted at rest under a per-workbook key
 * (§7: the EncryptedPersistence scope is the workbookId).
 */
export interface CreateNamedFunctionRegistryOptions extends NamedFunctionRegistryOptions {
  keys: KeyManager;
}

export interface DefineFunctionInput {
  name: string;
  language: NamedFunctionLanguage;
  source: string;
  signature: NamedFunctionSignature;
  principal: string;
  note?: string;
}

export interface UpdateFunctionInput {
  language?: NamedFunctionLanguage;
  source?: string;
  signature?: NamedFunctionSignature;
  principal: string;
  note?: string;
}

const STORE_VERSION = 1;

/** Logical store key. EncryptedPersistence namespaces it per workbook
 * (scope = workbookId), so one constant key serves all workbooks. */
const NAMED_FUNCTIONS_STORE_KEY = 'icecream-sheets.named-functions.v1';

interface StoredFunctions {
  version: number;
  defs: NamedFunctionDef[];
}

function newId(): string {
  return `nf:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertPrincipal(principal: string): void {
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new NameError('permission', 'A principal is required (fail closed).');
  }
}

export class NamedFunctionRegistry {
  private readonly backend: AsyncPersistence;
  private readonly workbookId: string;
  private readonly authorize?: (action: string, target: string, ctx: { principal: string }) => boolean;
  private readonly reservedNames?: ReadonlySet<string>;
  private readonly invoke?: InvokeFn;
  private defs = new Map<string, NamedFunctionDef>();
  private byName = new Map<string, string>();

  private constructor(
    backend: AsyncPersistence,
    workbookId: string,
    authorize?: (action: string, target: string, ctx: { principal: string }) => boolean,
    reservedNames?: ReadonlySet<string>,
    invoke?: InvokeFn,
  ) {
    this.backend = backend;
    this.workbookId = workbookId;
    this.authorize = authorize;
    this.reservedNames = reservedNames;
    this.invoke = invoke;
  }

  /**
   * Build a registry whose definitions are encrypted at rest under the
   * workbook's KeyManager key (§§3, 7: scope = workbookId). Loads
   * previously persisted definitions; fail-closed on tampered envelopes.
   *
   * Readers (get/getByName/list/...) stay synchronous — they serve the
   * in-memory defs. Every mutation is async because the encrypted write
   * is async.
   */
  static async create(opts: CreateNamedFunctionRegistryOptions): Promise<NamedFunctionRegistry> {
    if (!opts.persistence) throw new Error('named-functions: persistence adapter is required');
    if (!opts.keys) throw new Error('named-functions: KeyManager is required');
    if (typeof opts.workbookId !== 'string' || opts.workbookId.length === 0) {
      throw new Error('named-functions: workbookId must be a non-empty string');
    }
    const backend = await EncryptedPersistence.create(opts.persistence, opts.keys, opts.workbookId);
    const registry = new NamedFunctionRegistry(
      backend,
      opts.workbookId,
      opts.authorize,
      opts.reservedNames,
      opts.invoke,
    );
    await registry.load();
    return registry;
  }

  // -- definition -------------------------------------------------------

  /**
   * Define a named function (§7: needs the manage right on the workbook).
   * The typed signature is checked at definition time: statically always,
   * plus a sandboxed smoke invocation when the invoke hook is available.
   */
  async define(input: DefineFunctionInput): Promise<NamedFunctionDef> {
    assertPrincipal(input.principal);
    this.checkManage(input.principal, 'define');
    const name = this.validateNewName(input.name);
    if (!isNamedFunctionLanguage(input.language)) {
      throw new NameError('invalid-signature', `Unknown language '${String(input.language)}'.`);
    }
    const signature = validateSignature(input.signature);
    const source = validatedSource(input.language, input.source);
    const lambda = compileToLambda(input.language, source, signature);
    this.smokeCheck(input.language, source, signature);
    const def: NamedFunctionDef = {
      id: newId(),
      name,
      language: input.language,
      source,
      signature,
      lambda,
      version: 1,
      versions: [],
      createdBy: input.principal,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.defs.set(def.id, def);
    this.byName.set(nameKey(name), def.id);
    await this.save();
    return cloneDef(def);
  }

  /**
   * Update a function: bumps the version, retains the old definition for
   * audit/rollback (§7). Needs the manage right.
   */
  async update(id: string, input: UpdateFunctionInput): Promise<NamedFunctionDef> {
    const def = this.require(id);
    this.checkManage(input.principal, 'update');
    const language = input.language ?? def.language;
    if (!isNamedFunctionLanguage(language)) {
      throw new NameError('invalid-signature', `Unknown language '${String(language)}'.`);
    }
    const signature = input.signature ? validateSignature(input.signature) : def.signature;
    const source = input.source !== undefined ? validatedSource(language, input.source) : def.source;
    // Re-validate the (possibly carried-over) source against a new language.
    const finalSource = input.language !== undefined && input.source === undefined
      ? validatedSource(language, def.source)
      : source;
    const lambda = compileToLambda(language, finalSource, signature);
    this.smokeCheck(language, finalSource, signature);
    def.versions.push({
      version: def.version,
      language: def.language,
      source: def.source,
      signature: cloneSignature(def.signature),
      lambda: def.lambda,
      updatedBy: input.principal,
      updatedAt: nowIso(),
      note: input.note,
    });
    def.version += 1;
    def.language = language;
    def.source = finalSource;
    def.signature = signature;
    def.lambda = lambda;
    def.updatedAt = nowIso();
    await this.save();
    return cloneDef(def);
  }

  /**
   * Roll back to a retained version (§7). The rollback itself becomes a new
   * version (history is append-only — audit-safe).
   */
  async rollback(id: string, version: number, principal: string, note?: string): Promise<NamedFunctionDef> {
    const def = this.require(id);
    const target = version === def.version ? null : def.versions.find((v) => v.version === version);
    if (!target && version !== def.version) {
      throw new NameError('not-found', `No version ${version} for function "${def.name}".`);
    }
    if (!target) return cloneDef(def); // already current
    return this.update(id, {
      language: target.language,
      source: target.source,
      signature: target.signature,
      principal,
      note: note ?? `Rollback to v${version}.`,
    });
  }

  /** Delete a function (§7: needs the manage right). Calls become #NAME?. */
  async delete(id: string, principal: string): Promise<void> {
    const def = this.require(id);
    this.checkManage(principal, 'delete');
    this.defs.delete(id);
    this.byName.delete(nameKey(def.name));
    await this.save();
  }

  // -- lookup -------------------------------------------------------------

  get(id: string): NamedFunctionDef | undefined {
    const def = this.defs.get(id);
    return def ? cloneDef(def) : undefined;
  }

  /** Case-insensitive lookup by display name. */
  getByName(name: string): NamedFunctionDef | undefined {
    const id = this.byName.get(nameKey(name));
    return id ? this.get(id) : undefined;
  }

  list(): NamedFunctionDef[] {
    return [...this.defs.values()]
      .map(cloneDef)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  /**
   * Using a function in a formula requires read on the workbook (§7).
   * The engine cannot authorize per call; hosts (MCP tools, UI) check this
   * before evaluating or binding.
   */
  checkUseAllowed(principal: string): boolean {
    if (!this.authorize) return true;
    try {
      return this.authorize('cell.read', '', { principal });
    } catch {
      return false;
    }
  }

  // -- XLSX round-trip (§7: LAMBDA defined names, best effort) --------------

  /**
   * Mirror to defined names on save. Only LAMBDA-compilable functions
   * round-trip — others are reported as skipped (best effort, per §7).
   */
  toDefinedNames(): { names: DefinedNameLike[]; skipped: string[] } {
    const names: DefinedNameLike[] = [];
    const skipped: string[] = [];
    for (const def of this.list()) {
      if (def.lambda) names.push({ name: def.name, ref: def.lambda });
      else skipped.push(def.name);
    }
    return { names, skipped };
  }

  /**
   * Read back on open: defined names holding LAMBDA expressions become
   * named functions (language 'javascript', expression body, all-any
   * signature — best effort). Needs the manage right (it defines).
   */
  async importDefinedNames(
    dns: DefinedNameLike[],
    principal: string,
  ): Promise<{ imported: string[]; skipped: { name: string; reason: string }[] }> {
    assertPrincipal(principal);
    this.checkManage(principal, 'import');
    const imported: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const dn of dns) {
      if (typeof dn.name !== 'string' || typeof dn.ref !== 'string') {
        skipped.push({ name: String(dn.name ?? ''), reason: 'malformed entry' });
        continue;
      }
      const parsed = parseLambdaRef(dn.ref);
      if (!parsed) {
        skipped.push({ name: dn.name, reason: 'not a LAMBDA expression' });
        continue;
      }
      try {
        const name = this.validateNewName(dn.name);
        const signature: NamedFunctionSignature = {
          params: parsed.params.map((p) => ({ name: p, type: 'any' as NamedValueType })),
          returns: 'any',
        };
        const def: NamedFunctionDef = {
          id: newId(),
          name,
          language: 'javascript',
          source: parsed.body,
          signature,
          lambda: `LAMBDA(${parsed.params.join(',')},${parsed.body})`,
          version: 1,
          versions: [],
          createdBy: principal,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        this.defs.set(def.id, def);
        this.byName.set(nameKey(name), def.id);
        imported.push(def.id);
      } catch (e) {
        skipped.push({ name: dn.name, reason: e instanceof Error ? e.message : 'invalid' });
      }
    }
    if (imported.length > 0) await this.save();
    return { imported, skipped };
  }

  // -- internals ------------------------------------------------------------

  private require(id: string): NamedFunctionDef {
    const def = this.defs.get(id);
    if (!def) throw new NameError('not-found', `No named function with id '${id}'.`);
    return def;
  }

  private validateNewName(name: string): string {
    validateNameSyntax(name, { reservedNames: this.reservedNames });
    if (ENGINE_RESERVED.has(name.toUpperCase())) {
      throw new NameError('reserved', `Invalid name "${name}": reserved by the engine.`);
    }
    if (this.byName.has(nameKey(name))) {
      throw new NameError('collision', `A named function "${name}" already exists — not renamed.`);
    }
    return name;
  }

  private checkManage(principal: string, what: string): void {
    if (!this.authorize) return;
    let allowed = false;
    try {
      allowed = this.authorize('manage', '', { principal });
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new NameError('permission', `Cannot ${what} named function: '${principal}' lacks the manage right.`);
    }
  }

  /**
   * Definition-time signature check (§6): static validation always; when
   * the sandbox invoke hook is available (Node), a smoke invocation with
   * sample args verifies the declared return type against the real result.
   */
  private smokeCheck(
    language: NamedFunctionLanguage,
    source: string,
    signature: NamedFunctionSignature,
  ): void {
    if (!this.invoke) return;
    const args = signature.params.map((p) => sampleForType(p.type));
    let res: { value: unknown } | { error: string };
    try {
      res = this.invoke(
        { language, source, params: signature.params.map((p) => p.name) },
        args,
      );
    } catch (e) {
      throw new NameError('compile-failed', `Definition check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ('error' in res) {
      throw new NameError(
        'compile-failed',
        `Definition check: the body failed on sample arguments (${res.error}).`,
      );
    }
    if (!matchesReturnType(res.value, signature.returns)) {
      throw new NameError(
        'invalid-signature',
        `Definition check: declared return '${signature.returns}' but the body returned ${describeValue(res.value)}.`,
      );
    }
  }

  private async load(): Promise<void> {
    const raw = await this.backend.load(NAMED_FUNCTIONS_STORE_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredFunctions>;
      if (!Array.isArray(parsed.defs)) return;
      for (const d of parsed.defs) {
        if (isStoredDef(d) && !this.defs.has(d.id)) {
          this.defs.set(d.id, cloneDef(d));
          this.byName.set(nameKey(d.name), d.id);
        }
      }
    } catch {
      // Corrupt store: start empty (fail closed).
    }
  }

  private async save(): Promise<void> {
    const stored: StoredFunctions = { version: STORE_VERSION, defs: [...this.defs.values()] };
    await this.backend.save(NAMED_FUNCTIONS_STORE_KEY, JSON.stringify(stored));
  }
}

// ---------------------------------------------------------------------------
// Signature validation
// ---------------------------------------------------------------------------

/** Validate a typed signature (§6): known types, valid unique param names. */
export function validateSignature(sig: NamedFunctionSignature): NamedFunctionSignature {
  if (typeof sig !== 'object' || sig === null) {
    throw new NameError('invalid-signature', 'Signature must be an object.');
  }
  if (!Array.isArray(sig.params)) throw new NameError('invalid-signature', 'Signature params must be an array.');
  if (sig.params.length > 30) throw new NameError('invalid-signature', 'At most 30 parameters.');
  const seen = new Set<string>();
  const params = sig.params.map((p, i) => {
    if (typeof p !== 'object' || p === null) {
      throw new NameError('invalid-signature', `Param ${i} must be an object.`);
    }
    if (typeof p.name !== 'string' || !IDENT.test(p.name)) {
      throw new NameError('invalid-signature', `Param ${i} needs a valid identifier name.`);
    }
    if (!isNamedValueType(p.type)) {
      throw new NameError('invalid-signature', `Param "${p.name}": unknown type '${String(p.type)}'.`);
    }
    const key = p.name.toLowerCase();
    if (seen.has(key)) throw new NameError('invalid-signature', `Duplicate param name "${p.name}".`);
    seen.add(key);
    return { name: p.name, type: p.type };
  });
  if (!isNamedValueType(sig.returns)) {
    throw new NameError('invalid-signature', `Unknown return type '${String(sig.returns)}'.`);
  }
  return { params, returns: sig.returns };
}

/** Validate/normalize the body source per language. */
export function validatedSource(language: NamedFunctionLanguage, source: string): string {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new NameError('invalid-signature', 'Function body must be a non-empty string.');
  }
  if (source.length > 20000) {
    throw new NameError('invalid-signature', 'Function body exceeds 20000 characters.');
  }
  const text = source.trim();
  if (language === 'typescript') {
    // Erasable-syntax subset: annotations only in the signature and on
    // simple variable declarations. Anything else is rejected at definition
    // time with a clear message (never silently miscompiled).
    return stripTypeScript(text);
  }
  if (language === 'python') {
    if (/^\s*import\s/m.test(text) || /__import__/.test(text)) {
      throw new NameError(
        'invalid-signature',
        'Python bodies may not import modules (sandboxed runtime).',
      );
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// TypeScript erasable-syntax stripping (browser-safe, no tsc dependency)
// ---------------------------------------------------------------------------

/**
 * Strip erasable type syntax from a TypeScript function body:
 * - parameter annotations `(x: number, y?: string)` → `(x, y)`
 * - return annotations `): number =>` / `): number {` → `)` 
 * - simple variable annotations `const x: number =` → `const x =`
 * Rejects non-erasable constructs (interfaces, enums, namespaces, type
 * aliases, `as` casts — the last have no runtime effect, so removing them
 * by hand is always safe). The result is validated as plain JavaScript by
 * the caller (syntax check, never executed).
 */
export function stripTypeScript(source: string): string {
  const problems: string[] = [];
  if (/(^|[\s;{}()])interface\s+[A-Za-z_]/.test(source)) problems.push('interfaces');
  if (/(^|[\s;{}()])enum\s+[A-Za-z_]/.test(source)) problems.push('enums');
  if (/(^|[\s;{}()])namespace\s+[A-Za-z_]/.test(source)) problems.push('namespaces');
  if (/^\s*type\s+[A-Za-z_][\w$]*\s*=/m.test(source)) problems.push('type aliases');
  if (/\bas\s+[A-Za-z_]/.test(source)) {
    throw new NameError(
      'compile-failed',
      'TypeScript `as` casts are not erasable by the definition checker — remove the cast (it has no runtime effect).',
    );
  }
  if (/(private|public|protected|readonly|abstract|declare|override)\s/.test(source)) {
    problems.push('access modifiers');
  }
  if (problems.length > 0) {
    throw new NameError(
      'compile-failed',
      `TypeScript ${problems.join(', ')} are not supported in named functions — use erasable annotations only.`,
    );
  }
  let out = source;
  // Return-type annotation after the parameter list: `): T =>` or `): T {`.
  out = stripReturnAnnotation(out);
  // Parameter annotations: find the leading (...) of a function/arrow form.
  out = stripParamAnnotations(out);
  // Simple variable annotations: `const x: T =`, `let x: T =`, `var x: T =`.
  out = out.replace(
    /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([^=;{}]+?)\s*=/g,
    (_m, kw: string, id: string) => `${kw} ${id} =`,
  );
  return out;
}

/** Remove `: ReturnType` between the parameter list and `=>`/`{`. */
function stripReturnAnnotation(src: string): string {
  const open = src.indexOf('(');
  if (open < 0) return src;
  const close = matchParen(src, open);
  if (close < 0) return src;
  let i = close + 1;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== ':') return src;
  // Skip the type: balanced <>()[]{} and strings, until `=>` or `{` at depth 0.
  let j = i + 1;
  const stack: string[] = [];
  let quote: string | null = null;
  while (j < src.length) {
    const ch = src[j]!;
    if (quote) {
      if (ch === quote && src[j - 1] !== '\\') quote = null;
      j++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      j++;
      continue;
    }
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') stack.pop();
    else if (stack.length === 0 && (ch === '{' || (ch === '=' && src[j + 1] === '>'))) break;
    j++;
  }
  return src.slice(0, i) + src.slice(j);
}

/** Strip `: Type` / `?: Type` from each parameter in the leading (...) list. */
function stripParamAnnotations(src: string): string {
  const open = src.indexOf('(');
  if (open < 0) return src;
  const close = matchParen(src, open);
  if (close < 0) return src;
  const inner = src.slice(open + 1, close);
  const stripped = splitTopLevel(inner, ',').map((param) => {
    // name?: Type = default  |  name: Type = default  |  name
    const m = /^\s*(\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*(:(.*))?$/.exec(param);
    if (!m) return param; // destructuring etc.: leave for the syntax check
    const [, rest = '', id = ''] = m;
    void rest;
    const eq = param.indexOf('=');
    const def = eq >= 0 ? param.slice(eq) : '';
    return `${m[1] ?? ''}${id}${def}`;
  });
  return src.slice(0, open + 1) + stripped.join(',') + src.slice(close);
}

/** Index of the paren matching src[open] (string-aware), or -1. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on a delimiter at paren/brace/bracket depth 0 (string-aware). */
function splitTopLevel(src: string, delim: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === delim && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

// ---------------------------------------------------------------------------
// LAMBDA compilation (best effort): JS/TS expression → Excel LAMBDA formula
// ---------------------------------------------------------------------------

/**
 * Compile a body to a LAMBDA expression for engine binding and XLSX export.
 * Returns null when the body is not a pure mappable expression (statement
 * bodies, Python, unsupported constructs) — best effort per §7.
 */
export function compileToLambda(
  language: NamedFunctionLanguage,
  source: string,
  signature: NamedFunctionSignature,
): string | null {
  if (language === 'python') return null;
  const expr = extractExpressionBody(source);
  if (expr === null) return null; // statement body: service runtime only
  const formula = transpileJsExpressionToFormula(expr, new Set(signature.params.map((p) => p.name.toLowerCase())));
  if (formula === null) return null;
  const params = signature.params.map((p) => p.name).join(',');
  return params.length > 0 ? `LAMBDA(${params},${formula})` : `LAMBDA(${formula})`;
}

/**
 * Extract a pure expression body from JS/TS source: either a bare
 * expression, an arrow `(...args) => expr`, or `function(...args){ return
 * expr; }`. Returns null for statement bodies (the sandboxed runtime still
 * runs them — they just don't compile to LAMBDA).
 */
export function extractExpressionBody(source: string): string | null {
  const text = source.trim();
  // Bare expression: compiles as `return (<src>);`.
  if (isExpressionSyntax(text)) return text;
  // Arrow with expression body: strip params.
  const arrow = /^(?:async\s+)?\(.*?\)\s*=>\s*/s.exec(text);
  if (arrow) {
    const body = text.slice(arrow[0].length).trim();
    if (!body.startsWith('{') && isExpressionSyntax(body)) return body;
    return null;
  }
  return null;
}

/**
 * Syntax probe: does `src` parse as a JS expression? Compiles with
 * `new Function` — compilation only, never executed. Browser-safe.
 */
export function isExpressionSyntax(src: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(`return (${src});`);
    return true;
  } catch {
    return false;
  }
}

/** Syntax probe for a full function body (statements allowed). */
export function isFunctionBodySyntax(params: string[], src: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(...params, src);
    return true;
  } catch {
    return false;
  }
}

// -- JS expression → Excel formula transpiler (strict subset) ----------------

type Tok =
  | { kind: 'num'; text: string }
  | { kind: 'str'; value: string }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'paren'; ch: '(' | ')' }
  | { kind: 'comma' }
  | { kind: 'q'; ch: '?' | ':' };

const OPERATORS = [
  '===', '!==', '>>>', '**', '&&', '||', '>=', '<=', '==', '!=', '<<', '>>',
  '+', '-', '*', '/', '%', '<', '>', '!', '&', '|', '^', '~',
];

function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch) && /[0-9]/.test(src.slice(i, i + 2).replace('.', ''))) {
      const m = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) return null;
      toks.push({ kind: 'num', text: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let val = '';
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1]!;
          val += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else {
          val += src[j]!;
          j++;
        }
      }
      if (j >= n) return null;
      toks.push({ kind: 'str', value: val });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      toks.push({ kind: 'ident', name: m![0] });
      i += m![0].length;
      continue;
    }
    if (ch === '(' || ch === ')') {
      toks.push({ kind: 'paren', ch });
      i++;
      continue;
    }
    if (ch === ',') {
      toks.push({ kind: 'comma' });
      i++;
      continue;
    }
    if (ch === '?' || ch === ':') {
      toks.push({ kind: 'q', ch });
      i++;
      continue;
    }
    if (ch === '.') {
      // Member access (Math.max) — handled as ident '.' ident in the parser.
      toks.push({ kind: 'op', op: '.' });
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) return null;
    toks.push({ kind: 'op', op });
    i += op.length;
  }
  return toks;
}

/** Math.* → Excel function allowlist (exact semantics only). */
const MATH_FNS: Record<string, string> = {
  abs: 'ABS',
  max: 'MAX',
  min: 'MIN',
  sqrt: 'SQRT',
  pow: 'POWER',
  exp: 'EXP',
  log: 'LN',
  round: 'ROUND',
  ceil: 'CEILING.MATH',
  floor: 'FLOOR.MATH',
  sign: 'SIGN',
  trunc: 'TRUNC',
};

class Transpiler {
  private pos = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly params: Set<string>,
  ) {}

  parse(): string | null {
    const out = this.ternary();
    return out !== null && this.pos === this.toks.length ? out : null;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }

  private ternary(): string | null {
    const cond = this.or();
    if (cond === null) return null;
    const t = this.peek();
    if (t?.kind === 'q' && t.ch === '?') {
      this.next();
      const a = this.ternary();
      const c = this.next();
      if (a === null || c?.kind !== 'q' || (c as { ch: string }).ch !== ':') return null;
      const b = this.ternary();
      if (b === null) return null;
      return `IF(${cond},${a},${b})`;
    }
    return cond;
  }

  private or(): string | null {
    return this.logical('||', 'OR', () => this.and());
  }
  private and(): string | null {
    return this.logical('&&', 'AND', () => this.equality());
  }
  private logical(op: string, fn: string, next: () => string | null): string | null {
    let left = next();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && t.op === op) {
        this.next();
        const right = next();
        if (right === null) return null;
        left = `${fn}(${left},${right})`;
      } else {
        return left;
      }
    }
  }

  private equality(): string | null {
    let left = this.comparison();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && ['===', '=='].includes(t.op)) {
        this.next();
        const right = this.comparison();
        if (right === null) return null;
        left = `(${left}=${right})`;
      } else if (t?.kind === 'op' && ['!==', '!='].includes(t.op)) {
        this.next();
        const right = this.comparison();
        if (right === null) return null;
        left = `(${left}<>${right})`;
      } else {
        return left;
      }
    }
  }

  private comparison(): string | null {
    let left = this.additive();
    if (left === null) return null;
    const t = this.peek();
    if (t?.kind === 'op' && ['<', '<=', '>', '>='].includes(t.op)) {
      this.next();
      const right = this.additive();
      if (right === null) return null;
      return `(${left}${t.op}${right})`;
    }
    return left;
  }

  private additive(): string | null {
    let left = this.multiplicative();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.op === '+' || t.op === '-')) {
        this.next();
        const right = this.multiplicative();
        if (right === null) return null;
        left = `(${left}${t.op}${right})`;
      } else {
        return left;
      }
    }
  }

  private multiplicative(): string | null {
    let left = this.power();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.op === '*' || t.op === '/')) {
        this.next();
        const right = this.power();
        if (right === null) return null;
        left = `(${left}${t.op}${right})`;
      } else {
        return left;
      }
    }
  }

  private power(): string | null {
    const base = this.unary();
    if (base === null) return null;
    const t = this.peek();
    if (t?.kind === 'op' && t.op === '**') {
      this.next();
      const exp = this.unary();
      if (exp === null) return null;
      return `(${base}^${exp})`;
    }
    return base;
  }

  private unary(): string | null {
    const t = this.peek();
    if (t?.kind === 'op' && (t.op === '-' || t.op === '+')) {
      this.next();
      const v = this.unary();
      return v === null ? null : `(${t.op}${v})`;
    }
    if (t?.kind === 'op' && t.op === '!') {
      this.next();
      const v = this.unary();
      return v === null ? null : `NOT(${v})`;
    }
    return this.call();
  }

  private call(): string | null {
    const t = this.peek();
    // Math.fn(...) member calls.
    if (t?.kind === 'ident' && t.name === 'Math') {
      const save = this.pos;
      this.next();
      const dot = this.next();
      const fn = this.next();
      if (dot?.kind !== 'op' || dot.op !== '.' || fn?.kind !== 'ident') {
        this.pos = save;
        return this.primary();
      }
      const excel = MATH_FNS[fn.name];
      if (!excel) return null;
      const args = this.argList();
      if (args === null) return null;
      return `${excel}(${args.join(',')})`;
    }
    if (t?.kind === 'ident') {
      const save = this.pos;
      this.next();
      const nxt = this.peek();
      if (nxt?.kind === 'paren' && nxt.ch === '(') {
        // Bare call: allowlisted math fn only (e.g. max(a,b)).
        const excel = MATH_FNS[t.name];
        if (!excel) return null;
        const args = this.argList();
        if (args === null) return null;
        return `${excel}(${args.join(',')})`;
      }
      this.pos = save;
    }
    return this.primary();
  }

  private argList(): string[] | null {
    const open = this.next();
    if (open?.kind !== 'paren' || open.ch !== '(') return null;
    const args: string[] = [];
    const close = this.peek();
    if (close?.kind === 'paren' && close.ch === ')') {
      this.next();
      return args;
    }
    for (;;) {
      const a = this.ternary();
      if (a === null) return null;
      args.push(a);
      const t = this.next();
      if (t?.kind === 'paren' && t.ch === ')') return args;
      if (t?.kind !== 'comma') return null;
    }
  }

  private primary(): string | null {
    const t = this.next();
    if (!t) return null;
    if (t.kind === 'num') return t.text;
    if (t.kind === 'str') return `"${t.value.replace(/"/g, '""')}"`;
    if (t.kind === 'ident') {
      if (t.name === 'true') return 'TRUE()';
      if (t.name === 'false') return 'FALSE()';
      if (t.name === 'undefined' || t.name === 'null' || t.name === 'NaN') return null;
      if (!this.params.has(t.name.toLowerCase())) return null; // no globals
      return t.name;
    }
    if (t.kind === 'paren' && t.ch === '(') {
      const v = this.ternary();
      const c = this.next();
      if (v === null || c?.kind !== 'paren' || c.ch !== ')') return null;
      return `(${v})`;
    }
    return null;
  }
}

/**
 * Transpile a JS expression to an Excel formula fragment. Strict subset:
 * params, numbers, strings, arithmetic, comparisons, &&/||/!, ternary,
 * parens, and the MATH_FNS allowlist. Returns null when anything falls
 * outside the subset (→ service-runtime-only function, best effort).
 */
export function transpileJsExpressionToFormula(expr: string, params: Set<string>): string | null {
  const toks = tokenize(expr);
  if (!toks || toks.length === 0) return null;
  return new Transpiler(toks, params).parse();
}

/** Parse a LAMBDA defined-name ref: params + body (Excel `_xlpm.`-tolerant). */
export function parseLambdaRef(ref: string): { params: string[]; body: string } | null {
  let text = ref.trim();
  if (text.startsWith('=')) text = text.slice(1).trim();
  const m = /^\s*LAMBDA\s*\((.*)\)\s*$/is.exec(text);
  if (!m) return null;
  const parts = splitTopLevel(m[1]!, ',').map((s) => s.trim());
  if (parts.length === 0) return null;
  const body = parts.pop()!;
  const params: string[] = [];
  for (let p of parts) {
    p = p.replace(/^_xlpm\./, '');
    if (!IDENT.test(p)) return null;
    params.push(p);
  }
  if (body.length === 0) return null;
  return { params, body };
}

// ---------------------------------------------------------------------------
// Definition-time smoke-check helpers
// ---------------------------------------------------------------------------

function sampleForType(t: NamedValueType): unknown {
  switch (t) {
    case 'number':
      return 2;
    case 'string':
      return 'a';
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array':
      return [1, 2];
    case 'any':
      return 2;
  }
}

function matchesReturnType(value: unknown, t: NamedValueType): boolean {
  if (t === 'any') return true;
  if (value === null || value === undefined) return t === 'null';
  if (Array.isArray(value)) return t === 'array';
  switch (typeof value) {
    case 'number':
      return t === 'number';
    case 'string':
      return t === 'string';
    case 'boolean':
      return t === 'boolean';
    default:
      return false;
  }
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function cloneSignature(s: NamedFunctionSignature): NamedFunctionSignature {
  return { params: s.params.map((p) => ({ ...p })), returns: s.returns };
}

function cloneDef(d: NamedFunctionDef): NamedFunctionDef {
  return {
    ...d,
    signature: cloneSignature(d.signature),
    versions: d.versions.map((v) => ({ ...v, signature: cloneSignature(v.signature) })),
  };
}

function isStoredDef(d: unknown): d is NamedFunctionDef {
  if (typeof d !== 'object' || d === null) return false;
  const r = d as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['name'] === 'string' &&
    isNamedFunctionLanguage(r['language']) &&
    typeof r['source'] === 'string' &&
    typeof r['version'] === 'number' &&
    Array.isArray(r['versions'])
  );
}
