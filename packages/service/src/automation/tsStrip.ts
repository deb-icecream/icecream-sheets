/**
 * Minimal TypeScript type-stripper for the automation lane (browser-safe).
 *
 * The in-web script editor (Extensions > Apps Script) runs user scripts —
 * including VBA/Apps Script migrations emitted by translator.ts — directly
 * in the page. Those sources are TypeScript; the browser runner executes
 * plain JavaScript, so type syntax must be erased first. This module erases
 * it with a tokenizer-level transform (no TS compiler dependency, which is
 * far too heavy for the web bundle).
 *
 * Handled (and covered by tests):
 * - `import type ...;` (dropped), `export` keywords (dropped)
 * - `interface` / `type` alias declarations (whole declaration dropped)
 * - annotations: `let x: T`, params `(a: T, b?: U = d)`, return types
 *   `): R`, class fields `x!: T`, `as T`, `satisfies T`, `<T>` casts,
 *   generic call/definition lists `f<T>()`
 * - modifiers: `readonly`, `declare`, `abstract`, `override`,
 *   `public`/`private`/`protected`; `implements` clauses
 * - non-null assertions `x!`, optional params `b?`
 *
 * Deliberately NOT handled (TypeStripError naming the line):
 * - value `import`/`export ... from` statements (no module system in the
 *   runner — inline the code instead)
 * - `enum` declarations (rewrite as a const object)
 * - namespaces, decorators, parameter properties
 *
 * Honest limits: this is a syntactic transform for the automation script
 * shape (translator output + hand-written API scripts), not a general TS
 * compiler. Anything it cannot erase fails loudly with a line number —
 * never silently.
 */

export class TypeStripError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'TypeStripError';
    this.line = line;
  }
}

const WS = ' \t\r\n';
const IDENT_START = /[$_A-Za-z]/;
const IDENT_PART = /[$_A-Za-z0-9]/;
const KEYWORDS_AFTER_WHICH_EXPR_EXPECTED = new Set([
  'return', 'throw', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'instanceof',
  'case', 'do', 'else', 'yield', 'await',
]);

interface Scanner {
  src: string;
  pos: number;
  line: number;
  out: string[];
}

function peek(s: Scanner): string {
  return s.src[s.pos] ?? '';
}

function isIdentStart(ch: string): boolean {
  return IDENT_START.test(ch);
}

function isIdentPart(ch: string): boolean {
  return IDENT_PART.test(ch);
}

function readIdent(s: Scanner): string {
  const start = s.pos;
  while (isIdentPart(peek(s))) s.pos++;
  return s.src.slice(start, s.pos);
}

function readString(s: Scanner): string {
  const q = peek(s);
  const start = s.pos;
  s.pos++; // opening quote
  if (q === '`') {
    let depth = 0;
    while (s.pos < s.src.length) {
      const ch = s.src[s.pos]!;
      if (ch === '\n') s.line++;
      if (ch === '\\') { s.pos += 2; continue; }
      if (ch === '`' && depth === 0) { s.pos++; break; }
      if (ch === '$' && s.src[s.pos + 1] === '{') { depth++; s.pos += 2; continue; }
      if (ch === '}' && depth > 0) {
        depth--;
        s.pos++;
        // Inside ${...} an expression may contain strings/templates again;
        // the outer loop continues scanning the template body.
        continue;
      }
      s.pos++;
    }
    return s.src.slice(start, s.pos);
  }
  while (s.pos < s.src.length) {
    const ch = s.src[s.pos]!;
    if (ch === '\n') s.line++;
    if (ch === '\\') { s.pos += 2; continue; }
    s.pos++;
    if (ch === q) break;
  }
  return s.src.slice(start, s.pos);
}

/** Copy whitespace (tracking lines) into output. Returns true if any. */
function skipWs(s: Scanner, emit = true): boolean {
  const start = s.pos;
  // NOTE: WS.includes('') is true, so the length guard must come first —
  // without it the scanner spins forever at EOF.
  while (s.pos < s.src.length && WS.includes(s.src[s.pos]!)) {
    if (s.src[s.pos] === '\n') s.line++;
    s.pos++;
  }
  if (emit && s.pos > start) s.out.push(s.src.slice(start, s.pos));
  return s.pos > start;
}

