/**
 * ITEM A regression: `_xlcn.*` connection defined names must never
 * degrade to `#ERROR!` on names-block regeneration.
 *
 * Mechanism (hidden_files/open-defects/item-A.md): the live engine
 * table carries `#ERROR!` for `_xlcn.*` names because HyperFormula
 * cannot parse their structured table refs (`tblBS[]`). On save,
 * directSave calls `definedNamesEqual` / `regenerateWorkbookXml`
 * (packages/service/src/save/directSave.ts) — `_xlcn.*` names are
 * connection bookkeeping, so the streaming save must (a) ignore them
 * in the equality comparison and (b) preserve their source elements
 * verbatim (name, ref, hidden="1", all attrs) when regeneration is
 * forced by a real change elsewhere, never re-emitting the degraded
 * desired entry.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { definedNamesEqual, regenerateWorkbookXml } from '../src/streamingSave.js';
import { parseDefinedNames } from '../src/fastSheetParse.js';
import { XlsxAdapter } from '../src/adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', '..', 'test-data', 'perf-fixtures', 'perf-p75.xlsx');

function xlcnRawElements(xml: string): string[] {
  return xml.match(/<definedName\b[^>]*_xlcn\.[^>]*>[\s\S]*?<\/definedName>/g) ?? [];
}

describe('ITEM A: _xlcn.* names on names-block regeneration (minimal fixture)', () => {
  const wbXml =
    '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>' +
    '<definedNames>' +
    '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$B$2</definedName>' +
    '<definedName name="_xlcn.WorksheetConnection_Foo.xlsxtblBS1" hidden="1">tblBS[]</definedName>' +
    '<definedName name="_xlcn.WorksheetConnection_Foo.xlsxtblIS1" hidden="1">tblIS[]</definedName>' +
    '<definedName name="Cost">Data!$A$1</definedName>' +
    '</definedNames><calcPr calcId="1"/></workbook>';

  // The engine live table: _xlcn refs degraded to #ERROR!.
  const degraded = [
    { name: 'Cost', ref: 'Data!$A$1' },
    { name: '_xlcn.WorksheetConnection_Foo.xlsxtblBS1', ref: '#ERROR!' },
    { name: '_xlcn.WorksheetConnection_Foo.xlsxtblIS1', ref: '#ERROR!' },
  ];

  it('a degraded _xlcn ref alone does not force regeneration (equality ignores _xlcn)', () => {
    expect(definedNamesEqual(wbXml, degraded)).toBe(true);
  });

  it('forced regeneration preserves _xlcn elements verbatim, exactly once, no #ERROR!', () => {
    const out = regenerateWorkbookXml(wbXml, [
      { name: 'Cost', ref: 'Data!$A$2' }, // real change forcing regeneration
      ...degraded.slice(1),
    ]);
    expect(out).not.toContain('#ERROR!');
    const raw = xlcnRawElements(out);
    expect(raw).toEqual([
      '<definedName name="_xlcn.WorksheetConnection_Foo.xlsxtblBS1" hidden="1">tblBS[]</definedName>',
      '<definedName name="_xlcn.WorksheetConnection_Foo.xlsxtblIS1" hidden="1">tblIS[]</definedName>',
    ]);
    const parsed = parseDefinedNames(out);
    const xlcn = parsed.filter((n) => n.name.startsWith('_xlcn.'));
    expect(xlcn).toEqual([
      { name: '_xlcn.WorksheetConnection_Foo.xlsxtblBS1', ref: 'tblBS[]' },
      { name: '_xlcn.WorksheetConnection_Foo.xlsxtblIS1', ref: 'tblIS[]' },
    ]);
    // The real change and the _xlnm preservation still land.
    expect(parsed).toContainEqual({ name: 'Cost', ref: 'Data!$A$2' });
    expect(out).toContain('_xlnm.Print_Area');
  });
});

describe('ITEM A: _xlcn.* names survive the real save path on perf-p75.xlsx', () => {
  it('all 9 hidden _xlcn names keep original refs + hidden="1", zero #ERROR!', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const parts = unzipSync(bytes.slice());
    const srcXml = strFromU8(parts['xl/workbook.xml']!);
    const srcNames = parseDefinedNames(srcXml);
    const srcXlcn = srcNames.filter((n) => n.name.startsWith('_xlcn.'));
    expect(srcXlcn.length).toBe(9);

    // Simulate the live (degraded) desired table the service hands the
    // save path, plus one genuine edit (DPY) to force regeneration.
    const desired = srcNames
      .filter((n) => !n.name.startsWith('_xlnm.'))
      .map((n) => {
        if (n.name.startsWith('_xlcn.')) return { ...n, ref: '#ERROR!' };
        if (n.name === 'DPY') return { ...n, ref: 'Constants!$B$99' };
        return n;
      });

    // The exact branch directSave takes.
    const savedXml = definedNamesEqual(srcXml, desired)
      ? srcXml
      : regenerateWorkbookXml(srcXml, desired);

    expect(savedXml).not.toContain('#ERROR!');
    const saved = parseDefinedNames(savedXml);
    // No name lost or duplicated overall.
    expect(saved.length).toBe(srcNames.length);
    // Every _xlcn name present with its ORIGINAL ref (map compare).
    const savedXlcn = new Map(
      saved.filter((n) => n.name.startsWith('_xlcn.')).map((n) => [n.name, n.ref]),
    );
    expect(savedXlcn.size).toBe(9);
    for (const orig of srcXlcn) expect(savedXlcn.get(orig.name)).toBe(orig.ref);
    // Raw elements keep hidden="1".
    const raw = xlcnRawElements(savedXml);
    expect(raw.length).toBe(9);
    for (const el of raw) expect(el).toContain('hidden="1"');
    // The genuine edit landed.
    expect(saved.find((n) => n.name === 'DPY')?.ref).toBe('Constants!$B$99');
  });

  it('classic adapter.write parity: verbatim _xlcn kept with hidden="1"; degraded never written', () => {
    const adapter = new XlsxAdapter();
    const base = {
      sheets: [{ name: 'Data', rows: [[1]] }],
      metadata: {},
    };
    // Verbatim table: refs survive AND the hidden flag SheetJS drops
    // is restored.
    const verbatimOut = adapter.write({
      ...base,
      definedNames: [
        { name: 'Cost', ref: 'Data!$A$1' },
        { name: '_xlcn.WorksheetConnection_Foo.xlsxtblBS1', ref: 'tblBS[]' },
      ],
    });
    const verbatimXml = strFromU8(unzipSync(verbatimOut.slice())['xl/workbook.xml']!);
    const verbatimRaw = xlcnRawElements(verbatimXml);
    expect(verbatimRaw).toEqual([
      '<definedName name="_xlcn.WorksheetConnection_Foo.xlsxtblBS1" hidden="1">tblBS[]</definedName>',
    ]);
    // Degraded table: the #ERROR! entry is omitted rather than written;
    // the real name still lands.
    const degradedOut = adapter.write({
      ...base,
      definedNames: [
        { name: 'Cost', ref: 'Data!$A$1' },
        { name: '_xlcn.WorksheetConnection_Foo.xlsxtblBS1', ref: '#ERROR!' },
      ],
    });
    const degradedXml = strFromU8(unzipSync(degradedOut.slice())['xl/workbook.xml']!);
    expect(degradedXml).not.toContain('#ERROR!');
    expect(degradedXml).not.toContain('_xlcn.');
    expect(parseDefinedNames(degradedXml)).toContainEqual({ name: 'Cost', ref: 'Data!$A$1' });
  });

  it('degraded-only desired table compares equal (verbatim copy path, no regeneration)', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const parts = unzipSync(bytes.slice());
    const srcXml = strFromU8(parts['xl/workbook.xml']!);
    const srcNames = parseDefinedNames(srcXml);
    const degradedOnly = srcNames
      .filter((n) => !n.name.startsWith('_xlnm.'))
      .map((n) => (n.name.startsWith('_xlcn.') ? { ...n, ref: '#ERROR!' } : n));
    expect(definedNamesEqual(srcXml, degradedOnly)).toBe(true);
  });
});
