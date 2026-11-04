/**
 * Tests for the IMPORTDATA / IMPORTFEED / IMPORTHTML / IMPORTXML family
 * (src/import-functions.ts). Network is never touched: all fetches go
 * through the mocked WebFetchProvider seam (setWebFetchProvider).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { CellError, EmptyValue, HyperFormula } from 'hyperformula';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { setWebFetchProvider, resetWebFetchProvider } from '../src/extended-functions11.js';
import { registerLocales } from '../src/localization.js';
import {
  registerImportFunctions,
  importDataValues,
  importFeedValues,
  importHtmlValues,
  importXmlValues,
  parseFeed,
  spillImportData,
  spillImportFeed,
  spillImportHtml,
  spillImportXml,
} from '../src/import-functions.js';

registerImportFunctions();
registerLocales(); // registers the enUS language pack for the locale test

const CSV = 'name,age,active\nAlice,30,TRUE\nBob,25,FALSE\n';
const TSV = 'name\tage\nAlice\t30\nBob\t25\n';
const SEMI = 'name;age\nAlice;30\n';
const QUOTED = 'a,b\n"x, y",1\n"multi\nline",2\n';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Test Blog</title><link>https://example.com</link><description>A blog</description>
<item><title>First post</title><link>https://example.com/1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><author>ann@example.com</author></item>
<item><title>Second post</title><link>https://example.com/2</link><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Feed</title><link href="https://example.org/"/>
<entry><title>Entry one</title><link href="https://example.org/e1"/><published>2024-03-01T00:00:00Z</published><author><name>Bob</name></author></entry>
<entry><title>Entry two</title><link href="https://example.org/e2"/><updated>2024-03-02T00:00:00Z</updated></entry>
</feed>`;

const HTML = `<html><body>
<table><tr><th>Name</th><th>Score</th></tr><tr><td>Alice &amp; Co</td><td><b>10</b></td></tr></table>
<table><tr><td>only</td></tr></table>
<ul><li>alpha</li><li>beta</li></ul>
<ol><li>one</li></ol>
</body></html>`;

const XMLDOC = `<root><item>a</item><item>b</item><item>c</item></root>`;

const FIXTURES: Record<string, string> = {
  'https://x.test/data.csv': CSV,
  'https://x.test/data.tsv': TSV,
  'https://x.test/data.semi': SEMI,
  'https://x.test/quoted.csv': QUOTED,
  'https://x.test/feed.rss': RSS,
  'https://x.test/feed.atom': ATOM,
  'https://x.test/page.html': HTML,
  'https://x.test/doc.xml': XMLDOC,
};

function calc(formula: string, language = 'enGB'): unknown {
  const hf = HyperFormula.buildFromArray([[formula]], { licenseKey: 'gpl-v3', language });
  return hf.getCellValue({ sheet: 0, row: 0, col: 0 });
}

function calcErr(formula: string): { type: string; value: string } {
  // getCellValue wraps errors as DetailedCellError; duck-type like the
  // batch-11 tests rather than instanceof CellError.
  const v = calc(formula) as { type?: string; value?: string } | null;
  expect(v !== null && typeof v === 'object' && typeof v.value === 'string').toBe(true);
  return v as { type: string; value: string };
}

beforeEach(() => {
  resetWebFetchProvider();
  setWebFetchProvider((url: string) => {
    const f = FIXTURES[url];
    if (f === undefined) throw new Error(`fetch failed for "${url}" (404)`);
    return f;
  });
});

// ---------------------------------------------------------------------------
// IMPORTDATA
// ---------------------------------------------------------------------------

describe('IMPORTDATA', () => {
  it('parses CSV and coerces numbers/booleans', () => {
    const v = calc('=IMPORTDATA("https://x.test/data.csv")') as unknown[][];
    expect(v[0]).toEqual(['name', 'age', 'active']);
    expect(v[1]).toEqual(['Alice', 30, true]);
    expect(v[2]).toEqual(['Bob', 25, false]);
  });

  it('auto-detects tab and semicolon delimiters', () => {
    const t = calc('=IMPORTDATA("https://x.test/data.tsv")') as unknown[][];
    expect(t[1]).toEqual(['Alice', 30]);
    const s = calc('=IMPORTDATA("https://x.test/data.semi")') as unknown[][];
    expect(s[1]).toEqual(['Alice', 30]);
  });

  it('honors quoted fields containing commas and newlines', () => {
    const v = calc('=IMPORTDATA("https://x.test/quoted.csv")') as unknown[][];
    expect(v[1]).toEqual(['x, y', 1]);
    expect(v[2]).toEqual(['multi\nline', 2]);
  });

  it('accepts an explicit delimiter (char and name forms)', () => {
    const v = calc('=IMPORTDATA("https://x.test/data.semi",";")') as unknown[][];
    expect(v[1]).toEqual(['Alice', 30]);
    const w = calc('=IMPORTDATA("https://x.test/data.semi","semicolon")') as unknown[][];
    expect(w[1]).toEqual(['Alice', 30]);
  });

  it('pads ragged rows with blanks', () => {
    setWebFetchProvider(() => 'a,b,c\n1,2\n');
    const v = calc('=IMPORTDATA("https://x.test/ragged.csv")') as unknown[][];
    expect(v[1]![2]).toBe(EmptyValue);
  });

  it('empty URL is #VALUE!', () => {
    expect(calcErr('=IMPORTDATA("")').type).toBe('VALUE');
  });

  it('fetch failure is #VALUE!, not a throw', () => {
    expect(calcErr('=IMPORTDATA("https://x.test/missing.csv")').type).toBe('VALUE');
  });

  it('unsupported delimiter is #VALUE!', () => {
    expect(calcErr('=IMPORTDATA("https://x.test/data.csv","~")').type).toBe('VALUE');
  });

  it('importDataValues returns the grid directly for hosts', () => {
    const r = importDataValues('https://x.test/data.csv');
    expect(r).not.toBeInstanceOf(CellError);
    expect((r as unknown[][])[2]).toEqual(['Bob', 25, false]);
  });
});

// ---------------------------------------------------------------------------
// IMPORTFEED
// ---------------------------------------------------------------------------

describe('IMPORTFEED', () => {
  it('spills RSS items with Title/Link/Date headers by default', () => {
    const v = calc('=IMPORTFEED("https://x.test/feed.rss")') as unknown[][];
    expect(v[0]).toEqual(['Title', 'Link', 'Date']);
    expect(v[1]).toEqual(['First post', 'https://example.com/1', 'Mon, 01 Jan 2024 00:00:00 GMT']);
    expect(v[2]![0]).toBe('Second post');
  });

  it('parses Atom feeds (href links, published/updated dates)', () => {
    const v = calc('=IMPORTFEED("https://x.test/feed.atom")') as unknown[][];
    expect(v[0]).toEqual(['Title', 'Link', 'Date']);
    expect(v[1]).toEqual(['Entry one', 'https://example.org/e1', '2024-03-01T00:00:00Z']);
    expect(v[2]![2]).toBe('2024-03-02T00:00:00Z');
  });

  it('query selects fields; "no headers" drops the header row', () => {
    const v = calc('=IMPORTFEED("https://x.test/feed.rss","items title, no headers")') as unknown[][];
    expect(v[0]).toEqual(['First post']);
    expect(v[1]).toEqual(['Second post']);
  });

  it('query "feed title" returns the feed title', () => {
    const v = calc('=IMPORTFEED("https://x.test/feed.rss","feed title")') as unknown[][];
    expect(v).toEqual([['Title'], ['Test Blog']]);
  });

  it('headers=0 omits headers; num_items caps rows', () => {
    const v = calc('=IMPORTFEED("https://x.test/feed.rss","items title",0,1)') as unknown[][];
    expect(v).toEqual([['First post']]);
  });

  it('author field resolves', () => {
    const v = calc('=IMPORTFEED("https://x.test/feed.rss","items title author",0)') as unknown[][];
    expect(v[0]).toEqual(['First post', 'ann@example.com']);
  });

  it('invalid XML is #VALUE!', () => {
    setWebFetchProvider(() => 'not <xml at all');
    expect(calcErr('=IMPORTFEED("https://x.test/bad.xml")').type).toBe('VALUE');
  });

  it('empty feed is #N/A', () => {
    setWebFetchProvider(() => '<rss><channel><title>x</title></channel></rss>');
    expect(calcErr('=IMPORTFEED("https://x.test/empty.rss")').type).toBe('NA');
  });

  it('parseFeed extracts feed metadata', () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe('Test Blog');
    expect(feed.link).toBe('https://example.com');
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]!.author).toBe('ann@example.com');
  });

  it('importFeedValues returns the table directly for hosts', () => {
    const r = importFeedValues('https://x.test/feed.atom', 'items title link', 1, 1);
    expect(r).not.toBeInstanceOf(CellError);
    expect(r as unknown[][]).toEqual([['Title', 'Link'], ['Entry one', 'https://example.org/e1']]);
  });
});

// ---------------------------------------------------------------------------
// IMPORTHTML
// ---------------------------------------------------------------------------

describe('IMPORTHTML', () => {
  it('extracts table #1, decoding entities and stripping tags', () => {
    const v = calc('=IMPORTHTML("https://x.test/page.html","table",1)') as unknown[][];
    expect(v[0]).toEqual(['Name', 'Score']);
    expect(v[1]).toEqual(['Alice & Co', '10']);
  });

  it('extracts table #2 by index', () => {
    const v = calc('=IMPORTHTML("https://x.test/page.html","table",2)') as unknown[][];
    expect(v).toEqual([['only']]);
  });

  it('out-of-range index is #N/A', () => {
    expect(calcErr('=IMPORTHTML("https://x.test/page.html","table",9)').type).toBe('NA');
  });

  it('extracts lists as a single column', () => {
    const v = calc('=IMPORTHTML("https://x.test/page.html","list",1)') as unknown[][];
    expect(v).toEqual([['alpha'], ['beta']]);
    const w = calc('=IMPORTHTML("https://x.test/page.html","list",2)') as unknown[][];
    expect(w).toEqual([['one']]);
  });

  it('bad query is #VALUE!', () => {
    expect(calcErr('=IMPORTHTML("https://x.test/page.html","div",1)').type).toBe('VALUE');
  });

  it('non-positive index is #VALUE!', () => {
    expect(calcErr('=IMPORTHTML("https://x.test/page.html","table",0)').type).toBe('VALUE');
  });

  it('importHtmlValues returns the table directly for hosts', () => {
    const r = importHtmlValues('https://x.test/page.html', 'table', 1);
    expect(r).not.toBeInstanceOf(CellError);
    expect((r as unknown[][])[1]).toEqual(['Alice & Co', '10']);
  });
});

// ---------------------------------------------------------------------------
// IMPORTXML
// ---------------------------------------------------------------------------

describe('IMPORTXML', () => {
  it('spills matched node values as a column via the FILTERXML XPath subset', () => {
    const v = calc('=IMPORTXML("https://x.test/doc.xml","//item")') as unknown[][];
    expect(v).toEqual([['a'], ['b'], ['c']]);
  });

  it('supports attribute steps', () => {
    setWebFetchProvider(() => '<r><e id="x1"/><e id="x2"/></r>');
    const v = calc('=IMPORTXML("https://x.test/attrs.xml","//e/@id")') as unknown[][];
    expect(v).toEqual([['x1'], ['x2']]);
  });

  it('no match is #N/A', () => {
    expect(calcErr('=IMPORTXML("https://x.test/doc.xml","//nope")').type).toBe('NA');
  });

  it('bad XPath is #VALUE!', () => {
    expect(calcErr('=IMPORTXML("https://x.test/doc.xml","///[bad")').type).toBe('VALUE');
  });

  it('empty XPath is #VALUE!', () => {
    expect(calcErr('=IMPORTXML("https://x.test/doc.xml","")').type).toBe('VALUE');
  });

  it('importXmlValues returns the column directly for hosts', () => {
    const r = importXmlValues('https://x.test/doc.xml', '/root/item');
    expect(r as unknown[][]).toEqual([['a'], ['b'], ['c']]);
  });
});

// ---------------------------------------------------------------------------
// Spill wrappers (dynamic-arrays spill(): anchor keeps formula, #SPILL!)
// ---------------------------------------------------------------------------

describe('host spill paths', () => {
  function host() {
    const cells = new Map<string, InterpreterValue>();
    const key = (r: number, c: number): string => `${r},${c}`;
    return {
      cells,
      setCell: (r: number, c: number, v: InterpreterValue): void => { cells.set(key(r, c), v); },
      getCell: (r: number, c: number): InterpreterValue | undefined => cells.get(key(r, c)),
    };
  }

  it('spillImportData writes the grid, skipping the anchor cell', () => {
    const h = host();
    const r = spillImportData(0, 0, 'https://x.test/data.csv', undefined, h.setCell, h.getCell);
    expect(r).toBe('ok');
    expect(h.cells.get('0,1')).toBe('age');
    expect(h.cells.get('1,0')).toBe('Alice');
    expect(h.cells.get('1,1')).toBe(30);
    expect(h.cells.has('0,0')).toBe(false); // anchor keeps the formula
  });

  it('spillImportData returns #SPILL! when the range is blocked', () => {
    const h = host();
    h.setCell(1, 1, 'occupied');
    const r = spillImportData(0, 0, 'https://x.test/data.csv', undefined, h.setCell, h.getCell);
    expect(r).toBeInstanceOf(CellError);
    expect((r as CellError).type).toBe('SPILL');
  });

  it('spillImportFeed writes the feed table', () => {
    const h = host();
    const r = spillImportFeed(2, 3, 'https://x.test/feed.rss', 'items title', 1, null, h.setCell, h.getCell);
    expect(r).toBe('ok');
    // Anchor (2,3) keeps the formula; header row is skipped with it.
    expect(h.cells.has('2,3')).toBe(false);
    expect(h.cells.get('3,3')).toBe('First post');
    expect(h.cells.get('4,3')).toBe('Second post');
  });

  it('spillImportHtml writes the table', () => {
    const h = host();
    const r = spillImportHtml(0, 0, 'https://x.test/page.html', 'table', 1, h.setCell, h.getCell);
    expect(r).toBe('ok');
    expect(h.cells.get('0,1')).toBe('Score');
    expect(h.cells.get('1,0')).toBe('Alice & Co');
  });

  it('spillImportXml writes the node column', () => {
    const h = host();
    const r = spillImportXml(0, 0, 'https://x.test/doc.xml', '//item', h.setCell, h.getCell);
    expect(r).toBe('ok');
    expect(h.cells.get('1,0')).toBe('b');
    expect(h.cells.get('2,0')).toBe('c');
  });

  it('spill wrappers propagate formula errors', () => {
    const h = host();
    const r = spillImportXml(0, 0, 'https://x.test/doc.xml', '//nope', h.setCell, h.getCell);
    expect(r).toBeInstanceOf(CellError);
    expect((r as CellError).type).toBe('NA');
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers all four functions with HyperFormula', () => {
    for (const name of ['IMPORTDATA', 'IMPORTFEED', 'IMPORTHTML', 'IMPORTXML']) {
      expect(HyperFormula.getFunctionPlugin(name)).toBeDefined();
    }
  });

  it('registerImportFunctions is idempotent', () => {
    expect(() => registerImportFunctions()).not.toThrow();
    expect(HyperFormula.getFunctionPlugin('IMPORTDATA')).toBeDefined();
  });

  it('works under the en-US locale', () => {
    const v = calc('=IMPORTDATA("https://x.test/data.csv")', 'enUS') as unknown[][];
    expect(v[1]).toEqual(['Alice', 30, true]);
  });
});
