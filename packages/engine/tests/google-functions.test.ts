/**
 * Tests for IMPORTRANGE and GOOGLEFINANCE (src/google-functions.ts).
 * No network: Sheets API calls go through the mocked WebFetchProvider seam
 * (setWebFetchProvider), and GOOGLEFINANCE uses a fake market-data provider
 * or the published cache.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { HyperFormula } from 'hyperformula';
import { setWebFetchProvider, resetWebFetchProvider } from '../src/extended-functions11.js';
import {
  clearMarketHistory,
  publishMarketHistory,
  resetMarketDataProvider,
  setMarketDataProvider,
  type MarketBar,
  type MarketDataProvider,
} from '../src/extended-functions11.js';
import {
  registerGoogleFunctions,
  publishImportRangeData,
  clearImportRangeData,
  parseSpreadsheetId,
  setGoogleApiCredential,
} from '../src/google-functions.js';

registerGoogleFunctions();

const SHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

function calc(formula: string): unknown {
  const hf = HyperFormula.buildFromArray([[formula]], { licenseKey: 'gpl-v3' });
  return hf.getCellValue({ sheet: 0, row: 0, col: 0 });
}

function calcErrType(formula: string): string {
  const v = calc(formula) as { type?: string; value?: string } | null;
  expect(v !== null && typeof v === 'object' && typeof v.type === 'string').toBe(true);
  return (v as { type: string }).type;
}

const SHEETS_JSON = JSON.stringify({
  range: 'Sheet1!A1:B2',
  majorDimension: 'ROWS',
  values: [
    ['Name', 'Score'],
    ['Alice', 10],
    ['Bob', 20],
  ],
});

const BARS: MarketBar[] = [
  { date: '2024-01-02', open: 100, high: 105, low: 99, close: 104, volume: 1000 },
  { date: '2024-01-03', open: 104, high: 108, low: 103, close: 107, volume: 2000 },
  { date: '2024-01-04', open: 107, high: 110, low: 106, close: 109, volume: 3000 },
];

const fakeMarketProvider: MarketDataProvider = {
  getHistory: () => BARS,
};

beforeEach(() => {
  resetWebFetchProvider();
  resetMarketDataProvider();
  clearMarketHistory();
  clearImportRangeData();
  setGoogleApiCredential(null);
  setWebFetchProvider((url: string) => {
    if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')) return SHEETS_JSON;
    throw new Error(`unexpected fetch ${url}`);
  });
});

// ---------------------------------------------------------------------------
// parseSpreadsheetId
// ---------------------------------------------------------------------------

describe('parseSpreadsheetId', () => {
  it('extracts the id from a Google Sheets URL', () => {
    expect(
      parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit'),
    ).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
  });

  it('accepts a bare spreadsheet id', () => {
    expect(parseSpreadsheetId('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms')).toBe(
      '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
    );
  });

  it('rejects garbage', () => {
    expect(() => parseSpreadsheetId('not a url')).toThrow('not a Google Sheets URL');
    expect(() => parseSpreadsheetId('')).toThrow('requires a spreadsheet URL');
  });
});

// ---------------------------------------------------------------------------
// IMPORTRANGE
// ---------------------------------------------------------------------------

describe('IMPORTRANGE', () => {
  const URL = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';

  it('reads published cache data without a credential', () => {
    publishImportRangeData(SHEET_ID, 'Sheet1!A1:B2', [
      ['x', 1],
      ['y', 2],
    ]);
    const v = calc(`=IMPORTRANGE("${SHEET_ID}", "Sheet1!A1:B2")`) as unknown[][];
    expect(v).toEqual([
      ['x', 1],
      ['y', 2],
    ]);
  });

  it('fetches through the Sheets API with an API key', () => {
    setGoogleApiCredential({ apiKey: 'KEY-123' });
    let seen = '';
    setWebFetchProvider((url: string) => {
      seen = url;
      return SHEETS_JSON;
    });
    const v = calc(`=IMPORTRANGE("${URL}", "Sheet1!A1:B2")`) as unknown[][];
    expect(v).toEqual([
      ['Name', 'Score'],
      ['Alice', 10],
      ['Bob', 20],
    ]);
    expect(seen).toContain('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
    expect(seen).toContain('/values/Sheet1!A1%3AB2');
    expect(seen).toContain('key=KEY-123');
  });

  it('sends the OAuth2 token as access_token when no API key is set', () => {
    setGoogleApiCredential({ accessToken: 'ya29.token' });
    let seen = '';
    setWebFetchProvider((url: string) => {
      seen = url;
      return SHEETS_JSON;
    });
    calc(`=IMPORTRANGE("${URL}", "Sheet1!A1:B2")`);
    expect(seen).toContain('access_token=ya29.token');
  });

  it('returns #N/A when there is no credential and no cache', () => {
    const err = calcErrType(`=IMPORTRANGE("${SHEET_ID}", "Sheet1!A1:B2")`);
    expect(err).toBe('NA');
  });

  it('returns #VALUE! for a bad URL', () => {
    const err = calcErrType('=IMPORTRANGE("https://example.com/x", "A1:B2")');
    expect(err).toBe('VALUE');
  });

  it('returns #VALUE! for a missing range', () => {
    const err = calcErrType(`=IMPORTRANGE("${SHEET_ID}", "")`);
    expect(err).toBe('VALUE');
  });

  it('surfaces Sheets API errors as #N/A', () => {
    setGoogleApiCredential({ apiKey: 'K' });
    setWebFetchProvider(() => JSON.stringify({ error: { message: 'The caller does not have permission' } }));
    const err = calcErrType(`=IMPORTRANGE("${URL}", "Sheet1!A1:B2")`);
    expect(err).toBe('NA');
  });
});

// ---------------------------------------------------------------------------
// GOOGLEFINANCE
// ---------------------------------------------------------------------------

describe('GOOGLEFINANCE', () => {
  it('returns the latest close for the default "price" attribute', () => {
    setMarketDataProvider(fakeMarketProvider);
    expect(calc('=GOOGLEFINANCE("TEST")')).toBe(109);
    expect(calc('=GOOGLEFINANCE("TEST", "price")')).toBe(109);
  });

  it('supports OHLCV attributes', () => {
    setMarketDataProvider(fakeMarketProvider);
    expect(calc('=GOOGLEFINANCE("TEST", "open")')).toBe(107);
    expect(calc('=GOOGLEFINANCE("TEST", "high")')).toBe(110);
    expect(calc('=GOOGLEFINANCE("TEST", "low")')).toBe(106);
    expect(calc('=GOOGLEFINANCE("TEST", "volume")')).toBe(3000);
  });

  it('computes derived attributes from the bars', () => {
    setMarketDataProvider(fakeMarketProvider);
    expect(calc('=GOOGLEFINANCE("TEST", "previousclose")')).toBe(107);
    expect(calc('=GOOGLEFINANCE("TEST", "changepct")')).toBeCloseTo(((109 - 107) / 107) * 100, 10);
    expect(calc('=GOOGLEFINANCE("TEST", "volumeavg")')).toBe(2000);
    expect(calc('=GOOGLEFINANCE("TEST", "high52")')).toBe(110);
    expect(calc('=GOOGLEFINANCE("TEST", "low52")')).toBe(99);
  });

  it('"close" is not a Google attribute name -> honest #N/A', () => {
    setMarketDataProvider(fakeMarketProvider);
    const err = calcErrType('=GOOGLEFINANCE("TEST", "close", "2024-01-02", "2024-01-04")');
    expect(err).toBe('NA');
  });

  it('historical mode with a supported attribute returns the date table', () => {
    setMarketDataProvider(fakeMarketProvider);
    const v = calc('=GOOGLEFINANCE("TEST", "price", "2024-01-02", "2024-01-04")') as unknown[][];
    expect(v).toEqual([
      ['2024-01-02', 104],
      ['2024-01-03', 107],
      ['2024-01-04', 109],
    ]);
  });

  it('rejects attributes not backed by OHLCV data with #N/A', () => {
    setMarketDataProvider(fakeMarketProvider);
    const err = calcErrType('=GOOGLEFINANCE("TEST", "pe")');
    expect(err).toBe('NA');
  });

  it('rejects a bad interval', () => {
    setMarketDataProvider(fakeMarketProvider);
    const err = calcErrType('=GOOGLEFINANCE("TEST", "price", "2024-01-02", "2024-01-04", "HOURLY")');
    expect(err).toBe('VALUE');
  });

  it('requires a ticker', () => {
    const err = calcErrType('=GOOGLEFINANCE("")');
    expect(err).toBe('VALUE');
  });

  it('reads published market history like STOCKHISTORY', () => {
    publishMarketHistory('PUB', BARS);
    expect(calc('=GOOGLEFINANCE("PUB", "price", "2024-01-02", "2024-01-04")')).toEqual([
      ['2024-01-02', 104],
      ['2024-01-03', 107],
      ['2024-01-04', 109],
    ]);
  });

  it('returns #N/A when the provider has no data', () => {
    setMarketDataProvider({ getHistory: () => [] });
    const err = calcErrType('=GOOGLEFINANCE("EMPTY")');
    expect(err).toBe('NA');
  });
});
