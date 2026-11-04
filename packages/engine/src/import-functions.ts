/**
 * IMPORTDATA / IMPORTFEED / IMPORTHTML / IMPORTXML — the Fetch-component
 * formula functions (design-docs/connector-vs-component.md: these use the
 * Fetch component, no auth).
 *
 * All four are synchronous HyperFormula plugins (the engine is synchronous):
 * they fetch through the shared WebFetchProvider seam (setWebFetchProvider;
 * the default uses curl in Node, the web app wires browser fetch) and spill
 * their results as dynamic arrays via dynamic-arrays' spill() helper.
 *
 * - IMPORTDATA(url, [delimiter]) — fetch CSV/TSV, parse, spill as a grid.
 * - IMPORTFEED(url, [query], [headers], [num_items]) — fetch an RSS/Atom
 *   feed, spill items as a table (Title, Link, Date by default).
 * - IMPORTHTML(url, query, index) — fetch an HTML "table" or "list" by
 *   1-based index, spill as a table.
 * - IMPORTXML(url, xpath) — fetch XML, evaluate the FILTERXML XPath subset
 *   (extended-functions10.ts), spill matched node values as a column.
 *
 * CSV parsing is self-contained here (proper RFC-4180 quoting, delimiter
 * auto-detection); the engine keeps zero dependencies beyond HyperFormula.
 *
 * Unlike batches 8-10 this module does NOT self-register on import: hosts
 * call registerImportFunctions() explicitly (it is idempotent).
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
import { spill, type ArrayResult } from './dynamic-arrays.js';
import { fetchUrlText } from './extended-functions11.js';
import { filterXmlValues, parseXml, type XmlNode } from './extended-functions10.js';

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

type Arg = { argumentType: FunctionArgumentType; optionalArg?: boolean };
const S = (optionalArg = false): Arg => ({ argumentType: FunctionArgumentType.SCALAR, optionalArg });
const N = (optionalArg = false): Arg => ({ argumentType: FunctionArgumentType.NUMBER, optionalArg });

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function scalarText(v: InterpreterValue): string {
  if (v === EmptyValue) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asVal(v: unknown): InterpreterValue {
  return v as unknown as InterpreterValue;
}

function asNumber(v: InterpreterValue | undefined, what: string): number | CellError {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = norm(scalarText(v ?? EmptyValue));
  if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return new CellError(ErrorType.VALUE, `${what} must be a number.`);
}

/** Cap on spilled cells per IMPORT* call (network data is untrusted). */
const IMPORT_MAX_CELLS = 100_000;
/** Cap on fetched text per IMPORT* call. */
const IMPORT_MAX_TEXT = 4_000_000;

function fetchImport(url: string, fn: string): string {
  const u = url.trim();
  if (u === '') throw new Error(`${fn} requires a URL.`);
  return fetchUrlText(u, IMPORT_MAX_TEXT);
}

