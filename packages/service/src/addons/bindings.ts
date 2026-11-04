/**
 * Document bindings: the API surface an add-on sees.
 *
 * Per design-docs/add-on-model.md §5, an add-on binds to specific
 * documents, and every invocation carries the installing user's identity
 * through authorize() — the add-on can only touch what that user is allowed
 * to touch. The add-on never elevates.
 *
 * There is no privileged path: every op below first checks the grant's
 * capability, then calls authorize() with the granting user's principal,
 * then delegates to the host-provided DocumentBinding (the same code path
 * the UI uses). The add-on's own identity travels in the auth context's
 * `grants` field as `addon:<id>` so policies and the audit log can see
 * both identities on every call.
 *
 * Engine core is unchanged: the authorizer is taken as a structural
 * interface satisfied by the engine's Authorizer (packages/engine/src/
 * permissions.ts) without importing the engine package.
 */

import { capabilityCovers, type Capability } from './manifest.js';

/** Structural auth context — mirrors the engine's AuthContext. */
export interface AddonAuthContext {
  principal: string;
  grants?: string[];
}

/** Structural authorizer — satisfied by the engine's Authorizer. */
export interface AuthorizerLike {
  authorize(action: string, target: string, ctx: AddonAuthContext): boolean;
}

export interface CellAddress {
  sheet: string;
  row: number;
  col: number;
}

export interface RangeAddress {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export type CellValue = string | number | boolean | null;

/**
 * Host-provided binding of one document. Resolved through the adapter's
 * metadata capabilities (§5); the web app wires this to the engine
 * protocol with the granting user's auth.
 *
 * Methods may return promises: in-process bindings (memory, engine) answer
 * synchronously, while remote bindings (the gateway's HTTP binding to the
 * engine service) answer asynchronously. executeOp() awaits every call, so
 * both shapes work.
 */
export interface DocumentBinding {
  documentId: string;
  listSheets(): string[] | Promise<string[]>;
  readCell(addr: CellAddress): CellValue | Promise<CellValue>;
  readRange(range: RangeAddress): CellValue[][] | Promise<CellValue[][]>;
  writeCell(addr: CellAddress, value: CellValue): void | Promise<void>;
  writeRange(range: RangeAddress, values: CellValue[][]): void | Promise<void>;
}

export interface InvocationContext {
  addonId: string;
  documentId: string;
  /** The granting user's principal — carried through every authorize(). */
  principal: string;
  /** Capabilities in force for this invocation (from the grant store). */
  capabilities: Capability[];
  authorizer: AuthorizerLike;
  binding: DocumentBinding;
  /** Host fetch implementation (injectable for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class AddonAuthError extends Error {
  readonly code: 'capability' | 'denied' | 'invalid-args';
  constructor(code: AddonAuthError['code'], message: string) {
    super(message);
    this.name = 'AddonAuthError';
    this.code = code;
  }
}

/** Ops the worker may invoke. Anything else is rejected. */
export const ADDON_OPS = [
  'sheets.list',
  'sheets.getCell',
  'sheets.getRange',
  'sheets.setCell',
  'sheets.setRange',
  'net.fetch',
  'addon.log',
] as const;

export type AddonOp = (typeof ADDON_OPS)[number];

/** Hard caps per op, enforced before touching the binding. */
export const MAX_RANGE_CELLS = 10_000;
export const MAX_FETCH_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

function isCellAddress(x: unknown): x is CellAddress {
  if (typeof x !== 'object' || x === null) return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.sheet === 'string' &&
    Number.isInteger(a.row) &&
    (a.row as number) >= 0 &&
    Number.isInteger(a.col) &&
    (a.col as number) >= 0
  );
}

function isRangeAddress(x: unknown): x is RangeAddress {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.sheet === 'string' &&
    r.sheet.length > 0 &&
    Number.isInteger(r.startRow) &&
    (r.startRow as number) >= 0 &&
    Number.isInteger(r.startCol) &&
    (r.startCol as number) >= 0 &&
    Number.isInteger(r.endRow) &&
    (r.endRow as number) >= (r.startRow as number) &&
    Number.isInteger(r.endCol) &&
    (r.endCol as number) >= (r.startCol as number)
  );
}

