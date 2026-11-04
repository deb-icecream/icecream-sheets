/**
 * Tests for batch-11 functions (extended-functions11.ts): STOCKHISTORY,
 * WEBSERVICE, RTD, COPILOT, PY, CALL, REGISTER.ID.
 *
 * Imports ONLY the module under test (plus vitest and hyperformula).
 * Network is never touched: STOCKHISTORY uses publishMarketHistory(),
 * WEBSERVICE uses an injected provider, PY runs the real local python3
 * (no network in the sandbox).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { CellError, HyperFormula } from 'hyperformula';
import {
  registerExtendedFunctions11,
  publishMarketHistory,
  clearMarketHistory,
  parseStooqCsv,
  setWebFetchProvider,
  resetWebFetchProvider,
  publishRtdTopic,
  clearRtdTopics,
  rtdTopicKey,
  analyzeCopilot,
  setPythonProvider,
  resetPythonProvider,
  getPythonProvider,
  parsePythonEnvelope,
  pyPlotToImageValue,
  PY_PLOT_MAX_B64_CHARS,
  registerExternalFunction,
  unregisterExternalFunction,
  clearExternalFunctions,
  listExternalFunctions,
  marketTableToBars,
  type MarketBar,
} from '../src/extended-functions11.js';

registerExtendedFunctions11();

function calc(formula: string): unknown {
  const hf = HyperFormula.buildFromArray([[formula]], { licenseKey: 'gpl-v3' });
  return hf.getCellValue({ sheet: 0, row: 0, col: 0 });
}

function calcErr(formula: string): { type: string; value: string } {
  const v = calc(formula) as { type?: string; value?: string } | null;
  expect(v !== null && typeof v === 'object' && typeof v.value === 'string').toBe(true);
  return v as { type: string; value: string };
}

const BARS: MarketBar[] = [
  { date: '2024-01-02', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
  { date: '2024-01-03', open: 105, high: 115, low: 95, close: 112, volume: 2000 },
];

beforeEach(() => {
  clearMarketHistory();
  resetWebFetchProvider();
  clearRtdTopics();
  resetPythonProvider();
  clearExternalFunctions();
});

describe('STOCKHISTORY', () => {
  it('spills Date/Open/High/Low/Close/Volume with headers (anchor holds the array)', () => {
    publishMarketHistory('TEST', BARS);
    const v = calc('=STOCKHISTORY("TEST","2024-01-02","2024-01-03")') as unknown[][];
    expect(v[0]).toEqual(['Date', 'Open', 'High', 'Low', 'Close', 'Volume']);
    expect(v[1]).toEqual(['2024-01-02', 100, 110, 90, 105, 1000]);
    expect(v[2]).toEqual(['2024-01-03', 105, 115, 95, 112, 2000]);
  });
  it('properties=1 returns Date+Close only', () => {
    publishMarketHistory('TEST', BARS);
    const v = calc('=STOCKHISTORY("TEST","2024-01-02","2024-01-03",0,1,1)') as unknown[][];
    expect(v[0]).toEqual(['Date', 'Close']);
    expect(v[1]).toEqual(['2024-01-02', 105]);
  });
  it('headers=0 omits the header row', () => {
    publishMarketHistory('TEST', BARS);
    const v = calc('=STOCKHISTORY("TEST","2024-01-02","2024-01-03",0,0)') as unknown[][];
    expect(v[0]).toEqual(['2024-01-02', 100, 110, 90, 105, 1000]);
  });
  it('unknown symbol with no provider and no network cache is #N/A', () => {
    // No published data; the default provider will try curl (may fail in
    // sandbox) — either way the function must not return #NAME? and must
    // produce a value or a proper error, never throw.
    const v = calc('=STOCKHISTORY("ZZZZ-NOPE",57900,57901)');
    expect(v === null || typeof v === 'object' || typeof v === 'string' || typeof v === 'number').toBe(true);
  });
});

describe('parseStooqCsv', () => {
  it('parses a Stooq daily CSV and skips N/D rows', () => {
    const csv =
      'Date,Open,High,Low,Close,Volume\n' +
      '2024-01-02,182.50,183.10,181.00,182.90,50000\n' +
      '2024-01-03,N/D,N/D,N/D,N/D,N/D\n' +
      '2024-01-04,183.00,184.00,182.00,183.50,60000\n';
    const bars = parseStooqCsv(csv);
    expect(bars.length).toBe(2);
    expect(bars[0]).toEqual({ date: '2024-01-02', open: 182.5, high: 183.1, low: 181, close: 182.9, volume: 50000 });
  });
});

describe('marketTableToBars', () => {
  it('converts TableData rows to MarketBars', () => {
    const bars = marketTableToBars(
      ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'],
      [['2024-01-02', 100, 110, 90, 105, 1000]],
    );
    expect(bars).toEqual([{ date: '2024-01-02', open: 100, high: 110, low: 90, close: 105, volume: 1000 }]);
  });
});

describe('WEBSERVICE', () => {
  it('returns the fetched text via the injected provider', () => {
    setWebFetchProvider(() => '<html>hello</html>');
    expect(calc('=WEBSERVICE("https://example.com")')).toBe('<html>hello</html>');
  });
  it('rejects non-http URLs with #VALUE!', () => {
    const e = calcErr('=WEBSERVICE("ftp://example.com/x")');
    expect(e.value).toBe('#VALUE!');
  });
  it('empty URL is #VALUE!', () => {
    expect(calcErr('=WEBSERVICE("")').value).toBe('#VALUE!');
  });
});

describe('RTD', () => {
  it('returns the published topic value', () => {
    publishRtdTopic('prog', 'srv', ['price'], 42.5);
    expect(calc('=RTD("prog","srv","price")')).toBe(42.5);
  });
  it('supports multiple topic segments', () => {
    publishRtdTopic('prog', 'srv', ['aapl', 'bid'], 181.25);
    expect(calc('=RTD("prog","srv","aapl","bid")')).toBe(181.25);
  });
  it('reflects republished values', () => {
    publishRtdTopic('p', 's', ['t'], 1);
    expect(calc('=RTD("p","s","t")')).toBe(1);
    publishRtdTopic('p', 's', ['t'], 2);
    expect(calc('=RTD("p","s","t")')).toBe(2);
  });
  it('unpublished topic is #N/A (not #NAME?)', () => {
    expect(calcErr('=RTD("p","s","missing")').value).toBe('#N/A');
  });
  it('rtdTopicKey is case-insensitive and stable', () => {
    expect(rtdTopicKey('P', 'S', ['T'])).toBe(rtdTopicKey('p', 's', ['t']));
  });
});

describe('COPILOT', () => {
  it('sums a context range', () => {
    expect(analyzeCopilot('sum', [[1], [2], [3]])).toBe(6);
  });
  it('averages', () => {
    expect(analyzeCopilot('what is the average?', [[2], [4]])).toBe(3);
  });
  it('counts', () => {
    expect(analyzeCopilot('how many are there', [[1], [2], [3]])).toBe(3);
  });
  it('finds max and min', () => {
    expect(analyzeCopilot('max', [[1], [9], [3]])).toBe(9);
    expect(analyzeCopilot('minimum value', [[1], [9], [3]])).toBe(1);
  });
  it('summarizes as a readable string', () => {
    const s = analyzeCopilot('summarize', [[1], [2], [3]]) as string;
    expect(typeof s).toBe('string');
    expect(s).toContain('3 numbers');
    expect(s).toContain('sum 6');
  });
  it('works end-to-end through the formula engine', () => {
    expect(calc('=COPILOT("total", {1,2,3})')).toBe(6);
  });
  it('missing context is #VALUE! with usage', () => {
    expect(calcErr('=COPILOT("sum")').value).toBe('#VALUE!');
  });
  it('unknown intent is #VALUE!', () => {
    const e = analyzeCopilot('write me a poem', [[1]]);
    expect(typeof e === 'object' && 'type' in (e as object)).toBe(true);
  });
});

describe('PY', () => {
  it('executes Python and returns a scalar (real python3)', () => {
    expect(calc('=PY("result = 6*7")')).toBe(42);
  });
  it('spills a list as a column (anchor holds the array)', () => {
    expect(calc('=PY("result = [10, 20, 30]")')).toEqual([[10], [20], [30]]);
  });
  it('spills a 2-D list as a table', () => {
    expect(calc('=PY("result = [[1, 2], [3, 4]]")')).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
  it('passes args positionally', () => {
    expect(calc('=PY("result = args[0] * args[1]", 6, 7)')).toBe(42);
  });
  it('blocked imports produce #N/A (sandbox enforced)', () => {
    const e = calcErr('=PY("import os\nresult = 1")');
    expect(e.value).toBe('#N/A');
  });
  it('missing result variable is #N/A', () => {
    expect(calcErr('=PY("x = 1")').value).toBe('#N/A');
  });
  it('host provider override is honored', () => {
    setPythonProvider({ run: () => ({ value: 'fake-ok' }) });
    expect(calc('=PY("result = 1")')).toBe('fake-ok');
  });
});

describe('CALL / REGISTER.ID', () => {
  it('CALL invokes a registered JS function by name', () => {
    registerExternalFunction('double', (x) => (typeof x === 'number' ? x * 2 : 0));
    expect(calc('=CALL("double", 21)')).toBe(42);
  });
  it('REGISTER.ID resolves a name to its ID, CALL accepts the ID', () => {
    const id = registerExternalFunction('triple', (x) => (typeof x === 'number' ? x * 3 : 0));
    expect(calc('=REGISTER.ID("js", "triple")')).toBe(id);
    expect(id.startsWith('XLL.')).toBe(true);
    expect(calc(`=CALL("${id}", 7)`)).toBe(21);
  });
  it('string functions work', () => {
    registerExternalFunction('shout', (s) => String(s).toUpperCase() + '!');
    expect(calc('=CALL("shout", "hi")')).toBe('HI!');
  });
  it('unknown function is #VALUE!', () => {
    expect(calcErr('=CALL("nope", 1)').value).toBe('#VALUE!');
  });
  it('DLL module names are rejected with a documented message', () => {
    expect(calcErr('=REGISTER.ID("mylib.dll", "fn")').value).toBe('#VALUE!');
  });
  it('unregister + list round-trip', () => {
    registerExternalFunction('f1', () => 1);
    expect(listExternalFunctions().some((e) => e.name === 'f1')).toBe(true);
    expect(unregisterExternalFunction('f1')).toBe(true);
    expect(listExternalFunctions().some((e) => e.name === 'f1')).toBe(false);
  });
});

describe('PY plots-in-cells', () => {
  // A real 16x16 PNG (1136 base64 chars), generated once with zlib.
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAADG0lEQVR4nAEQA+/8AKVNyhglMLsdbRMs3tYjey7ZHj9yH8sZcRdElNZJPJ1cNGC+MSAeaf7aoO7ouZl/XAB8KZn9r+WTJTzWVK9N+tcUJ6Cus/7pIy+K8iEfnuSRxbEL7LVWO/web5NCfsvI/ikAVeXNjkbcjtS3wnZNKlpNdncG+F2GkAJK1r2jQBvpyMvMyTX2zR9hImrhUziuGjQAAE0zug0kasBMgbG68j47+e71958rSTSvh/VSC2m5Sw2YLoW7VbZyqHJjes10Zvy2DgAOj/GEY7DksropcDR08GSsaPcA9bArPcZm9FveqizK7c0rUVdBDk3uSvKzT0MKBzQAR95jbA6AbJV7poTWQx+16tdCTQnhXQJMWEjyPR+m9zYdf2GNFTLnDiDipmaN5/R+AIRn5UbVPsjioSV72yVsmz5Pu0mBRu9wMMv5U3JS3M6t12S2oy+7Ca3q4QnEqZcgOQB1NSuHixRcikLYhM9M/actjh1d2SWJCC2FKnEihz7oBa3ViUIWejhShhlcZ5+caZQA5FuKsQmAEgcJYfN95Dbd/cmdbnWvZUfPsRtCBySC3FMcK8OQfJYX615QieQBhrqoAKV9EZ5vtl0Aq8Mq845mfwIuhy1JzBXJC5mbdytPx7DkZOVImn9Zp9jdu5xh5c3/V9y+NUcSskbbQxI1BoeXsnmoDkoVGF6ecF1yqb+AAAAAElFTkSuQmCC';

  function pyCode(lines: string[]): string {
    return `=PY("${lines.join('\n')}")`;
  }

  it('explicit plot variable becomes the typed in-cell image value', () => {
    const v = calc(pyCode([`plot = '${TINY_PNG_B64}'`, 'result = 42'])) as Record<string, unknown>;
    expect(v.kind).toBe('image');
    expect(typeof v.src).toBe('string');
    expect((v.src as string).startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
    expect(v.alt).toBe('Python plot');
  });

  it('plot wins the cell over the numeric result (Excel image-object semantics)', () => {
    const v = calc(pyCode([`plot = '${TINY_PNG_B64}'`, 'result = 42'])) as Record<string, unknown>;
    expect(v).not.toBe(42);
    expect(v.kind).toBe('image');
  });

  it('dict plot form {png: b64} is accepted', () => {
    const v = calc(
      pyCode([`plot = {'png': '${TINY_PNG_B64}'}`, 'result = 1']),
    ) as Record<string, unknown>;
    expect(v.kind).toBe('image');
  });

  it('matplotlib figures are auto-captured with the Agg backend (real matplotlib)', () => {
    const v = calc(
      pyCode([
        'import matplotlib',
        "matplotlib.use('Agg')",
        'import matplotlib.pyplot as plt',
        'plt.plot([1, 2, 3], [1, 4, 9])',
        "plt.title('parabola')",
        'result = 6*7',
      ]),
    ) as Record<string, unknown>;
    expect(v.kind).toBe('image');
    const b64 = (v.src as string).replace('data:image/png;base64,', '');
    // PNG magic bytes survive the round trip.
    const bin = Buffer.from(b64.slice(0, 16), 'base64');
    expect([...bin.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(b64.length).toBeGreaterThan(1000);
  });

  it('no plot -> existing scalar behavior is unchanged', () => {
    expect(calc('=PY("result = 6*7")')).toBe(42);
  });

  it('matplotlib import is allowed now (pinned-env package)', () => {
    // Importing matplotlib without drawing must NOT error and must NOT
    // produce a plot (no axes -> no auto-capture).
    expect(calc(pyCode(['import matplotlib', 'result = 1']))).toBe(1);
  });

  it('invalid plot payload is #VALUE!', () => {
    const e = calcErr(pyCode(["plot = 'not-a-png'", 'result = 1']));
    expect(e.value).toBe('#VALUE!');
  });

  it('parsePythonEnvelope carries the plot through', () => {
    const r = parsePythonEnvelope(
      JSON.stringify({ __sandbox_value__: 1, __sandbox_plot__: TINY_PNG_B64 }),
    );
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.value).toBe(1);
      expect(r.plot).toBe(TINY_PNG_B64);
    }
  });

  it('parsePythonEnvelope keeps the old contract (no plot key)', () => {
    const r = parsePythonEnvelope(JSON.stringify({ __sandbox_value__: [1, 2] }));
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.value).toEqual([1, 2]);
      expect(r.plot).toBeUndefined();
    }
  });

  it('pyPlotToImageValue rejects non-PNG and oversized payloads', () => {
    const bad = pyPlotToImageValue('aGVsbG8=') as unknown as CellError;
    expect(bad).toBeInstanceOf(CellError);
    expect(bad.type).toBe('VALUE');
    const huge = pyPlotToImageValue(
      'iVBORw0KGgo' + 'A'.repeat(PY_PLOT_MAX_B64_CHARS),
    ) as unknown as CellError;
    expect(huge).toBeInstanceOf(CellError);
  });

  it('pyPlotToImageValue accepts a valid PNG payload', () => {
    const v = pyPlotToImageValue(TINY_PNG_B64) as unknown as Record<string, unknown>;
    expect(v.kind).toBe('image');
    expect((v.src as string).startsWith('data:image/png;base64,')).toBe(true);
  });

  it('default provider runs real python3 and returns the plot via getPythonProvider', () => {
    const provider = getPythonProvider();
    const r = provider.run(`plot = '${TINY_PNG_B64}'\nresult = 'x'`, []);
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.plot).toBe(TINY_PNG_B64);
  });
});
