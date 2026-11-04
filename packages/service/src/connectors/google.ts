/**
 * Google Sheets connector — the Google-connector data source behind
 * IMPORTRANGE (design-docs/connector-vs-component.md:
 * "GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE and IMPORTRANGE use
 * Google connectors"; auth: "OAuth2 / API key via vault credentialRef").
 *
 * Params:
 * - spreadsheetId (required): the Google Sheets id, or a full
 *   https://docs.google.com/spreadsheets/d/<id>/... URL.
 * - range (required): A1-notation range, e.g. "Sheet1!A1:D50".
 * - auth (optional): 'oauth2' (default) | 'apikey'. OAuth2 sends the vault
 *   secret as a Bearer <redacted> the API key as the `key=` query parameter.
 *
 * The spec carries only an opaque `credentialRef` (never the secret): the
 * token/key is resolved transiently through CredentialResolver and used in
 * the request, never persisted or logged. Fails closed when a credentialRef
 * is present but no resolver is wired.
 *
 * This is the connector hosts use to feed IMPORTRANGE: fetch() a range here
 * and publish the grid into the engine with publishImportRangeData()
 * (packages/engine/src/google-functions.ts), or resolve the credential and
 * hand it to the engine via setGoogleApiCredential().
 */
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import { makeTableData, type TableCell, type TableData } from './table.js';
import type { Connector, ResolvedConnectorDeps } from './registry.js';

/** Cap on cells per fetch (network data is untrusted; matches the engine's IMPORTRANGE cap). */
export const GOOGLE_SHEETS_MAX_CELLS = 100_000;

/** Cap on fetched JSON text per call. */
export const GOOGLE_SHEETS_MAX_TEXT = 4_000_000;

/**
 * Extract the spreadsheet id from a Google Sheets URL
 * (https://docs.google.com/spreadsheets/d/<id>/...) or accept a bare id.
 */
export function parseSpreadsheetId(urlOrId: string): string {
  const t = (urlOrId ?? '').trim();
  if (t === '') throw new Error('param "spreadsheetId" is required');
  const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1]!;
  if (/^[a-zA-Z0-9-_]{20,}$/.test(t)) return t;
  throw new Error(
    `param "spreadsheetId" is not a Google Sheets URL (expected https://docs.google.com/spreadsheets/d/<id>/...) or a spreadsheet id.`,
  );
}

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { message?: string; code?: number };
}

/** Parse a spreadsheets.values.get payload into a 2D grid (throws on API errors). */
export function parseSheetsValues(doc: unknown): unknown[][] {
  if (typeof doc !== 'object' || doc === null) {
    throw new Error('the Sheets API did not return a JSON object');
  }
  const rec = doc as SheetsValuesResponse;
  if (rec.error) {
    throw new Error(`Sheets API error: ${String(rec.error.message ?? 'unknown')}`);
  }
  const values = rec.values;
  if (!Array.isArray(values)) return [];
  return values;
}

function toTableCell(v: unknown): TableCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return String(v);
}

/**
 * Convert the raw values grid into TableData (first row = headers). Enforces
 * the cell cap so a pathological range cannot OOM the host.
 */
export function sheetsValuesToTable(values: unknown[][]): TableData {
  let cells = 0;
  const rows: TableCell[][] = [];
  for (const row of values) {
    if (!Array.isArray(row)) continue;
    const out: TableCell[] = [];
    for (const v of row) {
      cells += 1;
      if (cells > GOOGLE_SHEETS_MAX_CELLS) {
        throw new Error(`range exceeds ${GOOGLE_SHEETS_MAX_CELLS} cells`);
      }
      out.push(toTableCell(v));
    }
    rows.push(out);
  }
  if (rows.length === 0) return makeTableData([], []);
  const width = Math.max(...rows.map((r) => r.length));
  const [header, ...body] = rows;
  const columns = Array.from({ length: width }, (_, i) => {
    const h = header?.[i];
    return typeof h === 'string' && h.trim() !== '' ? h.trim() : `Column ${i + 1}`;
  });
  return makeTableData(
    columns,
    body.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null)),
  );
}

export class GoogleSheetsConnector implements Connector {
  readonly kind: ConnectorKind = 'google-sheets';
  readonly displayName = 'Google Sheets';
  readonly paramHelp =
    'spreadsheetId: Sheets id or full docs.google.com URL (required). range: A1 notation, e.g. "Sheet1!A1:D50" (required). ' +
    'auth: oauth2 (default) | apikey. credentialRef: vault reference for the OAuth2 token or API key (required unless the host pre-feeds data).';

  async fetch(spec: ConnectorSpec, deps: ResolvedConnectorDeps): Promise<TableData> {
    const spreadsheetId = parseSpreadsheetId(String(spec.params['spreadsheetId'] ?? ''));
    const range = String(spec.params['range'] ?? '').trim();
    if (range === '') throw new Error('param "range" is required (A1 notation, e.g. "Sheet1!A1:D50")');
    const auth = String(spec.params['auth'] ?? 'oauth2').trim().toLowerCase();
    if (auth !== 'oauth2' && auth !== 'apikey') {
      throw new Error(`param "auth" must be "oauth2" or "apikey" (got "${auth}")`);
    }
    const credentialRef = (spec.credentialRef ?? '').trim();
    if (credentialRef === '') {
      throw new Error(
        'the Google Sheets connector needs a credentialRef (OAuth2 token or API key from the vault); ' +
          'hosts can also pre-feed data with publishImportRangeData()',
      );
    }
    if (!deps.resolveCredential) {
      throw new Error(
        `spec needs credential "${credentialRef}" but no credential resolver is wired`,
      );
    }
    const secret = await deps.resolveCredential.resolveCredential(credentialRef);
    const base =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
      `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
    let text: string;
    if (auth === 'apikey') {
      text = await deps.fetchText(`${base}&key=${encodeURIComponent(secret)}`);
    } else {
      text = await deps.fetchText(base, {
        headers: { Authorization: `Bearer ${secret}` },
      });
    }
    if (text.length > GOOGLE_SHEETS_MAX_TEXT) {
      throw new Error('Sheets API response exceeds the text cap');
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('the Sheets API did not return valid JSON');
    }
    return sheetsValuesToTable(parseSheetsValues(doc));
  }
}
