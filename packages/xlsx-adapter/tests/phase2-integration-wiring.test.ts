import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import {
  XlsxAdapter,
  parseSheetSpills,
  resolveRichValues,
  type RichValuesModel,
} from '../src/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const WORKBOOK =
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS =
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata" Target="metadata.xml"/>` +
  `</Relationships>`;
// A1: rich stock via shared string (t="s", <v>0</v> -> "MSFT"); B1: spill anchor.
const SHEET =
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  `<row r="1"><c r="A1" t="s" vm="1"><v>0</v></c>` +
  `<c r="B1"><f t="array" ref="B1:C2">SEQUENCE(2,2)</f><v>1</v></c><c r="C1"><v>2</v></c></row>` +
  `<row r="2"><c r="B2"><v>3</v></c><c r="C2"><v>4</v></c></row>` +
  `</sheetData></worksheet>`;
const SHARED_STRINGS =
  `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">` +
  `<si><t>MSFT</t></si></sst>`;
const METADATA =
  `<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata">` +
  `<metadataTypes count="1"><metadataType name="XLRICHVALUE"/></metadataTypes>` +
  `<futureMetadata name="XLRICHVALUE" count="1">` +
  `<bk><extLst><ext uri="{00000000-0000-0000-0000-000000000000}"><xlrd:rvb i="0"/></ext></extLst></bk>` +
  `</futureMetadata>` +
  `<valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata>` +
  `</metadata>`;
const RICH_DATA =
  `<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1">` +
  `<rv s="0"><v>MSFT</v><v>Microsoft Corporation</v><v>428.15</v><fb t="s">MSFT</fb></rv>` +
  `</rvData>`;
const STRUCTURES =
  `<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1">` +
  `<s><k name="_Self" t="s"/><k name="Name" t="s"/><k name="Price" t="d"/></s>` +
  `</rvStructures>`;
const TYPES =
  `<rvTypes xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2">` +
  `<type name="_Stock"><key name="_Self"/></type>` +
  `</rvTypes>`;
const CONTENT_TYPES =
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
  `<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>` +
  `</Types>`;

function syntheticPackage(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': enc.encode(CONTENT_TYPES),
    'xl/workbook.xml': enc.encode(WORKBOOK),
    'xl/_rels/workbook.xml.rels': enc.encode(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': enc.encode(SHEET),
    'xl/sharedStrings.xml': enc.encode(SHARED_STRINGS),
    'xl/metadata.xml': enc.encode(METADATA),
    'xl/richData/richValue.xml': enc.encode(RICH_DATA),
    'xl/richData/richValueStructure.xml': enc.encode(STRUCTURES),
    'xl/richData/richValueTypes.xml': enc.encode(TYPES),
  });
}

describe('phase 2 adapter wiring', () => {
  it('load stashes rich values (shared-string fallback resolved) and spill metadata', () => {
    const data = new XlsxAdapter().read(syntheticPackage());
    const richRaw = data.metadata['icecream.richValues'];
    expect(typeof richRaw).toBe('string');
    const model = JSON.parse(richRaw as string) as RichValuesModel;
    const ref = model.cellRefs.find((c) => c.ref === 'A1');
    expect(ref?.cellType).toBe('s');
    // R5: the raw shared-string index "0" is resolved to the real string.
    expect(ref?.cachedValue).toBe('MSFT');
    const resolved = resolveRichValues(model);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.fields.map((f) => f.key)).toEqual(['_Self', 'Name', 'Price']);
    expect(resolved[0]!.fields[2]!.value).toBe(428.15);
    const spillRaw = data.metadata['xlsx.spill.Data'];
    expect(typeof spillRaw).toBe('string');
    const parsed = JSON.parse(spillRaw as string) as { spills: { ref: string; formula: string }[] };
    expect(parsed.spills).toHaveLength(1);
    expect(parsed.spills[0]!.ref).toBe('B1:C2');
    expect(parsed.spills[0]!.formula).toBe('SEQUENCE(2,2)');
  });

  it('save stamps vm + cached fallback and restores the spill array formula', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(syntheticPackage());
    const out = adapter.write(data);
    const files = unzipSync(out.slice());
    // Rich parts regenerated.
    expect(files['xl/metadata.xml']).toBeDefined();
    expect(files['xl/richData/richValue.xml']).toBeDefined();
    const sheetXml = dec.decode(files['xl/worksheets/sheet1.xml']!);
    // vm stamped on the rich cell (shared-string cell keeps its <v> index).
    expect(sheetXml).toMatch(/<c[^>]*\br="A1"[^>]*\bvm="1"/);
    // Spill anchor rewritten as a real array formula with its stored extent.
    // (The future-function prefixer runs after injection, so SEQUENCE —
    // a post-2007 function — is stored in the file's plain `_xlfn.` form,
    // exactly as a plain SEQUENCE formula cell is stored elsewhere.)
    expect(sheetXml).toMatch(/<f t="array" ref="B1:C2">(?:_xlfn\.)?SEQUENCE\(2,2\)<\/f>/);
    // Round-trip: the written file re-parses to the same spill + rich model.
    const back = adapter.read(out);
    const spillBack = JSON.parse(back.metadata['xlsx.spill.Data'] as string) as {
      spills: { ref: string; formula: string }[];
    };
    expect(spillBack.spills[0]!.ref).toBe('B1:C2');
    const richBack = JSON.parse(back.metadata['icecream.richValues'] as string) as RichValuesModel;
    expect(resolveRichValues(richBack)).toHaveLength(1);
    void parseSheetSpills;
  });

  it('save skips a spill whose anchor formula was edited away', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(syntheticPackage());
    const sheet = data.sheets.find((s) => s.name === 'Data')!;
    // Anchor B1 (row 0, col 1) edited to a plain value: the stored spill
    // must not resurrect SEQUENCE on save.
    sheet.rows[0]![1] = 99;
    const out = adapter.write(data);
    const files = unzipSync(out.slice());
    const sheetXml = dec.decode(files['xl/worksheets/sheet1.xml']!);
    expect(sheetXml).not.toContain('t="array"');
  });
});
