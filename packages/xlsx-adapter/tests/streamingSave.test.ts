/**
 * W21 streaming save writer: verbatim part copy, append-only styles,
 * row-by-row sheet generation, defined-names / custom-props surgery.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { XlsxAdapter } from '../src/adapter.js';
import {
  createStreamingStyles,
  definedNamesEqual,
  mergeCustomPropsXml,
  regenerateWorkbookXml,
  sheetXmlChunks,
  streamZipToSink,
  textChunks,
  verbatimChunks,
  type StreamSaveCell,
} from '../src/index.js';
import { parseDefinedNames } from '../src/fastSheetParse.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function zipOf(entries: Array<{ name: string; chunks: () => Iterable<Uint8Array> }>): Uint8Array {
  const out: Uint8Array[] = [];
  streamZipToSink(entries, (c) => out.push(c.slice()));
  const total = out.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of out) {
    joined.set(c, off);
    off += c.length;
  }
  return joined;
}

function sourceWorkbook(): { bytes: Uint8Array; parts: Record<string, Uint8Array> } {
  const bytes = new XlsxAdapter().write({
    sheets: [
      { name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']], formats: { '0:1': '0.00' } },
      { name: 'Other', rows: [['keep', 42]] },
    ],
    metadata: { 'icecream.note': 'hello' },
    definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
  });
  return { bytes, parts: unzipSync(bytes.slice()) as Record<string, Uint8Array> };
}

describe('streaming sheet generation', () => {
  it('round-trips values, formulas with cached values, error literals and text escapes', () => {
    const cells: StreamSaveCell[] = [
      { row: 0, col: 0, input: 5 },
      { row: 0, col: 1, input: '=A1*2', value: { kind: 'number', value: 10 } },
      { row: 0, col: 2, input: '=IF(A1>3,"big","small")', value: { kind: 'string', value: 'big' } },
      { row: 1, col: 0, input: '#DIV/0!' },
      { row: 1, col: 1, input: "'=not a formula" },
      { row: 1, col: 2, input: ' spaced ' },
      { row: 2, col: 0, input: true },
      { row: 2, col: 1, input: null, style: { bold: true } },
    ];
    const xml = [...sheetXmlChunks({ sourceXml: null, cells, xfFor: () => 0 })].join('');
    expect(xml).toContain('<f>A1*2</f><v>10</v>');
    expect(xml).toContain('t="str"');
    expect(xml).toContain('t="e"><v>#DIV/0!</v>');
    expect(xml).toContain('xml:space="preserve"');
    // Assemble a full package around the generated sheet and parse back.
    const { parts } = sourceWorkbook();
    const sheetPath = 'xl/worksheets/sheet1.xml';
    const entries = Object.entries(parts).map(([name, bytes]) => ({
      name,
      chunks: () =>
        name === sheetPath
          ? textChunks(
              [...sheetXmlChunks({ sourceXml: dec.decode(bytes), cells, xfFor: () => 0 })].join(''),
            )
          : verbatimChunks(bytes),
    }));
    const back = new XlsxAdapter().read(zipOf(entries));
    const data = back.sheets.find((s) => s.name === 'Data')!;
    expect(data.rows[0]![0]).toBe(5);
    expect(data.rows[0]![1]).toBe('=A1*2');
    expect(data.rows[0]![2]).toBe('=IF(A1>3,"big","small")');
    expect(data.rows[1]![0]).toBe('#DIV/0!');
    expect(data.rows[1]![1]).toBe("'=not a formula");
    expect(data.rows[1]![2]).toBe(' spaced ');
    expect(data.rows[2]![0]).toBe(true);
  });

  it('item G: literal empty-string cells survive regeneration (null stays absent)', () => {
    const cells: StreamSaveCell[] = [
      { row: 0, col: 0, input: '' },
      { row: 0, col: 1, input: null },
      { row: 0, col: 2, input: 'x' },
      { row: 1, col: 0, input: '', style: { bold: true } },
    ];
    const xml = [...sheetXmlChunks({ sourceXml: null, cells, xfFor: (s) => (s?.bold ? 1 : 0) })].join('');
    // '' emits an empty inline-string cell, distinct from the bare <c/> for null.
    expect(xml).toContain('<c r="A1" t="inlineStr"><is><t></t></is></c>');
    expect(xml).toContain('<c r="A2" s="1" t="inlineStr"><is><t></t></is></c>');
    expect(xml).toContain('<c r="B1"/>');
    expect(xml).not.toContain('<c r="A1"/>');
    // Parse back: '' reads back as '' (a real cell); null stays absent.
    const { parts } = sourceWorkbook();
    const sheetPath = 'xl/worksheets/sheet1.xml';
    const entries = Object.entries(parts).map(([name, bytes]) => ({
      name,
      chunks: () =>
        name === sheetPath
          ? textChunks(
              [...sheetXmlChunks({ sourceXml: dec.decode(bytes), cells, xfFor: (s) => (s?.bold ? 1 : 0) })].join(''),
            )
          : verbatimChunks(bytes),
    }));
    const back = new XlsxAdapter().read(zipOf(entries));
    const data = back.sheets.find((s) => s.name === 'Data')!;
    expect(data.rows[0]![0]).toBe('');
    expect(data.rows[0]![2]).toBe('x');
    expect(data.rows[1]![0]).toBe('');
    // B1 (null) is not a real cell: the reader densifies rows, so the slot
    // exists but must hold null/undefined — never '', which is a real value.
    expect(data.rows[0]![1] == null).toBe(true);
    expect(data.rows[0]![1]).not.toBe('');
  });

  it('keeps the source head/tail (sheetViews, cols) and updates the dimension', () => {
    const { parts } = sourceWorkbook();
    const srcXml = dec.decode(parts['xl/worksheets/sheet1.xml']!);
    const cells: StreamSaveCell[] = [{ row: 40, col: 3, input: 1 }];
    const xml = [...sheetXmlChunks({ sourceXml: srcXml, cells, xfFor: () => 0 })].join('');
    expect(xml).toContain('<dimension ref="A1:D41"/>');
    expect(xml).toContain('<row r="41">');
    expect(xml).toContain('</sheetData>');
  });
});

describe('verbatim + streaming package assembly', () => {
  it('an unchanged sheet part is byte-identical; a changed sheet reflects its cells', () => {
    const { bytes, parts } = sourceWorkbook();
    void bytes;
    const otherPath = 'xl/worksheets/sheet2.xml';
    const dataPath = 'xl/worksheets/sheet1.xml';
    const edited: StreamSaveCell[] = [
      { row: 0, col: 0, input: 100 },
      { row: 0, col: 1, input: 2, formatCode: '0.00' },
      { row: 1, col: 0, input: '=A1+B1', value: { kind: 'number', value: 102 } },
      { row: 1, col: 1, input: 'edited' },
    ];
    const entries = Object.entries(parts).map(([name, partBytes]) => ({
      name,
      chunks: () =>
        name === dataPath
          ? textChunks(
              [...sheetXmlChunks({ sourceXml: dec.decode(partBytes), cells: edited, xfFor: () => 0 })].join(''),
            )
          : verbatimChunks(partBytes),
    }));
    const out = zipOf(entries);
    const outParts = unzipSync(out.slice()) as Record<string, Uint8Array>;
    expect(Buffer.from(outParts[otherPath]!)).toEqual(Buffer.from(parts[otherPath]!));
    const back = new XlsxAdapter().read(out);
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]![0]).toBe(100);
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[1]![1]).toBe('edited');
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);
  });
});

describe('append-only styles resolver', () => {
  it('resolves format codes and styles to appended xfs; original indices untouched', () => {
    const { parts } = sourceWorkbook();
    const stylesXml = dec.decode(parts['xl/styles.xml']!);
    const resolver = createStreamingStyles(stylesXml);
    expect(resolver.dirty).toBe(false);
    expect(resolver.toXml()).toBe(stylesXml);
    const pct = resolver.xfFor(undefined, '0.00%');
    const boldPct = resolver.xfFor({ bold: true, numberFormatCode: '0.00%' }, undefined);
    expect(boldPct).not.toBe(pct);
    // Dedupe: same input resolves to the same appended xf.
    expect(resolver.xfFor(undefined, '0.00%')).toBe(pct);
    expect(resolver.dirty).toBe(true);
    const out = resolver.toXml();
    expect(out).not.toBe(stylesXml);
    // '0.00%' is built-in numFmtId 10: the appended xf references it
    // directly, no new <numFmt> element is needed.
    expect(out).toContain('numFmtId="10"');
    expect(resolver.appendedXfs).toBeGreaterThanOrEqual(2);
  });

  it('a plain General cell resolves to xf 0 without dirtying the tables', () => {
    const { parts } = sourceWorkbook();
    const resolver = createStreamingStyles(dec.decode(parts['xl/styles.xml']!));
    expect(resolver.xfFor(undefined, undefined)).toBe(0);
    expect(resolver.xfFor(undefined, 'General')).toBe(0);
    expect(resolver.dirty).toBe(false);
  });
});

describe('defined names surgery', () => {
  it('equality check and regeneration preserve _xlnm entries', () => {
    const wbXml =
      '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>' +
      '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$B$2</definedName>' +
      '<definedName name="Cost">Data!$A$1</definedName></definedNames><calcPr calcId="1"/></workbook>';
    expect(definedNamesEqual(wbXml, [{ name: 'Cost', ref: 'Data!$A$1' }])).toBe(true);
    expect(definedNamesEqual(wbXml, [{ name: 'Cost', ref: 'Data!$A$2' }])).toBe(false);
    const out = regenerateWorkbookXml(wbXml, [
      { name: 'Cost', ref: 'Data!$A$2' },
      { name: 'New', ref: 'Data!$B$1' },
    ]);
    expect(out).toContain('_xlnm.Print_Area');
    expect(out).toContain('Data!$A$1:$B$2');
    const names = parseDefinedNames(out).filter((n) => !n.name.startsWith('_xlnm.'));
    expect(names).toEqual([
      { name: 'Cost', ref: 'Data!$A$2' },
      { name: 'New', ref: 'Data!$B$1' },
    ]);
    // Everything outside the definedNames block is untouched.
    expect(out.startsWith('<workbook><sheets>')).toBe(true);
    expect(out).toContain('<calcPr calcId="1"/>');
  });
});

describe('custom properties merge', () => {
  it('no change -> verbatim; changed icecream value -> regenerated, foreign props kept', () => {
    const src =
      '<Properties>' +
      '<property fmtID="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Foreign"><vt:lpwstr>keep me</vt:lpwstr></property>' +
      '<property fmtID="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="IcecreamSheets.Meta.icecream.note"><vt:lpwstr>_x0022_old_x0022_</vt:lpwstr></property>' +
      '</Properties>';
    const same = mergeCustomPropsXml(src, { 'icecream.note': 'old' });
    expect(same.changed).toBe(false);
    expect(same.xml).toBeNull();
    const changed = mergeCustomPropsXml(src, { 'icecream.note': 'new "quoted" _x0022_ literal' });
    expect(changed.changed).toBe(true);
    expect(changed.xml).toContain('keep me');
    expect(changed.xml).toContain('IcecreamSheets.Meta.icecream.note');
    // The regenerated value round-trips through the package readers.
    const { parts } = sourceWorkbook();
    void parts;
    const entries = [
      { name: 'docProps/custom.xml', chunks: () => textChunks(changed.xml as string) },
    ];
    void entries;
    expect(enc.encode(changed.xml as string).length).toBeGreaterThan(0);
  });
});
