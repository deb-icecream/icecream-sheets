/**
 * Google Sheets connector tests (packages/service/src/connectors/google.ts).
 *
 * The Google-connector data source behind IMPORTRANGE: OAuth2 / API key via
 * vault credentialRef, spreadsheets.values.get, cell cap. All network and
 * credential resolution are faked — no live HTTP, no real secrets.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_SPEC_VERSION,
  GoogleSheetsConnector,
  GOOGLE_SHEETS_MAX_CELLS,
  createConnectorRegistry,
  parseSheetsValues,
  parseSpreadsheetId,
  resolveDeps,
  sheetsValuesToTable,
  validateConnectorSpec,
  type ConnectorSpec,
} from '../src/connectors/index.js';

const SHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

function sheetSpec(params: Record<string, string> = {}, credentialRef = 'vault:google-oauth'): ConnectorSpec {
  return {
    version: CONNECTOR_SPEC_VERSION,
    kind: 'google-sheets',
    label: 'Test Sheet',
    params: { spreadsheetId: SHEET_ID, range: 'Sheet1!A1:B2', ...params },
    credentialRef,
  };
}

const VALUES_BODY = JSON.stringify({
  range: 'Sheet1!A1:B2',
  values: [
    ['Name', 'Qty'],
    ['Apples', 3],
    ['Oranges', 7],
  ],
});

function fakeDeps(opts: { body?: string; secret?: string } = {}) {
  const calls: Array<{ url: string; init?: { headers?: Record<string, string>; method?: string } }> = [];
  const fetchText = async (url: string, init?: { headers?: Record<string, string>; method?: string }) => {
    calls.push({ url, init });
    return opts.body ?? VALUES_BODY;
  };
  const resolvedSecrets: string[] = [];
  const resolveCredential = {
    resolveCredential: async (ref: string) => {
      resolvedSecrets.push(ref);
      return opts.secret ?? 'SECRET-TOKEN';
    },
  };
  return { deps: resolveDeps({ fetchText, resolveCredential }), calls, resolvedSecrets };
}

// ---------------------------------------------------------------------------
// parseSpreadsheetId / parseSheetsValues / sheetsValuesToTable (pure)
// ---------------------------------------------------------------------------

describe('parseSpreadsheetId', () => {
  it('accepts a bare id', () => {
    expect(parseSpreadsheetId(SHEET_ID)).toBe(SHEET_ID);
  });

  it('extracts the id from a full Sheets URL', () => {
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`)).toBe(
      SHEET_ID,
    );
  });

  it('rejects empty input and non-Sheets URLs', () => {
    expect(() => parseSpreadsheetId('')).toThrow(/required/);
    expect(() => parseSpreadsheetId('https://example.com/x')).toThrow(/not a Google Sheets URL/);
  });
});

describe('parseSheetsValues', () => {
  it('returns the values grid', () => {
    expect(parseSheetsValues(JSON.parse(VALUES_BODY))).toEqual([
      ['Name', 'Qty'],
      ['Apples', 3],
      ['Oranges', 7],
    ]);
  });

  it('returns [] when values is absent', () => {
    expect(parseSheetsValues({})).toEqual([]);
  });

  it('throws on Sheets API errors', () => {
    expect(() => parseSheetsValues({ error: { message: 'not found' } })).toThrow(/Sheets API error: not found/);
  });
});

describe('sheetsValuesToTable', () => {
  it('uses the first row as headers', () => {
    const t = sheetsValuesToTable([
      ['Name', 'Qty'],
      ['Apples', 3],
    ]);
    expect(t.columns).toEqual(['Name', 'Qty']);
    expect(t.rows).toEqual([['Apples', 3]]);
  });

  it('enforces the cell cap', () => {
    const big: unknown[][] = [];
    for (let r = 0; r < 400; r += 1) big.push(new Array(400).fill(1));
    expect(() => sheetsValuesToTable(big)).toThrow(new RegExp(String(GOOGLE_SHEETS_MAX_CELLS)));
  });
});

// ---------------------------------------------------------------------------
// GoogleSheetsConnector.fetch (faked transport)
// ---------------------------------------------------------------------------

describe('GoogleSheetsConnector', () => {
  it('is registered in the canonical registry', () => {
    const registry = createConnectorRegistry();
    const c = registry.get('google-sheets');
    expect(c).toBeInstanceOf(GoogleSheetsConnector);
    expect(c.displayName).toMatch(/Google Sheets/);
  });

  it('fetches via spreadsheets.values.get with the OAuth2 bearer token', async () => {
    const { deps, calls, resolvedSecrets } = fakeDeps();
    const table = await new GoogleSheetsConnector().fetch(sheetSpec(), deps);
    expect(table.columns).toEqual(['Name', 'Qty']);
    expect(table.rows).toEqual([
      ['Apples', 3],
      ['Oranges', 7],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A1%3AB2`,
    );
    expect(calls[0]!.init?.headers?.['Authorization']).toBe('Bearer SECRET-TOKEN');
    expect(resolvedSecrets).toEqual(['vault:google-oauth']);
  });

  it('sends an API key as the key= query parameter in apikey mode', async () => {
    const { deps, calls } = fakeDeps();
    await new GoogleSheetsConnector().fetch(sheetSpec({ auth: 'apikey' }), deps);
    expect(calls[0]!.url).toContain('key=SECRET-TOKEN');
    expect(calls[0]!.init?.headers?.['Authorization']).toBeUndefined();
  });

  it('accepts a full Sheets URL as spreadsheetId', async () => {
    const { deps, calls } = fakeDeps();
    await new GoogleSheetsConnector().fetch(
      sheetSpec({ spreadsheetId: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` }),
      deps,
    );
    expect(calls[0]!.url).toContain(`/spreadsheets/${SHEET_ID}/values/`);
  });

  it('fails closed without a credentialRef', async () => {
    const { deps } = fakeDeps();
    const spec = sheetSpec();
    delete spec.credentialRef;
    await expect(new GoogleSheetsConnector().fetch(spec, deps)).rejects.toThrow(/credentialRef/);
  });

  it('fails closed when no credential resolver is wired', async () => {
    const deps = resolveDeps({ fetchText: async () => VALUES_BODY });
    await expect(new GoogleSheetsConnector().fetch(sheetSpec(), deps)).rejects.toThrow(
      /no credential resolver is wired/,
    );
  });

  it('rejects an unknown auth mode', async () => {
    const { deps } = fakeDeps();
    await expect(new GoogleSheetsConnector().fetch(sheetSpec({ auth: 'ntlm' }), deps)).rejects.toThrow(
      /must be "oauth2" or "apikey"/,
    );
  });

  it('surfaces Sheets API errors honestly', async () => {
    const { deps } = fakeDeps({ body: JSON.stringify({ error: { message: 'The caller does not have permission' } }) });
    await expect(new GoogleSheetsConnector().fetch(sheetSpec(), deps)).rejects.toThrow(
      /Sheets API error: The caller does not have permission/,
    );
  });

  it('rejects non-JSON responses', async () => {
    const { deps } = fakeDeps({ body: '<html>not json</html>' });
    await expect(new GoogleSheetsConnector().fetch(sheetSpec(), deps)).rejects.toThrow(/not return valid JSON/);
  });

  it('validates the spec (spreadsheetId + range required)', () => {
    expect(validateConnectorSpec(sheetSpec()).ok).toBe(true);
    expect(validateConnectorSpec(sheetSpec({ range: '' })).ok).toBe(false);
    const noId = sheetSpec();
    delete noId.params['spreadsheetId'];
    expect(validateConnectorSpec(noId).ok).toBe(false);
  });
});
