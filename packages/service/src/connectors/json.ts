/**
 * json-url connector — fetch JSON over HTTP and normalize to a flat table.
 *
 * Params:
 * - url (required): http(s) URL returning JSON.
 * - path (optional): dot/bracket path to the array (or object) holding the
 *   records, e.g. "data.items", "results", "[0].rows". Empty = document root.
 * - flatten (optional): 'true' (default) or 'false'. When true, nested
 *   objects are flattened with dot-notation keys ("address.city"); nested
 *   arrays are serialized as compact JSON strings.
 *
 * NORMALIZATION STRATEGY (documented contract):
 * 1. The value at `path` (or the document root) must be an array of objects,
 *    a single object (treated as one row), or an array of primitives
 *    (single "value" column).
 * 2. Flattening is one strategy applied uniformly: nested objects recurse
 *    with dot-joined keys; arrays become JSON strings; null stays null;
 *    primitives become text/number/boolean cells.
 * 3. Column order is first-seen order across all rows (stable, deterministic).
 * 4. Rows missing a key get null for that column; extra keys extend the
 *    column set. Duplicate flattened keys within one object keep the first.
 * 5. flatten=false keeps only top-level primitive fields; nested
 *    objects/arrays become JSON strings under their original key.
 */
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import { makeTableData, uniqueColumns, type TableCell, type TableData } from './table.js';
import type { Connector, ResolvedConnectorDeps } from './registry.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export class JsonUrlConnector implements Connector {
  readonly kind: ConnectorKind = 'json-url';
  readonly displayName = 'JSON from URL';
  readonly paramHelp =
    'url: http(s) address returning JSON. path: dot/bracket path to the records array (optional). flatten: true|false.';

  async fetch(spec: ConnectorSpec, deps: ResolvedConnectorDeps): Promise<TableData> {
    const url = (spec.params['url'] ?? '').trim();
    const path = (spec.params['path'] ?? '').trim();
    const flatten = (spec.params['flatten'] ?? 'true').trim().toLowerCase() !== 'false';
    const text = await deps.fetchText(url);
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('response is not valid JSON');
    }
    const target = path === '' ? doc : getPath(doc, path);
    if (target === undefined) throw new Error(`JSON path "${path}" not found in response`);
    return jsonToTable(target, flatten);
  }
}

/**
 * Resolve a dot/bracket path like "data.items", "results[0].rows" against a
 * parsed JSON document. Returns undefined when any segment is missing.
 */
export function getPath(doc: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s !== '');
  let cur: unknown = doc;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Flatten one JSON object to dot-notation entries (documented strategy). */
export function flattenRecord(
  obj: Record<string, JsonValue>,
  flatten: boolean,
  prefix = '',
  out: Array<[string, TableCell]> = [],
): Array<[string, TableCell]> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (flatten && isPlainObject(v)) {
      flattenRecord(v, flatten, key, out);
    } else if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out.push([key, v]);
    } else {
      // Nested arrays, or nested objects when flatten=false: JSON string.
      out.push([key, JSON.stringify(v)]);
    }
  }
  return out;
}

/** Normalize a JSON value at the records path to a TableData. */
export function jsonToTable(target: unknown, flatten: boolean): TableData {
  let records: unknown[];
  if (Array.isArray(target)) {
    records = target;
  } else if (isPlainObject(target as JsonValue)) {
    records = [target];
  } else {
    throw new Error('JSON path must point to an array of objects or a single object');
  }
  const columnOrder: string[] = [];
  const seen = new Set<string>();
  const flatRows: Array<Array<[string, TableCell]>> = [];
  for (const rec of records) {
    if (Array.isArray(rec)) {
      // Array of primitives → single "value" column rows.
      const entries: Array<[string, TableCell]> = rec.map((v) => [
        'value',
        isPlainObject(v as JsonValue) || Array.isArray(v)
          ? (JSON.stringify(v) as TableCell)
          : (v as TableCell),
      ]);
      flatRows.push(entries);
    } else if (isPlainObject(rec as JsonValue)) {
      const entries = flattenRecord(rec as Record<string, JsonValue>, flatten);
      flatRows.push(entries);
    } else {
      flatRows.push([['value', rec as TableCell]]);
    }
    for (const [k] of flatRows[flatRows.length - 1] as Array<[string, TableCell]>) {
      if (!seen.has(k)) {
        seen.add(k);
        columnOrder.push(k);
      }
    }
  }
  const columns = uniqueColumns(columnOrder);
  // Map original keys → deduped names (uniqueColumns is order-preserving).
  const keyToCol = new Map<string, string>();
  columnOrder.forEach((k, i) => keyToCol.set(k, columns[i] as string));
  const rows: TableCell[][] = flatRows.map((entries) => {
    const byKey = new Map<string, TableCell>();
    for (const [k, v] of entries) if (!byKey.has(k)) byKey.set(k, v);
    return columns.map((c, i) => {
      const orig = columnOrder[i] as string;
      return byKey.has(orig) ? (byKey.get(orig) as TableCell) : null;
    });
  });
  return makeTableData(columns, rows);
}