/** Copy (or skip) a // or /* comment. Returns true when a comment was found. */
function skipComment(s: Scanner, emit = true): boolean {
  if (peek(s) === '/' && s.src[s.pos + 1] === '/') {
    const start = s.pos;
    while (s.pos < s.src.length && peek(s) !== '\n') s.pos++;
    if (emit) s.out.push(s.src.slice(start, s.pos));
    return true;
  }
  if (peek(s) === '/' && s.src[s.pos + 1] === '*') {
    const start = s.pos;
    s.pos += 2;
    while (s.pos < s.src.length && !(peek(s) === '*' && s.src[s.pos + 1] === '/')) {
      if (peek(s) === '\n') s.line++;
      s.pos++;
    }
    s.pos += 2;
    if (emit) s.out.push(s.src.slice(start, s.pos));
    return true;
  }
  return false;
}

function skipWsComments(s: Scanner, emit = true): void {
  for (;;) {
    const p = s.pos;
    skipWs(s, emit);
    if (!skipComment(s, emit) && s.pos === p) break;
  }
}

/** Read an identifier word when the upcoming word matches; else null. */
function peekWord(s: Scanner): string {
  let i = s.pos;
  while (i < s.src.length && WS.includes(s.src[i]!)) i++;
  const start = i;
  if (!isIdentStart(s.src[i] ?? '')) return '';
  while (isIdentPart(s.src[i] ?? '')) i++;
  return s.src.slice(start, i);
}

const BODY_KEYWORDS = new Set([
  'return', 'if', 'for', 'while', 'do', 'switch', 'try', 'catch', 'throw',
  'const', 'let', 'var', 'function', 'class', 'new', 'break', 'continue',
  'debugger', 'import', 'export', 'delete', 'typeof', 'instanceof',
]);

/**
 * At a `{` in type position (nesting depth 0): decide whether it opens an
 * object-type literal (`{x: string}` — consume) or a function body
 * (`{ return ...; }` — stop without consuming). Lookahead: scan the
 * balanced block; body signals (statements, `=>`, assignment) mean STOP.
 */
function braceIsTypeLiteral(s: Scanner): boolean {
  let i = s.pos;
  let depth = 0;
  let sawColonAtDepth0 = false;
  for (; i < s.src.length; i++) {
    const c = s.src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      for (; i < s.src.length; i++) {
        if (s.src[i] === '\\') { i++; continue; }
        if (s.src[i] === q) break;
      }
      continue;
    }
    if (c === '/' && (s.src[i + 1] === '/' || s.src[i + 1] === '*')) {
      if (s.src[i + 1] === '/') { while (i < s.src.length && s.src[i] !== '\n') i++; }
      else { i += 2; while (i < s.src.length && !(s.src[i] === '*' && s.src[i + 1] === '/')) i++; i++; }
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { depth++; continue; }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0 && c === '}') break;
      continue;
    }
    if (depth === 1) {
      if (c === ':' ) { sawColonAtDepth0 = true; continue; }
      if (c === '=' ) return false; // assignment or `=>` — a body
      if (isIdentStart(c)) {
        let j = i;
        while (isIdentPart(s.src[j] ?? '')) j++;
        const word = s.src.slice(i, j);
        if (BODY_KEYWORDS.has(word)) {
          // `in`/`of` are not body signals (mapped types use `in`).
          return false;
        }
        i = j - 1;
      }
    }
  }
  return sawColonAtDepth0; // empty `{}`: the caller decides (body vs type)
}

export interface SkipTypeOptions {
  /**
   * When true, a depth-0 `=>` terminates the type instead of being
   * consumed as a function-type arrow. Used for return-type position:
   * `): string => ...` — the `=>` starts the arrow body.
   */
  stopAtArrow?: boolean;
}

/**
 * Skip a type expression starting at the current position. Stops BEFORE a
 * terminator at nesting depth 0 without consuming it. Terminators: `, ; =`
 * `)` `]` `}` at depth 0. A `{` at depth 0 is consumed only when the
 * braceIsTypeLiteral lookahead says it opens an object-type literal.
 */
