/**
 * IMPORTRANGE and GOOGLEFINANCE — the Google-connector formula functions
 * (design-docs/connector-vs-component.md: "GOOGLEFINANCE, GOOGLETRANSLATE,
 * DETECTLANGUAGE and IMPORTRANGE use Google connectors").
 *
 * Both are synchronous HyperFormula plugins (the engine is synchronous).
 *
 * - IMPORTRANGE(spreadsheet_url, range_string) — pull a range from another
 *   Google Sheet through the Google Sheets API v4
 *   (spreadsheets.values.get), using the host's Google connector
 *   credential. The credential (API key or OAuth2 token) is supplied by the
 *   host via setGoogleApiCredential(); hosts can also pre-feed data with
 *   publishImportRangeData() (e.g. after fetching through the service
 *   connector layer), which the function reads first. Values come back as a
 *   spilled 2D array.
 * - GOOGLEFINANCE(ticker, [attribute], [start_date], [end_date], [interval])
 *   — market data through the market-data provider seam shared with
 *   STOCKHISTORY (extended-functions11.ts): published bars first, then the
 *   Stooq default over synchronous curl, or a host-wired provider.
 *   Single-value attributes return a scalar; with start_date/end_date the
 *   function returns a [Date, value] history table. Attributes not backed
 *   by OHLCV data (pe, eps, beta, marketcap, shares, currency, ...) return
 *   #N/A with an honest message rather than fabricated numbers.
 *
 * This module does NOT self-register on import: hosts call
 * registerGoogleFunctions() explicitly (it is idempotent), and plugins.ts
 * registers it with the standard plugin set.
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
import { fetchUrlText } from './extended-functions11.js';
import { getMarketBars } from './extended-functions11.js';
import type { MarketBar, MarketInterval } from './extended-functions11.js';

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

type Arg = { argumentType: FunctionArgumentType; optionalArg?: boolean };
const S = (optionalArg = false): Arg => ({ argumentType: FunctionArgumentType.SCALAR, optionalArg });

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

/** Cap on cells per IMPORTRANGE / GOOGLEFINANCE call (network data is untrusted). */
const GOOGLE_MAX_CELLS = 100_000;

/** Cap on fetched text per call. */
const GOOGLE_MAX_TEXT = 4_000_000;

/** Excel serial (1900 system) or date string -> YYYY-MM-DD. */
function toIsoDate(v: InterpreterValue): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// IMPORTRANGE — Google Sheets API v4 via the host's Google connector.
// ---------------------------------------------------------------------------

/** Host-supplied Google credential for the Sheets API. */
export interface GoogleApiCredential {
  /** Google Cloud API key (key= query parameter). */
  apiKey?: string;
  /** OAuth2 access token (access_token= query parameter). */
  accessToken?: string;
}

let googleCredential: GoogleApiCredential | null = null;

/**
 * Set the Google credential IMPORTRANGE uses for the Sheets API. The host
 * resolves this from its Google connector's vault credentialRef; the secret
 * lives in the vault, never in workbook bytes. Either an API key or an
 * OAuth2 access token works against spreadsheets.values.get.
 */
export function setGoogleApiCredential(cred: GoogleApiCredential | null): void {
  googleCredential = cred;
}

/** Read the current credential (hosts may wrap it for their own flows). */
export function getGoogleApiCredential(): GoogleApiCredential | null {
  return googleCredential;
}

interface ImportRangeCacheEntry {
  values: unknown[][];
}

const importRangeCache = new Map<string, ImportRangeCacheEntry>();

function importRangeKey(spreadsheetId: string, range: string): string {
  return `${spreadsheetId}\u0001${range}`;
}

/**
 * Publish IMPORTRANGE data into the engine (e.g. after the host fetched it
 * through the service Google connector). IMPORTRANGE reads the cache first,
 * so hosts can pre-feed data asynchronously and IMPORTRANGE works with zero
 * live calls.
 */
export function publishImportRangeData(
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): void {
  importRangeCache.set(importRangeKey(spreadsheetId, range), { values });
}

/** Clear published IMPORTRANGE data (tests). */
export function clearImportRangeData(): void {
  importRangeCache.clear();
}

/**
 * Extract the spreadsheet id from a Google Sheets URL
 * (https://docs.google.com/spreadsheets/d/<id>/...) or accept a bare id.
 */
export function parseSpreadsheetId(urlOrId: string): string {
  const t = urlOrId.trim();
  if (t === '') throw new Error('IMPORTRANGE requires a spreadsheet URL.');
  const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1]!;
  if (/^[a-zA-Z0-9-_]{20,}$/.test(t)) return t;
  throw new Error(
    `IMPORTRANGE: "${t}" is not a Google Sheets URL (expected https://docs.google.com/spreadsheets/d/<id>/...) or a spreadsheet id.`,
  );
}

interface SheetsValuesResponse {
  values?: unknown[][];
}

/**
 * Fetch a range through spreadsheets.values.get, using the host's Google
 * credential (API key or OAuth2 token). Returns the raw 2D values grid.
 */