function checkCellCap(cells: number, fn: string): CellError | null {
  if (cells > IMPORT_MAX_CELLS) {
    return new CellError(
      ErrorType.VALUE,
      `${fn}: result exceeds the ${IMPORT_MAX_CELLS}-cell import cap.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV parsing (self-contained, RFC-4180 quoting + delimiter auto-detect).
// ---------------------------------------------------------------------------

const DELIMITER_NAMES: Record<string, string> = {
  ',': ',', comma: ',', tab: '\t', '\t': '\t',
  semicolon: ';', ';': ';', pipe: '|', '|': '|',
};

function resolveImportDelimiter(spec: string): string {
  const t = norm(spec);
  const d = DELIMITER_NAMES[t];
  if (!d) throw new Error(`IMPORTDATA: unsupported delimiter "${spec}" (use ",", "\\t", ";", "|").`);
  return d;
}

/** Auto-detect delimiter by counting candidates across the first 5 lines. */
function detectImportDelimiter(text: string): string {
  const candidates = [',', '\t', ';', '|'];
  const lines = text.split(/\r?\n/).slice(0, 5).filter((l) => l.trim() !== '');
  if (lines.length === 0) return ',';
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    let score = 0;
    for (const line of lines) score += line.split(d).length - 1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return bestScore > 0 ? best : ',';
}

interface CsvCell { value: string; quoted: boolean }

/** Parse delimited text honoring double-quoted fields ("" = literal "). */
function parseDelimited(text: string, delimiter: string): CsvCell[][] {
  const rows: CsvCell[][] = [];
  let row: CsvCell[] = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = (): void => {
    row.push({ value: field, quoted });
    field = '';
    quoted = false;
  };
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += ch; i++; }
    } else if (ch === '"') {
      if (field === '') { quoted = true; inQuotes = true; }
      else field += ch;
      i++;
    } else if (ch === delimiter) {
      pushField();
      i++;
    } else if (ch === '\r') {
      i++; // \r\n and lone \r both handled via \n below
    } else if (ch === '\n') {
      pushField();
      rows.push(row);
      row = [];
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (inQuotes) throw new Error('IMPORTDATA: unterminated quoted field in CSV.');
  pushField();
  if (row.length === 1 && row[0]!.value === '' && !row[0]!.quoted) row = [];
  if (row.length > 0) rows.push(row);
  return rows.filter((r) => r.some((c) => c.value !== ''));
}

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function coerceCsvCell(cell: CsvCell): InterpreterValue {
  if (cell.quoted) return cell.value;
  const t = cell.value.trim();
  if (t === '') return cell.value === '' ? EmptyValue : cell.value;
  if (NUMBER_RE.test(t)) {
    const num = Number(t);
    if (Number.isFinite(num)) return num;
  }
  const lower = t.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return cell.value;
}

/**
 * Evaluate IMPORTDATA(url, [delimiter]); returns the spilled grid or a
 * CellError. Exported for the host-side spill path below.
 */
export function importDataValues(url: string, delimiter?: string): ArrayResult | CellError {
  try {
    const text = fetchImport(url, 'IMPORTDATA');
    const delim = delimiter !== undefined && delimiter !== ''
      ? resolveImportDelimiter(delimiter)
      : detectImportDelimiter(text);
    const rows = parseDelimited(text, delim);
    if (rows.length === 0) return new CellError(ErrorType.NA, 'IMPORTDATA: no data at URL.');
    const width = Math.max(...rows.map((r) => r.length));
    const arr: ArrayResult = rows.map((r) => {
      const out: InterpreterValue[] = new Array(width).fill(EmptyValue);
      r.forEach((c, i) => { out[i] = coerceCsvCell(c); });
      return out;
    });
    const cap = checkCellCap(arr.length * width, 'IMPORTDATA');
    if (cap) return cap;
    return arr;
  } catch (e) {
    return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// HTML entity decoding + tag stripping (for IMPORTHTML).
// ---------------------------------------------------------------------------

function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–',
    laquo: '«', raquo: '»', middot: '·', trade: '™', euro: '€', pound: '£',
  };
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp|copy|reg|hellip|mdash|ndash|laquo|raquo|middot|trade|euro|pound);/g,
      (m, e: string) => named[e] ?? m)
    .replace(/&#(\d+);/g, (m, d: string) => {
      const cp = parseInt(d, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h: string) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------------
// IMPORTHTML — extract tables / lists from HTML.
// ---------------------------------------------------------------------------

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

/** Extract the inner HTML of every top-level <table> in document order. */
function extractHtmlTables(html: string): string[] {
  const tables: string[] = [];
  let depth = 0;
  let start = -1;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    const name = m[1]!.toLowerCase();
    const closing = html[m.index + 1] === '/';
    if (name !== 'table') continue;
    if (!closing) {
      if (depth === 0) start = m.index + m[0].length;
      depth++;
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        tables.push(html.slice(start, m.index));
        start = -1;
      }
    }
  }
  return tables;
}

function extractRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]!)) !== null) {
      const text = stripTags(cm[3]!);
      const colspan = /colspan\s*=\s*["']?(\d+)/i.exec(cm[2]!);
      const span = colspan ? Math.max(1, Math.min(50, parseInt(colspan[1]!, 10))) : 1;
      cells.push(text);
      for (let k = 1; k < span; k++) cells.push('');
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** Extract the <li> items of every top-level <ul>/<ol> in document order. */
function extractHtmlLists(html: string): string[][] {
  const lists: string[][] = [];
  const listRe = /<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = listRe.exec(html)) !== null) {
    const items: string[] = [];
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi;
    let im: RegExpExecArray | null;
    while ((im = liRe.exec(lm[2]!)) !== null) {
      items.push(stripTags(im[1]!));
    }
    if (items.length > 0) lists.push(items);
  }
  return lists;
}

/**
 * Evaluate IMPORTHTML(url, query, index); returns the spilled table or a
 * CellError. Exported for the host-side spill path below.
 */
export function importHtmlValues(url: string, query: string, index: number): ArrayResult | CellError {
  const q = norm(query);
  if (q !== 'table' && q !== 'list') {
    return new CellError(ErrorType.VALUE, 'IMPORTHTML: query must be "table" or "list".');
  }
  if (!Number.isInteger(index) || index < 1) {
    return new CellError(ErrorType.VALUE, 'IMPORTHTML: index must be a positive integer.');
  }
  try {
    const html = fetchImport(url, 'IMPORTHTML');
    if (q === 'table') {
      const tables = extractHtmlTables(html);
      if (index > tables.length) {
        return new CellError(ErrorType.NA, `IMPORTHTML: no table #${index} (found ${tables.length}).`);
      }
      const rows = extractRows(tables[index - 1]!);
      if (rows.length === 0) return new CellError(ErrorType.NA, `IMPORTHTML: table #${index} has no rows.`);
      const width = Math.max(...rows.map((r) => r.length));
      const arr: ArrayResult = rows.map((r) => {
        const out: InterpreterValue[] = new Array(width).fill(EmptyValue);
        r.forEach((c, i) => { out[i] = c === '' ? EmptyValue : c; });
        return out;
      });
      const cap = checkCellCap(arr.length * width, 'IMPORTHTML');
      if (cap) return cap;
      return arr;
    }
    const lists = extractHtmlLists(html);
    if (index > lists.length) {
      return new CellError(ErrorType.NA, `IMPORTHTML: no list #${index} (found ${lists.length}).`);
    }
    const items = lists[index - 1]!;
    const arr: ArrayResult = items.map((t) => [t === '' ? EmptyValue : asVal(t)]);
    const cap = checkCellCap(arr.length, 'IMPORTHTML');
    if (cap) return cap;
    return arr;
  } catch (e) {
    return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// IMPORTFEED — RSS 2.0 / Atom parsing.
// ---------------------------------------------------------------------------

interface FeedItem {
  title: string;
  link: string;
  date: string;
  author: string;
  description: string;
}

interface Feed {
  title: string;
  link: string;
  description: string;
  items: FeedItem[];
}

function localName(name: string): string {
  const i = name.lastIndexOf(':');
  return i >= 0 ? name.slice(i + 1)!.toLowerCase() : name.toLowerCase();
}

function childText(node: XmlNode, names: string[]): string {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const child of node.children) {
    if (wanted.has(localName(child.name))) {
      const t = fullText(child).trim();
      if (t !== '') return t;
    }
  }
  return '';
}