function skipType(s: Scanner, opts: SkipTypeOptions = {}): void {
  let depth = 0;
  // Trailing whitespace/comments are rewound on exit so callers observe
  // the true end of the type (otherwise `): T {` would lose its space).
  let lastContent = s.pos;
  const mark = (): void => {
    lastContent = s.pos;
  };
  const done = (): void => {
    const skipped = s.src.slice(lastContent, s.pos);
    for (let i = 0; i < skipped.length; i++) if (skipped[i] === '\n') s.line--;
    s.pos = lastContent;
  };
  for (;;) {
    const ch = peek(s);
    if (ch === '') return done();
    if (ch === '"' || ch === "'" || ch === '`') { readString(s); mark(); continue; }
    if (ch === '/' && (s.src[s.pos + 1] === '/' || s.src[s.pos + 1] === '*')) {
      skipComment(s, false);
      mark();
      continue;
    }
    if (WS.includes(ch)) {
      if (ch === '\n') s.line++;
      s.pos++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '<') { depth++; s.pos++; mark(); continue; }
    if (ch === '{') {
      // Object-type literal vs. function body at depth 0.
      if (depth === 0 && !braceIsTypeLiteral(s)) return done();
      depth++;
      s.pos++;
      mark();
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return done();
      depth--;
      s.pos++;
      mark();
      continue;
    }
    if (ch === '>') {
      if (depth === 0) return done(); // comparison — not part of the type
      depth--;
      s.pos++;
      mark();
      continue;
    }
    if (ch === '=' && s.src[s.pos + 1] === '>') {
      // Function-type arrow: consume and keep parsing the return type —
      // unless we are in return-type position, where `=>` starts the
      // arrow-function body.
      if (opts.stopAtArrow && depth === 0) return done();
      s.pos += 2;
      mark();
      continue;
    }
    if ((ch === ',' || ch === ';' || ch === '=') && depth === 0) return done();
    if (ch === '?' && s.src[s.pos + 1] === ':') { s.pos++; mark(); continue; }
    s.pos++;
    mark();
  }
}

/**
 * Try to parse `<...>` as a generic argument list at the current position
 * (which must be `<`). Returns true and leaves the position after `>` on
 * success; returns false and rewinds on failure.
 */
function trySkipGenericArgs(s: Scanner): boolean {
  const save = s.pos;
  const saveLine = s.line;
  let depth = 0;
  s.pos++; // consume '<'
  for (;;) {
    const ch = peek(s);
    if (ch === '') { s.pos = save; s.line = saveLine; return false; }
    if (ch === '"' || ch === "'" || ch === '`') { readString(s); continue; }
    if (WS.includes(ch)) { if (ch === '\n') s.line++; s.pos++; continue; }
    if (ch === '<') { depth++; s.pos++; continue; }
    if (ch === '>') {
      if (depth === 0) { s.pos++; return true; }
      depth--;
      s.pos++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; s.pos++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      // Unbalanced inside <> — not a generic list (e.g. `a < (b)`).
      s.pos = save; s.line = saveLine; return false;
    }
    // A comparison or shift operator at depth 0 means this is not generics.
    if (depth === 0 && (ch === '=' || ch === '!' )) {
      // `<=`, `>=` handled by caller; `<` followed by `=` is not generics.
      s.pos = save; s.line = saveLine; return false;
    }
    s.pos++;
  }
}

/** Skip a balanced `{...}` block (positioned at `{`). */
function skipBlock(s: Scanner): void {
  let depth = 0;
  for (;;) {
    const ch = peek(s);
    if (ch === '') return;
    if (ch === '"' || ch === "'" || ch === '`') { readString(s); continue; }
    if (ch === '/' && (s.src[s.pos + 1] === '/' || s.src[s.pos + 1] === '*')) {
      skipComment(s, false);
      continue;
    }
    if (ch === '\n') s.line++;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      s.pos++;
      if (depth === 0) return;
      continue;
    }
    s.pos++;
  }
}

/** Skip to (and consume) the next `;` or matching `}`/`\n` at depth 0. */
function skipStatement(s: Scanner): void {
  let depth = 0;
  for (;;) {
    const ch = peek(s);
    if (ch === '') return;
    if (ch === '"' || ch === "'" || ch === '`') { readString(s); continue; }
    if (ch === '/' && (s.src[s.pos + 1] === '/' || s.src[s.pos + 1] === '*')) {
      skipComment(s, false);
      continue;
    }
    if (ch === '\n') { s.line++; s.pos++; if (depth === 0) return; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0 && ch === '}') { s.pos++; return; }
      depth = Math.max(0, depth - 1);
    }
    if (ch === ';' && depth === 0) { s.pos++; return; }
    s.pos++;
  }
}

const MODIFIERS = new Set(['readonly', 'declare', 'abstract', 'override', 'public', 'private', 'protected']);

/** Remove trailing whitespace-only output entries (so `x as T` → `x;`). */
function rtrimOut(s: Scanner): void {
  while (s.out.length > 0 && /^[ \t\r\n]+$/.test(s.out[s.out.length - 1]!)) {
    s.out.pop();
  }
}

