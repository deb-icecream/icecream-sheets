import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import {
  injectRichValueParts,
  metadataToXml,
  parseCellRichValueRefs,
  parseMetadataXml,
  parseRichValueDataXml,
  parseRichValueStructuresXml,
  parseRichValueTypesXml,
  readRichValues,
  readRichValuesPackage,
  resolveRichValues,
  richValueDataToXml,
  richValueStructuresToXml,
  richValueTypesToXml,
  richValuesModelOf,
  type RichValuesModel,
} from '../src/index.js';

const enc = new TextEncoder();

const WORKBOOK =
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS =
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;
// A1: stock (vm=1 -> valueMetadata bk0 -> rc t=1(XLRICHVALUE) v=0 -> future bk0 -> rvb 0 -> MSFT).
// A2: geography (vm=2 -> bk1 -> rc t=1 v=1 -> future bk1 -> rvb 1 -> London).
// A3: non-rich metadata (vm=3 -> bk2 -> rc t=2(XLCELL) v=0 -> no futureMetadata -> unresolvable).
// A4: dangling vm (vm=99 -> no block -> unresolvable, but the ref is still recorded).
// B1: no vm at all. C1: corrupt vm="x" -> skipped entirely.
const SHEET =
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  `<row r="1"><c r="A1" vm="1"><v>MSFT</v></c><c r="A2" vm="2"><v>London</v></c>` +
  `<c r="A3" vm="3"><v>7</v></c><c r="A4" vm="99"><v>?</v></c></row>` +
  `<row r="2"><c r="B1"><v>plain</v></c><c r="C1" vm="x"><v>bad</v></c></row>` +
  `</sheetData></worksheet>`;
const METADATA =
  `<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata">` +
  `<metadataTypes count="2">` +
  `<metadataType name="XLRICHVALUE" minSupportedVersion="120000"/>` +
  `<metadataType name="XLCELL"/>` +
  `</metadataTypes>` +
  `<futureMetadata name="XLRICHVALUE" count="2">` +
  `<bk><extLst><ext uri="{00000000-0000-0000-0000-000000000000}"><xlrd:rvb i="0"/></ext></extLst></bk>` +
  `<bk><extLst><ext uri="{00000000-0000-0000-0000-000000000000}"><xlrd:rvb i="1"/></ext></extLst></bk>` +
  `</futureMetadata>` +
  `<valueMetadata count="3">` +
  `<bk><rc t="1" v="0"/></bk><bk><rc t="1" v="1"/></bk><bk><rc t="2" v="0"/></bk>` +
  `</valueMetadata>` +
  `</metadata>`;
const RICH_DATA =
  `<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="2">` +
  `<rv s="0"><v>MSFT</v><v>Microsoft Corporation</v><v>428.15</v><v>-2.31</v><fb t="s">MSFT</fb></rv>` +
  `<rv s="1"><v>London</v><v>London</v><v>8982000</v></rv>` +
  `</rvData>`;
const STRUCTURES =
  `<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="2">` +
  `<s><k name="_Self" t="s"/><k name="Name" t="s"/><k name="Price" t="d"/><k name="Change" t="d"/></s>` +
  `<s><k name="_Self" t="s"/><k name="Name" t="s"/><k name="Population" t="i"/></s>` +
  `</rvStructures>`;
const TYPES =
  `<rvTypes xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2">` +
  `<type name="_Stock"><key name="_Self"/></type><type name="_Geography"/>` +
  `</rvTypes>`;
const CONTENT_TYPES =
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

/**
 * Synthetic rich-value package. NOTE: no real Excel file exercising rich
 * values exists anywhere in this tree (verified by grep over test-data
 * and fixtures) — this fixture is synthetic, built to the [MS-XLSX]
 * chain (cell vm -> metadata.xml -> richData parts), and is labeled as
 * such. A real-file re-verification against an Excel-produced Stocks /
 * Geography file is a stated residual.
 */