function isCellValue(x: unknown): x is CellValue {
  return (
    x === null ||
    typeof x === 'string' ||
    typeof x === 'number' ||
    typeof x === 'boolean'
  );
}

function rangeCellCount(r: RangeAddress): number {
  return (r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1);
}

function cellTarget(documentId: string, a: CellAddress): string {
  return `doc:${documentId}/sheet:${a.sheet}/cell:R${a.row}C${a.col}`;
}

function rangeTarget(documentId: string, r: RangeAddress): string {
  return (
    `doc:${documentId}/sheet:${r.sheet}/` +
    `range:R${r.startRow}C${r.startCol}:R${r.endRow}C${r.endCol}`
  );
}

/**
 * Execute one worker op against the invocation context. Order of checks:
 * known op -> capability gate -> arg validation -> authorize() ->
 * binding call. Authorization failures throw AddonAuthError; they never
 * leak values.
 */
export async function executeOp(
  ctx: InvocationContext,
  op: string,
  args: unknown,
): Promise<unknown> {
  if (!(ADDON_OPS as readonly string[]).includes(op)) {
    throw new AddonAuthError('invalid-args', `unknown op: ${op}`);
  }
  const authCtx: AddonAuthContext = {
    principal: ctx.principal,
    grants: [`addon:${ctx.addonId}`],
  };
  const check = (action: string, target: string): void => {
    // authorize() throws on missing principal (fail closed) and records
    // the decision in the audit log with both identities attached.
    if (!ctx.authorizer.authorize(action, target, authCtx)) {
      throw new AddonAuthError('denied', `denied by policy: ${action} on ${target}`);
    }
  };
  const needCap = (kind: 'read' | 'write' | 'network', sheet?: string): void => {
    if (!capabilityCovers(ctx.capabilities, kind, sheet)) {
      throw new AddonAuthError(
        'capability',
        `add-on lacks '${kind}' capability${sheet ? ` for sheet '${sheet}'` : ''}`,
      );
    }
  };

  switch (op as AddonOp) {
    case 'sheets.list': {
      needCap('read');
      check('addon.sheet.list', `doc:${ctx.documentId}`);
      return ctx.binding.listSheets();
    }
    case 'sheets.getCell': {
      if (!isCellAddress(args)) throw new AddonAuthError('invalid-args', 'getCell needs {sheet,row,col}');
      needCap('read', args.sheet);
      check('addon.cell.read', cellTarget(ctx.documentId, args));
      return ctx.binding.readCell(args);
    }
    case 'sheets.getRange': {
      if (!isRangeAddress(args)) {
        throw new AddonAuthError('invalid-args', 'getRange needs {sheet,startRow,startCol,endRow,endCol}');
      }
      if (rangeCellCount(args) > MAX_RANGE_CELLS) {
        throw new AddonAuthError('invalid-args', `range exceeds ${MAX_RANGE_CELLS} cells`);
      }
      needCap('read', args.sheet);
      check('addon.range.read', rangeTarget(ctx.documentId, args));
      return ctx.binding.readRange(args);
    }
    case 'sheets.setCell': {
      const rec = args as Record<string, unknown> | null;
      if (typeof rec !== 'object' || rec === null || !isCellAddress(rec.ref)) {
        throw new AddonAuthError('invalid-args', 'setCell needs {ref:{sheet,row,col}, value}');
      }
      if (!isCellValue(rec.value)) {
        throw new AddonAuthError('invalid-args', 'setCell value must be string|number|boolean|null');
      }
      needCap('write', rec.ref.sheet);
      check('addon.cell.write', cellTarget(ctx.documentId, rec.ref));
      // Await: remote bindings answer asynchronously; a rejected write must
      // fail this op instead of escaping as an unobserved promise.
      await ctx.binding.writeCell(rec.ref, rec.value);
      return null;
    }
    case 'sheets.setRange': {
      const rec = args as Record<string, unknown> | null;
      if (typeof rec !== 'object' || rec === null || !isRangeAddress(rec.ref)) {
        throw new AddonAuthError('invalid-args', 'setRange needs {ref:{...}, values}');
      }
      const values = rec.values;
      if (!Array.isArray(values) || values.some((row) => !Array.isArray(row) || row.some((v) => !isCellValue(v)))) {
        throw new AddonAuthError('invalid-args', 'setRange values must be a 2D array of cell values');
      }
      if (rangeCellCount(rec.ref) > MAX_RANGE_CELLS) {
        throw new AddonAuthError('invalid-args', `range exceeds ${MAX_RANGE_CELLS} cells`);
      }
      needCap('write', rec.ref.sheet);
      check('addon.range.write', rangeTarget(ctx.documentId, rec.ref));
      // Await: remote bindings answer asynchronously; a rejected write must
      // fail this op instead of escaping as an unobserved promise.
      await ctx.binding.writeRange(rec.ref, values as CellValue[][]);
      return null;
    }
    case 'net.fetch': {
      // Network egress exists ONLY through this host-proxied op. The worker
      // itself has no fetch/require/socket; without the 'network'
      // capability the add-on cannot exfiltrate (§2).
      needCap('network');
      const rec = args as Record<string, unknown> | null;
      if (typeof rec !== 'object' || rec === null || typeof rec.url !== 'string') {
        throw new AddonAuthError('invalid-args', 'net.fetch needs {url}');
      }
      let url: URL;
      try {
        url = new URL(rec.url);
      } catch {
        throw new AddonAuthError('invalid-args', 'net.fetch url is not a valid URL');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new AddonAuthError('invalid-args', 'net.fetch only allows http(s) URLs');
      }
      const method = typeof rec.method === 'string' ? rec.method.toUpperCase() : 'GET';
      if (!['GET', 'POST', 'PUT', 'DELETE', 'HEAD'].includes(method)) {
        throw new AddonAuthError('invalid-args', `net.fetch method not allowed: ${method}`);
      }
      check('addon.net.fetch', `url:${url.origin}`);
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url.toString(), {
          method,
          headers:
            typeof rec.headers === 'object' && rec.headers !== null
              ? (rec.headers as Record<string, string>)
              : undefined,
          body: typeof rec.body === 'string' ? rec.body : undefined,
          signal: ctrl.signal,
        });
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf).slice(0, MAX_FETCH_BYTES);
        const text = new TextDecoder().decode(bytes);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, body: text, truncated: buf.byteLength > MAX_FETCH_BYTES };
      } catch (e) {
        throw new AddonAuthError('denied', `net.fetch failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    case 'addon.log': {
      // Logging needs no capability; it never touches the document.
      return null;
    }
  }
}

/**
 * In-memory DocumentBinding for tests and headless hosts. Sheets are
 * dense 2D arrays; missing cells read as null.
 */
export function createMemoryBinding(
  documentId: string,
  initial?: Record<string, CellValue[][]>,
): DocumentBinding {
  const sheets = new Map<string, CellValue[][]>();
  if (initial) {
    for (const [name, grid] of Object.entries(initial)) {
      sheets.set(name, grid.map((row) => [...row]));
    }
  }
  const getSheet = (name: string): CellValue[][] => {
    let grid = sheets.get(name);
    if (!grid) {
      grid = [];
      sheets.set(name, grid);
    }
    return grid;
  };
  return {
    documentId,
    listSheets: () => [...sheets.keys()],
    readCell: (a) => getSheet(a.sheet)[a.row]?.[a.col] ?? null,
    readRange: (r) => {
      const grid = getSheet(r.sheet);
      const out: CellValue[][] = [];
      for (let row = r.startRow; row <= r.endRow; row++) {
        const line: CellValue[] = [];
        for (let col = r.startCol; col <= r.endCol; col++) {
          line.push(grid[row]?.[col] ?? null);
        }
        out.push(line);
      }
      return out;
    },
    writeCell: (a, value) => {
      const grid = getSheet(a.sheet);
      while (grid.length <= a.row) grid.push([]);
      const row = grid[a.row];
      while (row.length <= a.col) row.push(null);
      row[a.col] = value;
    },
    writeRange: (r, values) => {
      values.forEach((rowVals, i) => {
        rowVals.forEach((v, j) => {
          const grid = getSheet(r.sheet);
          const row = r.startRow + i;
          const col = r.startCol + j;
          while (grid.length <= row) grid.push([]);
          const line = grid[row];
          while (line.length <= col) line.push(null);
          line[col] = v;
        });
      });
    },
  };
}