/**
 * Strip type syntax from TypeScript source, returning plain JavaScript.
 * Throws TypeStripError (with a line number) for unsupported constructs.
 */
export function stripTypeAnnotations(source: string): string {
  const s: Scanner = { src: source, pos: 0, line: 1, out: [] };
  // True when the next token starts an expression (used for regex vs
  // division and `<T>` cast detection).
  let exprExpected = true;

  const fail = (message: string): never => {
    throw new TypeStripError(s.line, message);
  };

  /** After emitting an identifier, handle generic lists / type args. */
  function handleAfterIdent(word: string): void {
    const savePos = s.pos;
    const saveLine = s.line;
    const saveOutLen = s.out.length;
    skipWsComments(s, true);
    if (peek(s) === '<' && s.src[s.pos + 1] !== '<' && s.src[s.pos + 1] !== '=') {
      // Could be f<T>(...) or a < b. Try generics; require `(` after.
      if (trySkipGenericArgs(s)) {
        const p = s.pos;
        let i = p;
        while (i < s.src.length && WS.includes(s.src[i]!)) i++;
        if (s.src[i] === '(') {
          // Generic call/definition: drop the <...> and any whitespace
          // around it; the main loop continues at `(`.
          s.out.length = saveOutLen;
          exprExpected = false;
          void word;
          return;
        }
      }
      // Not generics: rewind fully.
      s.pos = savePos; s.line = saveLine; s.out.length = saveOutLen;
    }
  }

  // Class-body tracking for field annotations (`x: T`, `x?: T`, `x!: T`).
  // classStack holds the brace depth within each enclosing class body;
  // pendingClass is set by a class declaration/expression keyword,
  // pendingMethodParen when an identifier in a class body is followed by
  // `(` (a method — its params/return type need stripping).
  const classStack: number[] = [];
  let pendingClass = false;
  let pendingMethodParen = false;

  while (s.pos < s.src.length) {
    skipWsComments(s, true);
    const ch = peek(s);
    if (ch === '') break;
    const startLine = s.line;

    // Strings / templates: verbatim.
    if (ch === '"' || ch === "'" || ch === '`') {
      s.out.push(readString(s));
      exprExpected = false;
      continue;
    }

    // Identifiers / keywords.
    if (isIdentStart(ch)) {
      const word = readIdent(s);

      // import statements: `import type` is dropped; value imports fail.
      if (word === 'import') {
        const save = s.pos;
        skipWsComments(s, false);
        if (peekWord(s) === 'type') {
          skipStatement(s); // drop the whole `import type ...;`
          exprExpected = true;
          continue;
        }
        // `import 'mod';` (side-effect) — drop quietly, it cannot resolve.
        if (peek(s) === '"' || peek(s) === "'") {
          skipStatement(s);
          exprExpected = true;
          continue;
        }
        s.pos = save;
        fail('value import statements are not supported in the in-browser runner — inline the code instead');
      }

      // export: drop the keyword, keep the declaration.
      if (word === 'export') {
        skipWsComments(s, false);
        if (peekWord(s) === 'type' || peekWord(s) === 'interface') {
          // `export type X = ...` / `export interface ...` — drop whole.
          readIdent(s);
          if (peek(s) === '{') skipBlock(s); else skipStatement(s);
          exprExpected = true;
          continue;
        }
        // `export default ...` — drop `default`, keep the expression.
        if (peekWord(s) === 'default') {
          readIdent(s);
          exprExpected = true;
          continue;
        }
        exprExpected = true;
        continue;
      }

      // interface / type alias: drop the whole declaration.
      if (word === 'interface') {
        skipWsComments(s, false);
        if (isIdentStart(peek(s))) readIdent(s); // name
        skipWsComments(s, false);
        if (peek(s) === '<' && trySkipGenericArgs(s)) { /* type params dropped */ }
        skipWsComments(s, false);
        if (peekWord(s) === 'extends') {
          readIdent(s);
          skipWsComments(s, false);
          skipType(s); // extends clause
          skipWsComments(s, false);
        }
        if (peek(s) === '{') skipBlock(s);
        exprExpected = true;
        continue;
      }
      if (word === 'type' && exprExpected) {
        // `type X = ...;` alias (only in type-declaration position).
        skipWsComments(s, false);
        if (isIdentStart(peek(s))) readIdent(s); // name
        skipWsComments(s, false);
        if (peek(s) === '<' && trySkipGenericArgs(s)) { /* dropped */ }
        skipWsComments(s, false);
        if (peek(s) === '=') { s.pos++; skipWsComments(s, false); skipType(s); skipWsComments(s, false); }
        if (peek(s) === ';') s.pos++;
        exprExpected = true;
        continue;
      }

      if (word === 'enum') fail('enum declarations are not supported — rewrite as a const object');
      if (word === 'namespace' || word === 'module') fail('namespaces are not supported — inline the code instead');

      // `as` / `satisfies` casts: drop the keyword + the type.
      if (word === 'as' || word === 'satisfies') {
        rtrimOut(s);
        skipWsComments(s, false);
        // `as const` — keep `const`? `as const` has no runtime effect; drop both.
        if (peekWord(s) === 'const') { readIdent(s); exprExpected = false; continue; }
        skipType(s);
        exprExpected = false;
        continue;
      }

      // implements clause: drop through the following `{`.
      if (word === 'implements') {
        skipWsComments(s, false);
        for (;;) {
          const c = peek(s);
          if (c === '' || c === '{') break;
          if (c === '"' || c === "'" || c === '`') { readString(s); continue; }
          if (c === '\n') s.line++;
          s.pos++;
        }
        exprExpected = false;
        continue;
      }

      // Modifiers: drop when they precede a declaration element.
      if (MODIFIERS.has(word)) {
        const save = s.pos;
        const saveLine = s.line;
        skipWsComments(s, false);
        const next = peekWord(s);
        const nc = peek(s);
        if (
          (next !== '' && next !== 'of' && next !== 'in') ||
          nc === '(' || nc === '"' || nc === "'" || nc === '{' || nc === '['
        ) {
          // Modifier position: drop. (A bare `readonly x` etc. is nonsense
          // anyway; `declare` before `function`/`class`/`const` is dropped.)
          exprExpected = true;
          continue;
        }
        s.pos = save; s.line = saveLine;
      }

      // Emit the identifier.
      s.out.push(word);
      // After a value identifier no expression is expected (so a following
      // `!` is a non-null assertion, `<` a comparison); after operator-like
      // keywords (return, typeof, new, ...) one is.
      exprExpected = KEYWORDS_AFTER_WHICH_EXPR_EXPECTED.has(word);

      // `function` name + generic params: `function f<T>(...)`.
      if (word === 'function' || word === 'class') {
        const isClass = word === 'class';
        skipWsComments(s, true);
        let hasName = false;
        if (isIdentStart(peek(s))) {
          s.out.push(readIdent(s));
          hasName = true;
        }
        skipWsComments(s, true);
        if (peek(s) === '<') {
          if (trySkipGenericArgs(s)) {
            // drop
          }
        }
        if (isClass) {
          // A `{` (or `extends`) next means a class body follows — arm
          // class-body tracking for field annotations. `{class: 1}`
          // (property, not declaration) must NOT arm it.
          const sv = s.pos;
          const sl = s.line;
          skipWsComments(s, false);
          const w = peekWord(s);
          const nc = peek(s);
          s.pos = sv;
          s.line = sl;
          if (hasName || nc === '{' || w === 'extends') pendingClass = true;
        }
        exprExpected = false;
        continue;
      }

      handleAfterIdent(word);

      // Class fields directly in a class body: `x: T`, `x?: T`, `x!: T`.
      // (Methods are handled by the `(` parameter logic via
      // pendingMethodParen.)
      if (classStack.length > 0 && classStack[classStack.length - 1] === 0) {
        const sv = s.pos;
        const sl = s.line;
        const so = s.out.length;
        skipWsComments(s, false);
        if (peek(s) === '?' && s.src[s.pos + 1] !== '.' && s.src[s.pos + 1] !== '?') {
          s.pos++;
          skipWsComments(s, false);
        }
        if (peek(s) === '!') {
          s.pos++;
          skipWsComments(s, false);
        }
        if (peek(s) === ':') {
          s.pos++;
          skipWsComments(s, false);
          skipType(s);
        } else if (peek(s) === '(') {
          // A method: the `(` needs parameter + return-type stripping.
          pendingMethodParen = true;
          s.pos = sv;
          s.line = sl;
          s.out.length = so;
        } else {
          s.pos = sv;
          s.line = sl;
          s.out.length = so;
        }
      }

      // Declaration annotations: `let/const/var <ident> [: type]` (possibly
      // comma-separated declarators).
      if (word === 'let' || word === 'const' || word === 'var') {
        skipWsComments(s, true);
        for (;;) {
          // One declarator: destructuring pattern or plain identifier.
          if (peek(s) === '{' || peek(s) === '[') {
            // Copy the binding pattern verbatim (may contain defaults).
            const start = s.pos;
            let depth = 0;
            const close = peek(s) === '{' ? '}' : ']';
            for (;;) {
              const c = peek(s);
              if (c === '') break;
              if (c === '"' || c === "'" || c === '`') { readString(s); continue; }
              if (c === '\n') s.line++;
              if (c === '{' || c === '[') depth++;
              if (c === '}' || c === ']') {
                depth--;
                s.pos++;
                if (depth === 0 && c === close) break;
                continue;
              }
              s.pos++;
            }
            s.out.push(s.src.slice(start, s.pos));
          } else if (isIdentStart(peek(s))) {
            const name = readIdent(s);
            const afterName = s.pos;
            const afterNameLine = s.line;
            skipWsComments(s, false); // do not emit until the annotation is confirmed
            if (peek(s) === '?' && s.src[s.pos + 1] !== '.' && s.src[s.pos + 1] !== '?') {
              s.pos++; // optional `?` — no runtime effect
              skipWsComments(s, false);
            }
            if (peek(s) === ':') {
              s.out.push(name);
              s.pos++;
              skipWsComments(s, false);
              skipType(s);
              // Keep one space before an initializer for readability;
              // consume the original whitespace so it is not re-emitted.
              const sv = s.pos;
              const sl = s.line;
              skipWsComments(s, false);
              if (peek(s) !== '=') {
                s.pos = sv;
                s.line = sl;
              } else {
                s.out.push(' ');
              }
            } else {
              // No annotation: restore and emit the whitespace verbatim.
              s.pos = afterName;
              s.line = afterNameLine;
              s.out.push(name);
              skipWsComments(s, true);
            }
          } else {
            break;
          }
          // Another declarator follows only when `,` comes before any `=`.
          const sv = s.pos;
          const sl = s.line;
          const so = s.out.length;
          skipWsComments(s, true);
          if (peek(s) === ',') {
            s.out.push(',');
            s.pos++;
            skipWsComments(s, true);
            continue;
          }
          s.pos = sv;
          s.line = sl;
          s.out.length = so;
          break;
        }
        exprExpected = true;
        continue;
      }

      // Possible non-null assertion or optional marker already handled in
      // params; a postfix `!` after any identifier in expression position:
      // (handled below in punctuation).
      continue;
    }

    // Numbers.
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s.src[s.pos + 1] ?? ''))) {
      const start = s.pos;
      while (/[0-9a-fA-FxXoObB._]/.test(peek(s))) s.pos++;
      s.out.push(s.src.slice(start, s.pos));
      exprExpected = false;
      continue;
    }

    // Punctuation / operators.
    switch (ch) {
      case '(': {
        // Param-list detection: look ahead for a `:` inside the parens
        // (depth 1) before the matching `)`. If found, this is a parameter
        // list — strip the annotations inside, then a possible return type
        // after `)`. A `?` before the `:` (that is not an optional-param
        // marker directly after an identifier) means a ternary, not
        // annotations — e.g. `foo(a ? b : c)`.
        let depth = 1; // we start just inside the `(`
        let isParams = false;
        let sawTernaryQ = false;
        let prevSig = '(';
        let i = s.pos + 1;
        for (; i < s.src.length; i++) {
          const c = s.src[i]!;
          if (c === '"' || c === "'" || c === '`') {
            // skip string
            const q = c;
            i++;
            if (q === '`') {
              let td = 0;
              for (; i < s.src.length; i++) {
                const cc = s.src[i]!;
                if (cc === '\\') { i++; continue; }
                if (cc === '`' && td === 0) break;
                if (cc === '$' && s.src[i + 1] === '{') { td++; i++; continue; }
                if (cc === '}' && td > 0) td--;
              }
            } else {
              for (; i < s.src.length && s.src[i] !== q; i++) if (s.src[i] === '\\') i++;
            }
            prevSig = 'str';
            continue;
          }
          if (c === '/' && (s.src[i + 1] === '/' || s.src[i + 1] === '*')) break;
          if (c === '(' || c === '[' || c === '{') { depth++; prevSig = c; continue; }
          if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) break; // matching close — no annotation colon inside
            prevSig = c;
            continue;
          }
          if (depth === 1) {
            if (c === '?' && s.src[i + 1] !== '.' && s.src[i + 1] !== '?') {
              // `?` directly after an identifier is an optional-param
              // marker (`a?: string`); otherwise it opens a ternary.
              if (!isIdentPart(prevSig)) sawTernaryQ = true;
              prevSig = c;
              continue;
            }
            if (c === ':') {
              if (sawTernaryQ) break; // ternary — not params
              isParams = true;
              break;
            }
            if ((c === '=' && s.src[i + 1] === '>') || c === ';') break;
          }
          if (!WS.includes(c)) prevSig = c;
        }
        // A method's paren (set by the class-body identifier check) always
        // takes the parameter/return-type stripping path.
        if (pendingMethodParen) {
          pendingMethodParen = false;
          isParams = true;
        }
        if (isParams) {
          // Emit `(`, then strip annotations param by param.
          s.out.push('(');
          s.pos++;
          exprExpected = true;
          for (;;) {
            skipWsComments(s, true);
            const c = peek(s);
            if (c === '') break;
            if (c === ')') { s.out.push(')'); s.pos++; break; }
            if (c === ',') { s.out.push(','); s.pos++; exprExpected = true; continue; }
            if (c === '.') { // ...rest
              s.out.push('...'); s.pos += 3;
              skipWsComments(s, true);
              if (isIdentStart(peek(s))) s.out.push(readIdent(s));
              skipWsComments(s, true);
              if (peek(s) === ':') { s.pos++; skipWsComments(s, false); skipType(s); }
              continue;
            }
            if (c === '{' || c === '[') {
              // Destructured param: copy pattern, strip its `: type`.
              const start = s.pos;
              let d = 0;
              const close = c === '{' ? '}' : ']';
              for (;;) {
                const cc = peek(s);
                if (cc === '') break;
                if (cc === '"' || cc === "'" || cc === '`') { readString(s); continue; }
                if (cc === '\n') s.line++;
                if (cc === '{' || cc === '[') d++;
                if (cc === '}' || cc === ']') { d--; s.pos++; if (d === 0 && cc === close) break; continue; }
                s.pos++;
              }
              const pattern = s.src.slice(start, s.pos);
              const afterPat = s.pos;
              const afterPatLine = s.line;
              skipWsComments(s, false);
              if (peek(s) === ':') {
                s.out.push(pattern);
                s.pos++;
                skipWsComments(s, false);
                skipType(s);
              } else {
                s.pos = afterPat;
                s.line = afterPatLine;
                s.out.push(pattern);
                skipWsComments(s, true);
              }
              continue;
            }
            if (isIdentStart(c)) {
              const paramName = readIdent(s);
              if (MODIFIERS.has(paramName)) fail('parameter properties are not supported');
              const afterName = s.pos;
              const afterNameLine = s.line;
              skipWsComments(s, false); // do not emit until the annotation is confirmed
              if (peek(s) === '?' && s.src[s.pos + 1] !== '.' && s.src[s.pos + 1] !== '?') {
                s.pos++;
                skipWsComments(s, false);
              }
              if (peek(s) === ':') {
                s.out.push(paramName);
                s.pos++;
                skipWsComments(s, false);
                skipType(s);
              } else {
                s.pos = afterName;
                s.line = afterNameLine;
                s.out.push(paramName);
                skipWsComments(s, true);
              }
              continue;
            }
            // Anything else (defaults with expressions): copy one token-ish
            // char and let the expression logic handle the rest.
            s.out.push(c);
            s.pos++;
            exprExpected = true;
          }
          // Possible return type after `)`.
          {
            const sv = s.pos; const sl = s.line; const so = s.out.length;
            skipWsComments(s, true);
            if (peek(s) === ':') {
              s.pos++;
              skipWsComments(s, false);
              // Return-type position: `=>` starts the arrow body.
              // `{` still uses the type-literal-vs-body lookahead
              // (object return types like `{x: string}` keep working).
              skipType(s, { stopAtArrow: true });
            } else {
              s.pos = sv; s.line = sl; s.out.length = so;
            }
          }
          exprExpected = false;
          continue;
        }
        // Not a param list: ordinary paren.
        s.out.push('(');
        s.pos++;
        exprExpected = true;
        continue;
      }
      case ':': {
        // `:` outside annotation positions: ternary/object/case — keep.
        // (Annotations are consumed by their own handlers above.)
        s.out.push(':');
        s.pos++;
        exprExpected = true;
        continue;
      }
      case '!': {
        const n1 = s.src[s.pos + 1];
        if (n1 === '=') {
          const op = s.src[s.pos + 2] === '=' ? '!==' : '!=';
          s.out.push(op);
          s.pos += op.length;
          exprExpected = true;
        } else if (n1 === '!') {
          s.out.push('!!');
          s.pos += 2;
          exprExpected = true;
        } else if (exprExpected) {
          // Logical NOT (prefix position): keep.
          s.out.push('!');
          s.pos++;
          exprExpected = true;
        } else {
          // Non-null assertion (postfix position): drop.
          rtrimOut(s);
          s.pos++;
          exprExpected = false;
        }
        continue;
      }
      case '?': {
        const n1 = s.src[s.pos + 1];
        if (n1 === '?' ) {
          s.out.push(s.src[s.pos + 2] === '=' ? '??=' : '??');
          s.pos += s.out[s.out.length - 1]!.length;
          exprExpected = true;
        } else if (n1 === '.') {
          // Optional chaining — BUT `?.` followed by `<`? not valid; keep.
          // Careful: `a?.<` never occurs. However `?` `:` in ternary with
          // `<`... keep `?.` verbatim.
          s.out.push('?.');
          s.pos += 2;
          exprExpected = true;
        } else {
          s.out.push('?');
          s.pos++;
          exprExpected = true;
        }
        continue;
      }
      case '<': {
        // `<T>expr` cast when an expression is expected; otherwise keep
        // (comparisons, generics handled after identifiers).
        if (exprExpected && s.src[s.pos + 1] !== '<' && s.src[s.pos + 1] !== '=') {
          const sv = s.pos; const sl = s.line; const so = s.out.length;
          if (trySkipGenericArgs(s)) {
            exprExpected = true;
            void sv; void sl; void so;
            continue;
          }
          s.pos = sv; s.line = sl; s.out.length = so;
        }
        s.out.push('<');
        s.pos++;
        exprExpected = true;
        continue;
      }
      case '/': {
        const n1 = s.src[s.pos + 1];
        if (n1 === '/' || n1 === '*') {
          // (comments were consumed by skipWsComments, but be safe)
          skipComment(s, true);
          continue;
        }
        if (exprExpected) {
          // Try a regex literal.
          const start = s.pos;
          const startLine = s.line;
          s.pos++;
          let ok = false;
          let inClass = false;
          while (s.pos < s.src.length) {
            const c = s.src[s.pos]!;
            if (c === '\n') break;
            if (c === '\\') { s.pos += 2; continue; }
            if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) { ok = true; break; }
            s.pos++;
          }
          if (ok) {
            s.pos++; // closing /
            while (isIdentPart(peek(s))) s.pos++; // flags
            s.out.push(s.src.slice(start, s.pos));
            exprExpected = false;
            void startLine;
            continue;
          }
          s.pos = start;
          s.line = startLine;
        }
        s.out.push('/');
        s.pos++;
        exprExpected = true;
        continue;
      }
      case '=': {
        if (s.src[s.pos + 1] === '>') {
          s.out.push('=>');
          s.pos += 2;
        } else if (s.src[s.pos + 1] === '=') {
          const eq = s.src[s.pos + 2] === '=' ? '===' : '==';
          s.out.push(eq);
          s.pos += eq.length;
        } else {
          s.out.push('=');
          s.pos++;
        }
        exprExpected = true;
        continue;
      }
      default: {
        const c = ch;
        // Class-body brace tracking (for field annotations).
        if (c === '{') {
          if (pendingClass) {
            classStack.push(0);
            pendingClass = false;
          } else {
            for (let k = 0; k < classStack.length; k++) classStack[k]!++;
          }
        } else if (c === '}') {
          if (classStack.length > 0) {
            const top = classStack[classStack.length - 1]!;
            if (top === 0) classStack.pop();
            else classStack[classStack.length - 1] = top - 1;
          }
        }
        s.out.push(c);
        s.pos++;
        // Expression-expected bookkeeping for common tokens.
        if (c === ';' || c === ',' || c === '{' || c === '}' || c === '[') exprExpected = true;
        else if (c === ')' || c === ']') exprExpected = false;
        else if ('+-*%&|^~'.includes(c)) exprExpected = true;
        void startLine;
        continue;
      }
    }
  }

  return s.out.join('');
}