function fullText(node: XmlNode): string {
  let out = node.text;
  for (const child of node.children) out += fullText(child);
  return out;
}

function findNodes(root: XmlNode, names: string[]): XmlNode[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out: XmlNode[] = [];
  const walk = (node: XmlNode): void => {
    for (const child of node.children) {
      if (wanted.has(localName(child.name))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function linkOf(node: XmlNode): string {
  // Atom: <link href="..."/> (possibly multiple; prefer rel=alternate or none)
  const wanted = new Set(['link']);
  let fallback = '';
  for (const child of node.children) {
    if (!wanted.has(localName(child.name))) continue;
    const href = child.attrs['href'] ?? '';
    const rel = (child.attrs['rel'] ?? '').toLowerCase();
    if (href !== '' && (rel === '' || rel === 'alternate')) return href;
    if (fallback === '' && href !== '') fallback = href;
    const t = fullText(child).trim();
    if (fallback === '' && t !== '') fallback = t;
  }
  return fallback;
}

/** Parse an RSS 2.0 or Atom feed into a Feed. Throws on malformed XML. */
export function parseFeed(xmlText: string): Feed {
  const doc = parseXml(xmlText);
  const empty: Feed = { title: '', link: '', description: '', items: [] };
  // RSS 2.0: <rss><channel>...
  const channels = findNodes(doc, ['channel']);
  const channel = channels[0];
  if (channel) {
    const feed: Feed = {
      title: childText(channel, ['title']),
      link: childText(channel, ['link']) || linkOf(channel),
      description: childText(channel, ['description', 'subtitle']),
      items: [],
    };
    for (const item of channel.children.filter((c) => localName(c.name) === 'item')) {
      feed.items.push({
        title: childText(item, ['title']),
        link: childText(item, ['link']) || linkOf(item),
        date: childText(item, ['pubdate', 'pub_date', 'published', 'updated', 'date']),
        author: childText(item, ['author', 'creator', 'dc:creator']),
        description: childText(item, ['description', 'summary', 'content']),
      });
    }
    return feed;
  }
  // Atom: <feed><entry>...
  const feeds = findNodes(doc, ['feed']);
  const atom = feeds[0];
  if (atom) {
    const feed: Feed = {
      title: childText(atom, ['title']),
      link: linkOf(atom),
      description: childText(atom, ['subtitle', 'description']),
      items: [],
    };
    for (const entry of atom.children.filter((c) => localName(c.name) === 'entry')) {
      feed.items.push({
        title: childText(entry, ['title']),
        link: linkOf(entry),
        date: childText(entry, ['published', 'updated', 'pubdate']),
        author: childText(entry, ['author', 'name', 'creator']),
        description: childText(entry, ['summary', 'content', 'description']),
      });
    }
    return feed;
  }
  return empty;
}

// parseXml lives in extended-functions10 (the FILTERXML parser); reused
// here so IMPORTFEED/IMPORTXML share the same zero-dependency XML stack.

const FEED_FIELDS: Record<string, keyof FeedItem | 'feed-title' | 'feed-link' | 'feed-description'> = {
  title: 'title', link: 'link', date: 'date', pubdate: 'date', published: 'date',
  updated: 'date', author: 'author', creator: 'author', description: 'description',
  summary: 'description', content: 'description',
};

const FIELD_HEADERS: Record<string, string> = {
  title: 'Title', link: 'Link', date: 'Date', author: 'Author', description: 'Description',
};

/**
 * Evaluate IMPORTFEED(url, [query], [headers], [num_items]); returns the
 * spilled table or a CellError. Exported for the host-side spill path below.
 *
 * query (Google Sheets dialect): "items" (default), "items title",
 * "items title link", "feed title", "feed link", "feed description",
 * optionally suffixed with "no headers". headers: 1/0 (default 1).
 * num_items: max item rows (default all).
 */
export function importFeedValues(
  url: string,
  query?: string,
  headers?: number | null,
  numItems?: number | null,
): ArrayResult | CellError {
  try {
    const text = fetchImport(url, 'IMPORTFEED');
    let feed: Feed;
    try {
      feed = parseFeed(text);
    } catch (e) {
      return new CellError(ErrorType.VALUE, `IMPORTFEED: invalid feed XML (${e instanceof Error ? e.message : String(e)}).`);
    }
    const q = norm(query ?? '');
    const noHeadersInQuery = q.includes('no headers');
    const useHeaders = headers === null || headers === undefined ? !noHeadersInQuery : headers !== 0;
    const tokens = q.replace('no headers', ' ').split(/[\s,]+/).filter((t) => t !== '');
    const out: ArrayResult = [];
    if (tokens[0] === 'feed') {
      // "feed title" | "feed link" | "feed description"
      const which = tokens[1] ?? 'title';
      const value = which === 'link' ? feed.link : which === 'description' ? feed.description : feed.title;
      if (useHeaders) {
        out.push([asVal(which === 'link' ? 'Link' : which === 'description' ? 'Description' : 'Title')]);
      }
      out.push([value === '' ? EmptyValue : asVal(value)]);
      return out;
    }
    // Items table.
    const fieldTokens = tokens[0] === 'items' ? tokens.slice(1) : tokens;
    const fields = fieldTokens.length > 0
      ? fieldTokens.map((t) => FEED_FIELDS[t] ?? null).filter((f): f is keyof FeedItem => f !== null)
      : (['title', 'link', 'date'] as (keyof FeedItem)[]);
    if (fields.length === 0) {
      return new CellError(ErrorType.VALUE, 'IMPORTFEED: query names no known fields (title, link, date, author, description).');
    }
    if (useHeaders) out.push(fields.map((f) => asVal(FIELD_HEADERS[f] ?? f)));
    const limit = numItems === null || numItems === undefined
      ? feed.items.length
      : Math.max(0, Math.trunc(numItems));
    const items = feed.items.slice(0, limit);
    if (items.length === 0) return new CellError(ErrorType.NA, 'IMPORTFEED: feed has no items.');
    for (const item of items) {
      out.push(fields.map((f) => {
        const v = item[f];
        return v === '' ? EmptyValue : asVal(v);
      }));
    }
    if (out.length === 0) return new CellError(ErrorType.NA, 'IMPORTFEED: feed has no items.');
    const cap = checkCellCap(out.length * fields.length, 'IMPORTFEED');
    if (cap) return cap;
    return out;
  } catch (e) {
    return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// IMPORTXML — fetch XML + FILTERXML XPath subset.
// ---------------------------------------------------------------------------

/**
 * Evaluate IMPORTXML(url, xpath); returns matched node values as a single
 * column or a CellError. Reuses filterXmlValues from extended-functions10.
 * Exported for the host-side spill path below.
 */
export function importXmlValues(url: string, xpath: string): ArrayResult | CellError {
  try {
    const text = fetchImport(url, 'IMPORTXML');
    const xp = xpath.trim();
    if (xp === '') return new CellError(ErrorType.VALUE, 'IMPORTXML requires an XPath.');
    const values = filterXmlValues(text, xp);
    if (values instanceof CellError) return values;
    const arr: ArrayResult = values.map((v) => [v === '' ? EmptyValue : asVal(v)]);
    const cap = checkCellCap(arr.length, 'IMPORTXML');
    if (cap) return cap;
    return arr;
  } catch (e) {
    return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Host-side spill paths (mirror spillFilterXml in extended-functions10):
// re-evaluate and write through dynamic-arrays' spill() so the anchor cell
// keeps the formula and neighbours receive static values.
// ---------------------------------------------------------------------------

type SetCell = (row: number, col: number, value: InterpreterValue) => void;
type GetCell = (row: number, col: number) => InterpreterValue | undefined;

function spillResult(
  anchorRow: number,
  anchorCol: number,
  result: ArrayResult | CellError,
  setCell: SetCell,
  getCell?: GetCell,
): CellError | 'ok' {
  if (result instanceof CellError) return result;
  return spill(anchorRow, anchorCol, result, setCell, getCell);
}

export function spillImportData(
  anchorRow: number,
  anchorCol: number,
  url: string,
  delimiter: string | undefined,
  setCell: SetCell,
  getCell?: GetCell,
): CellError | 'ok' {
  return spillResult(anchorRow, anchorCol, importDataValues(url, delimiter), setCell, getCell);
}

export function spillImportFeed(
  anchorRow: number,
  anchorCol: number,
  url: string,
  query: string | undefined,
  headers: number | null | undefined,
  numItems: number | null | undefined,
  setCell: SetCell,
  getCell?: GetCell,
): CellError | 'ok' {
  return spillResult(anchorRow, anchorCol, importFeedValues(url, query, headers, numItems), setCell, getCell);
}

export function spillImportHtml(
  anchorRow: number,
  anchorCol: number,
  url: string,
  query: string,
  index: number,
  setCell: SetCell,
  getCell?: GetCell,
): CellError | 'ok' {
  return spillResult(anchorRow, anchorCol, importHtmlValues(url, query, index), setCell, getCell);
}

export function spillImportXml(
  anchorRow: number,
  anchorCol: number,
  url: string,
  xpath: string,
  setCell: SetCell,
  getCell?: GetCell,
): CellError | 'ok' {
  return spillResult(anchorRow, anchorCol, importXmlValues(url, xpath), setCell, getCell);
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

export class ImportFunctionsPlugin extends FunctionPlugin {
  public static implementedFunctions: Record<
    string,
    { method: string; parameters: Arg[]; repeatLastArgs?: number }
  > = {
    IMPORTDATA: { method: 'importdata', parameters: [S(), S(true)] },
    IMPORTFEED: {
      method: 'importfeed',
      parameters: [S(), S(true), N(true), N(true)],
    },
    IMPORTHTML: { method: 'importhtml', parameters: [S(), S(), N()] },
    IMPORTXML: { method: 'importxml', parameters: [S(), S()] },
  };

  public importdata(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('IMPORTDATA'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [urlArg, delimArg] = args;
        if (urlArg instanceof CellError) return urlArg;
        const url = scalarText(urlArg ?? EmptyValue);
        const delim = delimArg instanceof CellError || delimArg === undefined || delimArg === EmptyValue
          ? undefined
          : scalarText(delimArg);
        const result = importDataValues(url, delim);
        return result instanceof CellError ? result : asVal(result);
      },
    );
  }

  public importfeed(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('IMPORTFEED'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [urlArg, queryArg, headersArg, numItemsArg] = args;
        if (urlArg instanceof CellError) return urlArg;
        const url = scalarText(urlArg ?? EmptyValue);
        const query = queryArg instanceof CellError || queryArg === undefined || queryArg === EmptyValue
          ? undefined
          : scalarText(queryArg);
        const headers = headersArg instanceof CellError
          ? headersArg
          : headersArg === undefined || headersArg === EmptyValue
            ? null
            : asNumber(headersArg, 'IMPORTFEED headers');
        if (headers instanceof CellError) return headers;
        const numItems = numItemsArg instanceof CellError
          ? numItemsArg
          : numItemsArg === undefined || numItemsArg === EmptyValue
            ? null
            : asNumber(numItemsArg, 'IMPORTFEED num_items');
        if (numItems instanceof CellError) return numItems;
        const result = importFeedValues(url, query, headers, numItems);
        return result instanceof CellError ? result : asVal(result);
      },
    );
  }

  public importhtml(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('IMPORTHTML'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [urlArg, queryArg, indexArg] = args;
        if (urlArg instanceof CellError) return urlArg;
        if (queryArg instanceof CellError) return queryArg;
        const url = scalarText(urlArg ?? EmptyValue);
        const query = scalarText(queryArg ?? EmptyValue);
        const index = asNumber(indexArg ?? EmptyValue, 'IMPORTHTML index');
        if (index instanceof CellError) return index;
        const result = importHtmlValues(url, query, Math.trunc(index));
        return result instanceof CellError ? result : asVal(result);
      },
    );
  }

  public importxml(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('IMPORTXML'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [urlArg, xpathArg] = args;
        if (urlArg instanceof CellError) return urlArg;
        if (xpathArg instanceof CellError) return xpathArg;
        const url = scalarText(urlArg ?? EmptyValue);
        const xpath = scalarText(xpathArg ?? EmptyValue);
        const result = importXmlValues(url, xpath);
        return result instanceof CellError ? result : asVal(result);
      },
    );
  }
}

let registered = false;

/** Register IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTXML. Idempotent. */
export function registerImportFunctions(): void {
  if (registered || HyperFormula.getFunctionPlugin('IMPORTDATA') !== undefined) {
    registered = true;
    return;
  }
  const names = {
    IMPORTDATA: 'IMPORTDATA',
    IMPORTFEED: 'IMPORTFEED',
    IMPORTHTML: 'IMPORTHTML',
    IMPORTXML: 'IMPORTXML',
  };
  HyperFormula.registerFunctionPlugin(ImportFunctionsPlugin, { enGB: names, enUS: names });
  registered = true;
}
