/**
 * csv-url connector — fetch a CSV/TSV file over HTTP and normalize to a table.
 *
 * Params:
 * - url (required): http(s) URL of the CSV text.
 * - delimiter (optional): 'auto' (default), 'comma', 'tab', 'semicolon', 'pipe'.
 * - hasHeader (optional): 'true' (default) or 'false'. Without a header the
 *   columns are named Column1, Column2, …
 *
 * Parsing reuses the @icecream-sheets/csv-adapter (the same substrate as the
 * ETL fetch component and the file-based CSV path). Header names are
 * de-duplicated ("a", "a_2", …); blank rows are dropped.
 */
import { detectDelimiter, parseCsv, type CsvDelimiter } from '@icecream-sheets/csv-adapter';
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import { makeTableData, uniqueColumns, type TableCell, type TableData } from './table.js';
import type { Connector, ResolvedConnectorDeps } from './registry.js';

const DELIMITERS: Record<string, CsvDelimiter> = {
  comma: ',',
  tab: '\t',
  semicolon: ';',
  pipe: '|',
};

export class CsvUrlConnector implements Connector {
  readonly kind: ConnectorKind = 'csv-url';
  readonly displayName = 'CSV from URL';
  readonly paramHelp =
    'url: http(s) address of the CSV file. delimiter: auto|comma|tab|semicolon|pipe. hasHeader: true|false.';

  async fetch(spec: ConnectorSpec, deps: ResolvedConnectorDeps): Promise<TableData> {
    const url = (spec.params['url'] ?? '').trim();
    const delimName = (spec.params['delimiter'] ?? 'auto').trim().toLowerCase();
    const hasHeader = (spec.params['hasHeader'] ?? 'true').trim().toLowerCase() !== 'false';
    const text = await deps.fetchText(url);
    const delim: CsvDelimiter =
      delimName === 'auto' || delimName === '' ? detectDelimiter(text) : resolveDelimiter(delimName);
    const matrix = parseCsv(text, delim).filter((r) => r.some((c) => c.trim() !== ''));
    if (matrix.length === 0) return makeTableData([], []);
    const first = matrix[0] as string[];
    const columns = uniqueColumns(
      hasHeader ? first : first.map((_, i) => `Column${i + 1}`),
    );
    const dataRows = hasHeader ? matrix.slice(1) : matrix;
    const rows: TableCell[][] = dataRows.map((r) =>
      columns.map((_, i) => {
        const raw = i < r.length ? (r[i] as string) : '';
        return coerceCell(raw);
      }),
    );
    return makeTableData(columns, rows);
  }
}

function resolveDelimiter(name: string): CsvDelimiter {
  const d = DELIMITERS[name];
  if (!d) throw new Error(`unsupported CSV delimiter "${name}" (use auto|comma|tab|semicolon|pipe)`);
  return d;
}

/** Coerce a raw CSV field: empty → null, numeric → number, else string. */
export function coerceCell(raw: string): TableCell {
  const t = raw.trim();
  if (t === '') return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  const low = t.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  return raw;
}