export function fetchSheetsRange(
  spreadsheetId: string,
  range: string,
  cred: GoogleApiCredential,
): unknown[][] {
  const cred2 = cred.apiKey
    ? `key=${encodeURIComponent(cred.apiKey)}`
    : cred.accessToken
      ? `access_token=${encodeURIComponent(cred.accessToken)}`
      : '';
  if (cred2 === '') {
    throw new Error(
      'IMPORTRANGE: no Google credential. The host must call setGoogleApiCredential() ' +
        '(resolved from the Google connector vault credentialRef), or pre-feed data with publishImportRangeData().',
    );
  }
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&${cred2}`;
  let text: string;
  try {
    text = fetchUrlText(url, GOOGLE_MAX_TEXT);
  } catch (e) {
    throw new Error(`IMPORTRANGE: Sheets API call failed (${e instanceof Error ? e.message : String(e)}).`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('IMPORTRANGE: the Sheets API did not return valid JSON.');
  }
  const err = (doc as { error?: { message?: string } })?.error;
  if (err) {
    throw new Error(`IMPORTRANGE: Sheets API error: ${String(err.message ?? 'unknown')}`);
  }
  const values = (doc as SheetsValuesResponse).values;
  if (!Array.isArray(values)) return [];
  return values;
}

function gridToInterpreter(values: unknown[][]): InterpreterValue {
  const rows: InterpreterValue[][] = [];
  let cells = 0;
  for (const row of values) {
    if (!Array.isArray(row)) continue;
    const out: InterpreterValue[] = [];
    for (const v of row) {
      cells += 1;
      if (cells > GOOGLE_MAX_CELLS) {
        throw new Error(`IMPORTRANGE: range exceeds ${GOOGLE_MAX_CELLS} cells.`);
      }
      if (v === null || v === undefined) out.push(EmptyValue);
      else if (typeof v === 'number' && !Number.isFinite(v)) {
        throw new Error('IMPORTRANGE: range contains a non-finite number.');
      } else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        out.push(v);
      } else {
        out.push(String(v));
      }
    }
    rows.push(out);
  }
  return asVal(rows);
}

// ---------------------------------------------------------------------------
// GOOGLEFINANCE — market data through the market-data provider seam.
// ---------------------------------------------------------------------------

/**
 * Attribute -> bar accessor. Only attributes backed by OHLCV market data
 * are supported; everything else is #N/A (never fabricated).
 */
const GOOGLEFINANCE_ATTRIBUTES: Record<string, (b: MarketBar) => number> = {
  price: (b) => b.close,
  open: (b) => b.open,
  high: (b) => b.high,
  low: (b) => b.low,
  volume: (b) => b.volume,
  previousclose: (b) => b.close, // resolved against the prior bar below
  closeyest: (b) => b.close, // Google alias for previousclose
};

function attributeOf(attr: string, bars: MarketBar[], bar: MarketBar): number | null {
  const a = norm(attr);
  if (a === 'previousclose' || a === 'closeyest') {
    const i = bars.indexOf(bar);
    const prev = i > 0 ? bars[i - 1] : null;
    return prev ? prev.close : null;
  }
  if (a === 'changepct') {
    const i = bars.indexOf(bar);
    const prev = i > 0 ? bars[i - 1] : null;
    if (!prev || prev.close === 0) return null;
    return ((bar.close - prev.close) / prev.close) * 100;
  }
  if (a === 'volumeavg') {
    const window = bars.slice(-30);
    if (window.length === 0) return null;
    return window.reduce((s, b) => s + b.volume, 0) / window.length;
  }
  if (a === 'high52' || a === 'low52') {
    const window = bars.slice(-252);
    if (window.length === 0) return null;
    const highs = window.map((b) => b.high);
    const lows = window.map((b) => b.low);
    return a === 'high52' ? Math.max(...highs) : Math.min(...lows);
  }
  const fn = GOOGLEFINANCE_ATTRIBUTES[a];
  return fn ? fn(bar) : null;
}

const SUPPORTED_ATTRIBUTES = [
  'price',
  'open',
  'high',
  'low',
  'volume',
  'previousclose',
  'changepct',
  'volumeavg',
  'high52',
  'low52',
];

function parseGoogleInterval(v: InterpreterValue): MarketInterval | null {
  const t = norm(scalarText(v ?? EmptyValue));
  if (t === '' || t === 'daily') return 'd';
  if (t === 'weekly') return 'w';
  if (t === 'monthly') return 'm';
  return null;
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

export class GoogleFunctionsPlugin extends FunctionPlugin {
  public static implementedFunctions: Record<
    string,
    { method: string; parameters: Arg[]; repeatLastArgs?: number }
  > = {
    IMPORTRANGE: { method: 'importrange', parameters: [S(), S()] },
    GOOGLEFINANCE: {
      method: 'googlefinance',
      parameters: [S(), S(true), S(true), S(true), S(true)],
    },
  };

  public importrange(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('IMPORTRANGE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [urlArg, rangeArg] = args;
        if (urlArg instanceof CellError) return urlArg;
        if (rangeArg instanceof CellError) return rangeArg;
        let spreadsheetId: string;
        try {
          spreadsheetId = parseSpreadsheetId(scalarText(urlArg ?? EmptyValue));
        } catch (e) {
          return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
        }
        const range = scalarText(rangeArg ?? EmptyValue).trim();
        if (range === '') {
          return new CellError(ErrorType.VALUE, 'IMPORTRANGE requires a range string, e.g. "Sheet1!A1:C10".');
        }
        const cached = importRangeCache.get(importRangeKey(spreadsheetId, range));
        if (cached) {
          try {
            return gridToInterpreter(cached.values);
          } catch (e) {
            return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
          }
        }
        const cred = googleCredential;
        if (!cred) {
          return new CellError(
            ErrorType.NA,
            'IMPORTRANGE: no Google credential and no cached data for this range. ' +
              'The host must call setGoogleApiCredential() (Google connector vault credentialRef) ' +
              'or pre-feed data with publishImportRangeData().',
          );
        }
        try {
          return gridToInterpreter(fetchSheetsRange(spreadsheetId, range, cred));
        } catch (e) {
          return new CellError(ErrorType.NA, e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  public googlefinance(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('GOOGLEFINANCE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [tickerArg, attrArg, startArg, endArg, intervalArg] = args;
        if (tickerArg instanceof CellError) return tickerArg;
        const ticker = scalarText(tickerArg ?? EmptyValue).trim();
        if (ticker === '') {
          return new CellError(ErrorType.VALUE, 'GOOGLEFINANCE requires a ticker symbol.');
        }
        const attribute = norm(scalarText(attrArg ?? EmptyValue)) || 'price';
        const unsupported = !SUPPORTED_ATTRIBUTES.includes(attribute);
        if (unsupported) {
          return new CellError(
            ErrorType.NA,
            `GOOGLEFINANCE: attribute "${attribute}" is not backed by market OHLCV data. ` +
              `Supported: ${SUPPORTED_ATTRIBUTES.join(', ')}.`,
          );
        }
        const historical = startArg !== undefined && startArg !== EmptyValue;
        const end = toIsoDate(endArg ?? EmptyValue) ?? todayIso();
        const start = historical ? (toIsoDate(startArg ?? EmptyValue) ?? addDaysIso(end, -90)) : addDaysIso(end, -400);
        if (start > end) {
          return new CellError(ErrorType.VALUE, 'GOOGLEFINANCE: start date is after end date.');
        }
        const interval = parseGoogleInterval(intervalArg ?? EmptyValue);
        if (!interval) {
          return new CellError(
            ErrorType.VALUE,
            'GOOGLEFINANCE: interval must be "DAILY", "WEEKLY" or "MONTHLY".',
          );
        }
        let bars: MarketBar[];
        try {
          // The provider contract is "bars for the requested window" (the
          // Stooq default filters server-side; the cache path filters in
          // getMarketBars). Scalar mode trusts the window and takes the
          // latest bar; historical mode re-filters defensively since the
          // rows are user-visible.
          const raw = getMarketBars(ticker, start, end, interval);
          bars = historical ? raw.filter((b) => b.date >= start && b.date <= end) : raw;
        } catch (e) {
          return new CellError(ErrorType.NA, e instanceof Error ? e.message : String(e));
        }
        if (bars.length === 0) {
          return new CellError(ErrorType.NA, `GOOGLEFINANCE: no data for "${ticker}" in ${start}..${end}.`);
        }
        if (!historical) {
          const last = bars[bars.length - 1]!;
          const value = attributeOf(attribute, bars, last);
          if (value === null || !Number.isFinite(value)) {
            return new CellError(ErrorType.NA, `GOOGLEFINANCE: no "${attribute}" value for "${ticker}".`);
          }
          return value;
        }
        // Historical mode: [Date, value] table, like Google Sheets.
        const rows: InterpreterValue[][] = [];
        let cells = 0;
        for (const b of bars) {
          const value = attributeOf(attribute, bars, b);
          cells += 2;
          if (cells > GOOGLE_MAX_CELLS) {
            return new CellError(ErrorType.VALUE, `GOOGLEFINANCE: range exceeds ${GOOGLE_MAX_CELLS} cells.`);
          }
          rows.push([b.date, value === null || !Number.isFinite(value) ? EmptyValue : value]);
        }
        return asVal(rows);
      },
    );
  }
}

let registered = false;

/** Register IMPORTRANGE and GOOGLEFINANCE. Idempotent. */
export function registerGoogleFunctions(): void {
  if (registered || HyperFormula.getFunctionPlugin('IMPORTRANGE') !== undefined) {
    registered = true;
    return;
  }
  const names = { IMPORTRANGE: 'IMPORTRANGE', GOOGLEFINANCE: 'GOOGLEFINANCE' };
  HyperFormula.registerFunctionPlugin(GoogleFunctionsPlugin, { enGB: names, enUS: names });
  registered = true;
}