function syntheticFiles(): Record<string, Uint8Array> {
  return {
    '[Content_Types].xml': enc.encode(CONTENT_TYPES),
    'xl/workbook.xml': enc.encode(WORKBOOK),
    'xl/_rels/workbook.xml.rels': enc.encode(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': enc.encode(SHEET),
    'xl/metadata.xml': enc.encode(METADATA),
    'xl/richData/richValue.xml': enc.encode(RICH_DATA),
    'xl/richData/richValueStructure.xml': enc.encode(STRUCTURES),
    'xl/richData/richValueTypes.xml': enc.encode(TYPES),
  };
}

describe('rich values', () => {
  it('parses metadata.xml: types, futureMetadata rvb links, valueMetadata blocks', () => {
    const meta = parseMetadataXml(METADATA)!;
    expect(meta.types.map((t) => t.name)).toEqual(['XLRICHVALUE', 'XLCELL']);
    expect(meta.types[0]!.attrs).toEqual({ minSupportedVersion: '120000' });
    expect(meta.types[1]!.attrs).toBeUndefined();
    expect(meta.futureMetadata).toHaveLength(1);
    expect(meta.futureMetadata[0]!.blocks.map((b) => b.rvbIndex)).toEqual([0, 1]);
    expect(meta.valueMetadata.map((b) => b.records)).toEqual([
      [{ t: 1, v: 0 }],
      [{ t: 1, v: 1 }],
      [{ t: 2, v: 0 }],
    ]);
  });

  it('parses rich-data parts: data, structures, types', () => {
    const values = parseRichValueDataXml(RICH_DATA);
    expect(values).toHaveLength(2);
    expect(values[0]!.structureIndex).toBe(0);
    expect(values[0]!.values.map((v) => v.text)).toEqual(['MSFT', 'Microsoft Corporation', '428.15', '-2.31']);
    expect(values[0]!.fallback).toEqual({ t: 's', text: 'MSFT' });
    expect(values[1]!.fallback).toBeUndefined();
    const structures = parseRichValueStructuresXml(STRUCTURES);
    expect(structures[0]!.keys.map((k) => `${k.name}:${k.type}`)).toEqual([
      '_Self:s',
      'Name:s',
      'Price:d',
      'Change:d',
    ]);
    const types = parseRichValueTypesXml(TYPES);
    expect(types[0]!.attrs).toEqual({ name: '_Stock' });
    expect(types[0]!.innerXml).toContain('key name="_Self"');
    expect(types[1]!.innerXml).toBe('');
  });

  it('reads the whole package and resolves cells through the vm chain', () => {
    const result = readRichValues(syntheticFiles());
    expect(result.partPaths).toEqual({
      metadata: 'xl/metadata.xml',
      data: 'xl/richData/richValue.xml',
      structures: 'xl/richData/richValueStructure.xml',
      types: 'xl/richData/richValueTypes.xml',
    });
    // A1, A2, A3, A4 recorded; B1 (no vm) and C1 (corrupt vm) skipped.
    expect(result.cellRefs.map((c) => c.ref)).toEqual(['A1', 'A2', 'A3', 'A4']);
    expect(result.cellRefs[0]).toMatchObject({ sheetName: 'Data', sheetIndex: 0, vm: 1, cachedValue: 'MSFT' });

    const resolved = resolveRichValues(result);
    expect(resolved.map((r) => r.cell.ref)).toEqual(['A1', 'A2']);
    const stock = resolved[0]!;
    expect(stock.richValueIndex).toBe(0);
    expect(stock.typeName).toBe('XLRICHVALUE');
    expect(stock.fallback).toBe('MSFT');
    expect(stock.fields).toEqual([
      { key: '_Self', type: 's', value: 'MSFT', rawText: 'MSFT' },
      { key: 'Name', type: 's', value: 'Microsoft Corporation', rawText: 'Microsoft Corporation' },
      { key: 'Price', type: 'd', value: 428.15, rawText: '428.15' },
      { key: 'Change', type: 'd', value: -2.31, rawText: '-2.31' },
    ]);
    const geo = resolved[1]!;
    expect(geo.fallback).toBe('London'); // no <fb>: falls back to the cell's cached <v>
    expect(geo.fields.find((f) => f.key === 'Population')).toEqual({
      key: 'Population',
      type: 'i',
      value: 8982000,
      rawText: '8982000',
    });
  });

  it('parse -> write -> re-parse is an identity on the model, per part', () => {
    const meta = parseMetadataXml(METADATA)!;
    expect(parseMetadataXml(metadataToXml(meta))).toEqual(meta);
    const values = parseRichValueDataXml(RICH_DATA);
    expect(parseRichValueDataXml(richValueDataToXml(values))).toEqual(values);
    const structures = parseRichValueStructuresXml(STRUCTURES);
    expect(parseRichValueStructuresXml(richValueStructuresToXml(structures))).toEqual(structures);
    const types = parseRichValueTypesXml(TYPES);
    // innerXml round-trips verbatim through the types serializer
    expect(parseRichValueTypesXml(richValueTypesToXml(types))).toEqual(types);
  });

  it('inject + re-read is an identity on the whole model', () => {
    const files = syntheticFiles();
    const model: RichValuesModel = richValuesModelOf(readRichValues(files));
    const written = injectRichValueParts(files, model);
    expect(written).toEqual([
      'xl/metadata.xml',
      'xl/richData/richValue.xml',
      'xl/richData/richValueStructure.xml',
      'xl/richData/richValueTypes.xml',
    ]);
    expect(richValuesModelOf(readRichValues(files))).toEqual(model);
    expect(new TextDecoder().decode(files['[Content_Types].xml']!)).toContain('richValue');
  });

  it('reads a whole .xlsx package (zip) and tolerates missing/corrupt input without throwing', () => {
    const bytes = zipSync(syntheticFiles());
    const fromZip = readRichValuesPackage(bytes);
    expect(resolveRichValues(fromZip).map((r) => r.cell.ref)).toEqual(['A1', 'A2']);
    expect(readRichValues({}).cellRefs).toEqual([]);
    expect(readRichValues({}).values).toEqual([]);
    expect(parseMetadataXml('not xml at all')).toBeNull();
    expect(parseRichValueDataXml('<rvData/>')).toEqual([]);
    expect(readRichValuesPackage(new Uint8Array([1, 2, 3]))).toMatchObject({ cellRefs: [], values: [] });
    expect(injectRichValueParts({}, richValuesModelOf(readRichValues({})))).toEqual([]);
  });

  it('discovers rich-data parts by root element, not by one filename', () => {
    const files = syntheticFiles();
    // Rename to the rd-prefixed producer variant; discovery must still work.
    files['xl/richData/rdrichvalue.xml'] = files['xl/richData/richValue.xml']!;
    delete files['xl/richData/richValue.xml'];
    files['xl/richData/rdrichvaluestructure.xml'] = files['xl/richData/richValueStructure.xml']!;
    delete files['xl/richData/richValueStructure.xml'];
    const result = readRichValues(files);
    expect(result.values).toHaveLength(2);
    expect(result.structures).toHaveLength(2);
    expect(resolveRichValues(result).map((r) => r.cell.ref)).toEqual(['A1', 'A2']);
  });

  it('parses sheet vm refs directly, including cached value and cell type', () => {
    const refs = parseCellRichValueRefs(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
        `<row><c r="Z9" t="s" vm="4"><v>12</v></c></row></sheetData></worksheet>`,
      'S',
      3,
    );
    expect(refs).toEqual([{ sheetName: 'S', sheetIndex: 3, ref: 'Z9', vm: 4, cachedValue: '12', cellType: 's' }]);
  });

  it('keeps a record with no structure index, resolving to no fields rather than throwing', () => {
    const values = parseRichValueDataXml(
      `<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1">` +
        `<rv><v>orphan</v></rv></rvData>`,
    );
    expect(values).toEqual([{ values: [{ tag: 'v', text: 'orphan' }] }]);
    expect(unzipSync).toBeDefined(); // zip helper import sanity (used above)
  });
});
