/**
 * ETL pipeline — source node readers (the fetch component).
 *
 * Per design-docs/etl-pipeline.md §2 and §7, the built-in fetch component
 * (uploaded files and public URLs) shares one substrate with the
 * IMPORTDATA/IMPORTFEED/IMPORTHTML/IMPORTXML/IMAGE functions: CSV/JSON
 * parsing reuses the csv-adapter logic, and URL fetching is plain HTTP.
 * Authenticated sources go through the connector registry (connectors.ts),
 * never through this component.
 */

import { detectDelimiter, parseCsv, type CsvDelimiter } from '@icecream-sheets/csv-adapter';
import {
  CONNECTOR_SPEC_VERSION,
  type ConnectorKind,
  type ConnectorSpec,
} from '../connectors/spec.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { CredentialResolver } from './connectors.js';
import { makeTable, type EtlColumn, type EtlTable, type EtlValue } from './types.js';
import type { EtlSource } from './recipe.js';

export interface SourceDeps {
  /** Fetch URL text. Injected so tests don't hit the network. */
  fetchText: (url: string) => Promise<string>;
  /**
   * The canonical connector registry (packages/service/src/connectors).
   * RESOLVED 2026-10-18: single registry per etl-pipeline.md §2 — ETL
   * source nodes consume it via fetch(), no ETL-local registry.
   */
  connectors?: ConnectorRegistry;
  vault?: CredentialResolver;
  /** Safety cap for connector extraction. Defaults to 100_000. */
  maxSourceRows?: number;
}

const DELIMITERS: Record<string, CsvDelimiter> = {
  ',': ',', '\t': '\t', ';': ';', '|': '|',
  'comma': ',', 'tab': '\t', 'semicolon': ';', 'pipe': '|',
};

function resolveDelimiter(spec?: string): CsvDelimiter | 'auto' {
  if (!spec) return 'auto';
  const d = DELIMITERS[spec];
  if (!d) throw new Error(`unsupported CSV delimiter "${spec}"`);
  return d;
}

export function csvTextToTable(text: string, delimiter?: string, hasHeader = true): EtlTable {
  const spec = resolveDelimiter(delimiter);
  const delim: CsvDelimiter = spec === 'auto' ? detectDelimiter(text) : spec;
  const matrix = parseCsv(text, delim).filter((r) => r.some((c) => c.trim() !== ''));
  if (matrix.length === 0) return { columns: [], rows: [] };
  const headerRow = hasHeader ? matrix[0] : matrix[0].map((_, i) => `Column${i + 1}`);
  const headers = headerRow.map((h, i) => {
    const t = h.trim();
    return t === '' ? `Column${i + 1}` : t;
  });
  // De-duplicate headers (a.b, a.b_2, ...) — tables need unique names.
  const seen = new Map<string, number>();
  const unique = headers.map((h) => {
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });
  const dataRows = hasHeader ? matrix.slice(1) : matrix;
  return makeTable(
    unique,
    dataRows.map((r) => unique.map((_, i) => (i < r.length ? (r[i] as EtlValue) : null))),
  );
}

export function jsonTextToTable(text: string): EtlTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('source is not valid JSON');
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj['data'])) parsed = obj['data'];
  }
  if (!Array.isArray(parsed)) {
    throw new Error('JSON source must be an array of objects (or { "data": [...] })');
  }
  if (parsed.length === 0) return { columns: [], rows: [] };
  const names: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('JSON source array must contain objects');
    }
    for (const k of Object.keys(item)) {
      if (!names.includes(k)) names.push(k);
    }
  }
  const columns: EtlColumn[] = names.map((name) => ({ name, type: 'unknown' }));
  const rows = parsed.map((item) => {
    const rec = item as Record<string, unknown>;
    const row: Record<string, EtlValue> = {};
    for (const n of names) {
      const v: unknown = rec[n];
      row[n] =
        v === null || v === undefined ? null
        : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v
        : String(v);
    }
    return row;
  });
  return { columns, rows };
}

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

/** Read any source node into a typed table. */
export async function readSource(source: EtlSource, deps: SourceDeps): Promise<EtlTable> {
  switch (source.type) {
    case 'csv-text':
      return csvTextToTable(source.text, source.delimiter, source.hasHeader ?? true);
    case 'json-text':
      return jsonTextToTable(source.text);
    case 'url': {
      const text = await deps.fetchText(source.url);
      const format = source.format === 'auto' ? (looksLikeJson(text) ? 'json' : 'csv') : source.format;
      return format === 'json' ? jsonTextToTable(text) : csvTextToTable(text);
    }
    case 'connector': {
      if (!deps.connectors) throw new Error('no connector registry configured');
      if (!deps.vault) throw new Error('no credential vault configured — connector sources need the service vault');
      // Single-registry resolution (2026-10-18): the ETL source node pulls
      // from the canonical connector registry (etl-pipeline.md §2) via its
      // spec-driven fetch(). connectorId is the registered kind.
      const spec: ConnectorSpec = {
        version: CONNECTOR_SPEC_VERSION,
        kind: source.connectorId as ConnectorKind,
        label: source.connectorId,
        params: source.parameters ?? {},
        credentialRef: source.credentialRef,
      };
      const vault = deps.vault;
      const table = await deps.connectors.fetch(spec, {
        resolveCredential: vault,
        maxRows: deps.maxSourceRows ?? 100_000,
      });
      const columns: EtlColumn[] = table.columns.map((name) => ({ name, type: 'unknown' }));
      const rows = table.rows.map((cells) => {
        const row: Record<string, EtlValue> = {};
        table.columns.forEach((name, i) => {
          const v: unknown = cells[i];
          row[name] = v === null || v === undefined ? null : (v as EtlValue);
        });
        return row;
      });
      return { columns, rows };
    }
  }
}
