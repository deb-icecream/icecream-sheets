/**
 * External link (xl/externalLinks) tests: parsing of real fixture files,
 * regeneration of the link parts on save, and end-to-end resolution of
 * [N]Sheet!Ref formulas through the engine's ICEEXTREF dispatcher.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { XlsxAdapter } from '../src/index.js';
import {
  EXTERNAL_LINKS_METADATA_KEY,
  buildExternalLinkXml,
  externalLinksFromMetadata,
  readExternalLinks,
  writeExternalLinks,
} from '../src/index.js';
import { EngineWorkbook, scalar } from '@icecream-sheets/engine';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
const fixture1 = 'closedxml-ExternalLinks-WorkbookWithExternalLink.xlsx';
const fixture2 = 'closedxml-xlsx-external-refs.xlsx';

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dir, name)));

describe('readExternalLinks', () => {
  it('parses the ClosedXML external-link fixture', () => {
    const links = readExternalLinks(read(fixture1));
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.index).toBe(1);
    expect(link.target).toBe('book1.xlsx');
    expect(link.targetMode).toBe('External');
    expect(link.sheets).toEqual(['Sheet1']);
    expect(link.cachedValues['Sheet1\x00A1']).toBe('hello world');
  });
  it('parses the multi-sheet external-refs fixture', () => {
    const links = readExternalLinks(read(fixture2));
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.index).toBe(1);
    expect(link.target).toBe('data.xlsx');
    expect(link.sheets).toEqual(['Sheet1', 'Sheet2', 'Sheet3']);
    expect(link.cachedValues['Sheet1\x00A1']).toBe('Name');
    expect(link.cachedValues['Sheet1\x00A2']).toBe('Andy');
    expect(link.cachedValues['Sheet1\x00A3']).toBe('Bruce');
    expect(link.cachedValues['Sheet1\x00A4']).toBe('Charlie');
  });
  it('returns [] for a workbook without external links', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(read(fixture1));
    // sanity: fixture1 HAS links; synthesize a no-link package instead
    void data;
    const wb = new XlsxAdapter();
    const bytes = wb.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    expect(readExternalLinks(bytes)).toEqual([]);
  });
});

describe('adapter read()', () => {
  it('stashes parsed links in WorkbookData metadata', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(read(fixture1));
    const links = externalLinksFromMetadata(data.metadata);
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toBe('book1.xlsx');
    expect(data.metadata[EXTERNAL_LINKS_METADATA_KEY]).toBeDefined();
  });
  it('keeps the [N] formula text intact', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(read(fixture1));
    const flat = data.sheets.flatMap((s) => s.rows.flat());
    expect(flat).toContain('=[1]Sheet1!$A$1');
  });
});

describe('writeExternalLinks', () => {
  it('regenerates the link parts, rels, content types, and workbook refs', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(read(fixture1));
    const bytes = adapter.write(data);
    const files = unzipSync(bytes);
    const xml = strFromU8(files['xl/externalLinks/externalLink1.xml']!);
    // The part references the file via r:id; the filename lives in the rels.
    expect(xml).toContain('<externalBook r:id="rId1">');
    expect(xml).toContain('<sheetName val="Sheet1"/>');
    expect(xml).toContain('hello world');
    const rels = strFromU8(files['xl/externalLinks/_rels/externalLink1.xml.rels']!);
    expect(rels).toContain('Target="book1.xlsx"');
    expect(rels).toContain('externalLinkPath');
    const ct = strFromU8(files['[Content_Types].xml']!);
    expect(ct).toContain('/xl/externalLinks/externalLink1.xml');
    expect(ct).toContain('externalLink+xml');
    const wbRels = strFromU8(files['xl/_rels/workbook.xml.rels']!);
    expect(wbRels).toContain('Target="externalLinks/externalLink1.xml"');
    const wbXml = strFromU8(files['xl/workbook.xml']!);
    expect(wbXml).toContain('<externalReferences>');
    expect(wbXml).toContain('<externalReference');
    // The [1] formula text survives the SheetJS rebuild.
    const sheetXml = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheetXml).toContain('[1]Sheet1!$A$1');
  });
  it('round-trips: written links re-parse identically', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(read(fixture2));
    const before = externalLinksFromMetadata(data.metadata);
    const reread = adapter.read(adapter.write(data));
    const after = externalLinksFromMetadata(reread.metadata);
    expect(after).toEqual(before);
  });
  it('leaves packages without links untouched', () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    const out = writeExternalLinks(bytes, []);
    expect(out).toBe(bytes);
    const files = unzipSync(out);
    expect(Object.keys(files).some((p) => p.includes('externalLink'))).toBe(false);
  });
});

describe('buildExternalLinkXml', () => {
  it('serializes numbers, booleans, strings, and error literals', () => {
    const xml = buildExternalLinkXml({
      index: 2,
      target: 'other.xlsx',
      sheets: ['Data'],
      cachedValues: {
        'Data\x00A1': 1.5,
        'Data\x00A2': 'text',
        'Data\x00A3': true,
        'Data\x00A4': '#DIV/0!',
      },
    });
    expect(xml).toContain('<externalBook r:id="rId1">');
    expect(xml).toContain('<sheetName val="Data"/>');
    expect(xml).toContain('<cell r="A1"><v>1.5</v></cell>');
    expect(xml).toContain('<cell r="A2" t="str"><v>text</v></cell>');
    expect(xml).toContain('<cell r="A3" t="b"><v>1</v></cell>');
    expect(xml).toContain('<cell r="A4" t="e"><v>#DIV/0!</v></cell>');
  });
});

describe('end-to-end: fixture formulas resolve to cached values', () => {
  function loadEngine(name: string): EngineWorkbook {
    const adapter = new XlsxAdapter();
    const data = adapter.read(read(name));
    const initial: Record<string, (string | number | boolean | null)[][]> = {};
    for (const sheet of data.sheets) initial[sheet.name] = sheet.rows.map((r) => [...r]);
    return new EngineWorkbook(initial, {
      definedNames: data.definedNames,
      externalLinks: externalLinksFromMetadata(data.metadata),
    });
  }
  const val = (wb: EngineWorkbook, sheet: string, row: number, col: number): unknown =>
    (wb.getValue({ sheet, row, col }) as { value?: unknown }).value;

  it('WorkbookWithExternalLink: B2 shows the cached "hello world"', () => {
    const wb = loadEngine(fixture1);
    expect(val(wb, 'Sheet1', 1, 1)).toBe('hello world');
    expect(wb.getFormula({ sheet: 'Sheet1', row: 1, col: 1 })).toBe('=[1]Sheet1!$A$1');
  });
  it('external-refs: A1..A4 show the cached names', () => {
    const wb = loadEngine(fixture2);
    expect(val(wb, 'Sheet1', 0, 0)).toBe('Name');
    expect(val(wb, 'Sheet1', 1, 0)).toBe('Andy');
    expect(val(wb, 'Sheet1', 2, 0)).toBe('Bruce');
    expect(val(wb, 'Sheet1', 3, 0)).toBe('Charlie');
  });
  it('save/reopen keeps formulas resolving', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(read(fixture1));
    const wb = loadEngine(fixture1);
    void wb;
    const reread = adapter.read(adapter.write(data));
    const links = externalLinksFromMetadata(reread.metadata);
    expect(links).toHaveLength(1);
    const wb2 = new EngineWorkbook(
      Object.fromEntries(reread.sheets.map((s) => [s.name, s.rows.map((r) => [...r])])),
      { externalLinks: links },
    );
    expect(val(wb2, 'Sheet1', 1, 1)).toBe('hello world');
  });
  it('scalar() helper sanity', () => {
    expect(scalar('x')).toEqual({ kind: 'string', value: 'x' });
  });
});
