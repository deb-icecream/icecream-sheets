import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import {
  PIVOT_PARTS_METADATA_KEY,
  PIVOT_TABLES_METADATA_KEY,
  XlsxAdapter,
  injectPivotParts,
  readPivotTables,
  type ImportedPivotTable,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = (name: string): string =>
  join(HERE, '..', '..', '..', 'test-data', 'real-world', name);

function filesOf(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes.slice()))) out[k] = v as Uint8Array;
  return out;
}

function readFixture(name: string): ImportedPivotTable[] {
  const bytes = new Uint8Array(readFileSync(REAL(name)));
  return readPivotTables(filesOf(bytes)).tables;
}

const enc = new TextEncoder();

/** Minimal package with one worksheet, one pivot table + cache + records. */
function minimalPivotPackage(opts: {
  /** Omit the cache definition part entirely (missing-cache error path). */
  noCacheDef?: boolean;
  /** Omit the records part (saveData=0-style: no cached data). */
  noRecords?: boolean;
  /** External (OLAP) cache source with saveData="0", like Power Pivot files. */
  externalCache?: boolean;
  /** Extra XML inside <pivotTableDefinition> (fields etc). */
  tableInner?: string;
}): Uint8Array {
  const cacheDef = opts.noCacheDef
    ? {}
    : {
        'xl/pivotCache/pivotCacheDefinition1.xml': enc.encode(
          `<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${opts.externalCache ? ' saveData="0"' : ''} recordCount="2">` +
            (opts.externalCache
              ? `<cacheSource type="external" connectionId="1"></cacheSource>`
              : `<cacheSource type="worksheet"><worksheetSource ref="A1:B3" sheet="Data"/></cacheSource>`) +
            `<cacheFields count="2">` +
            `<cacheField name="Region"><sharedItems count="2"><s v="East"/><s v="West"/></sharedItems></cacheField>` +
            `<cacheField name="Amount"><sharedItems containsNumber="1"/></cacheField>` +
            `</cacheFields></pivotCacheDefinition>`,
        ),
        'xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels': enc.encode(
          `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords" Target="pivotCacheRecords1.xml"/></Relationships>`,
        ),
      };
  const records =
    opts.noCacheDef || opts.noRecords
      ? {}
      : {
          'xl/pivotCache/pivotCacheRecords1.xml': enc.encode(
            `<pivotCacheRecords count="2">` +
              `<r><x v="0"/><n v="10"/></r>` +
              `<r><x v="1"/><n v="20"/></r>` +
              `</pivotCacheRecords>`,
          ),
        };
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet+xml"/>` +
        `</Types>`,
    ),
    'xl/workbook.xml':
      enc.encode(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><pivotCaches><pivotCache cacheId="0" r:id="rId2"/></pivotCaches></workbook>`),
    'xl/_rels/workbook.xml.rels': enc.encode(
      `<Relationships>` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        (opts.noCacheDef
          ? ''
          : `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>`) +
        `</Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': enc.encode(`<worksheet><sheetData/></worksheet>`),
    'xl/worksheets/_rels/sheet1.xml.rels': enc.encode(
      `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>`,
    ),
    'xl/pivotTables/pivotTable1.xml': enc.encode(
      `<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="SalesPivot" cacheId="0" dataCaption="Values">` +
        `<location ref="D1:F5"/>` +
        (opts.tableInner ?? '') +
        `<pivotTableStyleInfo name="PivotStyleMedium9"/>` +
        `</pivotTableDefinition>`,
    ),
    'xl/pivotTables/_rels/pivotTable1.xml.rels': enc.encode(
      `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/></Relationships>`,
    ),
    ...cacheDef,
    ...records,
  };
  return zipSync(files);
}

const FULL_TABLE_INNER =
  `<pivotFields count="2">` +
    `<pivotField axis="axisRow" showAll="0"><items count="3"><item x="0"/><item h="1" x="1"/><item t="default"/></items></pivotField>` +
    `<pivotField dataField="1" showAll="0"/>` +
    `</pivotFields>` +
    `<rowFields count="1"><field x="0"/></rowFields>` +
    `<colFields count="1"><field x="-2"/></colFields>` +
    `<dataFields count="1"><dataField name="Total Amount" fld="1" subtotal="sum"/></dataFields>`;

describe('readPivotTables', () => {
  it('never throws on empty/garbage input', () => {
    expect(readPivotTables({}).tables).toEqual([]);
    expect(readPivotTables({ 'xl/workbook.xml': enc.encode('<nope>') }).tables).toEqual([]);
  });

  it('parses the 7 pivots + 7 caches of the AllSources fixture', () => {
    const { tables, rawParts } = readPivotTables(
      filesOf(new Uint8Array(readFileSync(REAL('closedxml-Sources-PivotTable-AllSources-input.xlsx')))),
    );
    expect(tables).toHaveLength(7);
    // Every cache source flavour in one file: worksheet range, table name,
    // defined name, external, scenario, consolidation.
    const kinds = new Set(tables.map((t) => t.source.kind));
    expect(kinds.has('worksheet')).toBe(true);
    expect(kinds.has('external')).toBe(true);
    expect(kinds.has('scenario')).toBe(true);
    expect(kinds.has('consolidation')).toBe(true);
    // Cache 1: worksheet range source with records resolved inline.
    const area = tables.find((t) => t.sheetName === 'Area - PT');
    expect(area?.fieldNames).toEqual(['Name', 'Value']);
    expect(area?.records).toEqual([['Cake', 1]]);
    expect(area?.source).toEqual({ kind: 'worksheet', sheet: 'Area Source', ref: 'D3:E4' });
    // The scenario cache resolves its sibling records file even though the
    // definition carries saveData="0" and no .rels link.
    const scenario = tables.find((t) => t.sheetName === 'Scenario - PT');
    expect(scenario?.hasRecords).toBe(true);
    expect(scenario?.records).toHaveLength(3);
    expect(scenario?.rows).toEqual(['$B$2:$B$3']);
    expect(scenario?.values[0]?.field).toBe('res $B$5');
    // Raw parts captured for the round-trip.
    expect(Object.keys(rawParts.parts).length).toBeGreaterThan(20);
    expect(rawParts.caches).toHaveLength(7);
    expect(rawParts.tables).toHaveLength(7);
  });

  it('parses the 14 table-sourced pivots incl. filters and totals flags', () => {
    const tables = readFixture('closedxml-TryToLoad-TemplateWithTableSourcePivotTables.xlsx');
    expect(tables).toHaveLength(14);
    const fl = tables.find((t) => t.name === 'FinalLiabilityPivotTable');
    expect(fl).toBeDefined();
    expect(fl?.rows).toEqual(['Scheme']);
    // x="-2" in colFields: values on columns.
    expect(fl?.columns).toEqual([]);
    expect(fl?.dataOnRows).toBe(false);
    expect(fl?.values.map((v) => v.label)).toEqual([
      'Main liability',
      'Additional preliminary liability',
    ]);
    // Page (report-filter) fields become include-only filters.
    const filterFields = (fl?.filters ?? []).map((f) => f.field);
    expect(filterFields).toContain('IncludeInLiabilityReporting');
    expect(filterFields).toContain('BuildupStep');
    expect(fl?.anchor).toMatchObject({ row: 3, col: 0, ref: 'A4:C6' });
    expect(fl?.styleName).toBe('PivotStyleLight16');
  });

  it('handles the missing source-sheet reference gracefully (no crash)', () => {
    const tables = readFixture('closedxml-TryToLoad-PivotTableWithMissingReference.xlsx');
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    // The cache itself is intact (23 records) even though its source sheet
    // "Pivot Data" is not in the workbook — the layout stays computable.
    expect(t.warning).toBeUndefined();
    expect(t.records).toHaveLength(23);
    expect(t.rows).toEqual(['TK']);
    expect(t.columns).toEqual(['BK']);
    expect(t.values).toEqual([
      { field: 'GQ', aggregation: 'count', label: 'Count of GQ' },
    ]);
    expect(t.source).toMatchObject({ kind: 'worksheet', sheet: 'Pivot Data' });
  });

  it('maps hidden boolean items to an include-only filter', () => {
    const tables = readFixture('closedxml-xlsx-pivottable_bool_field_filter.xlsx');
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.filters).toEqual([{ field: 'Bool field', selected: ['TRUE'] }]);
    expect(t.values).toEqual([{ field: 'Amount', aggregation: 'sum', label: 'Sum of Amount' }]);
    // <b v="1"/> shared items resolve to real booleans.
    expect(t.records[0]?.[3]).toBe(true);
    expect(t.records[1]?.[3]).toBe(false);
  });

  it('excludes the hidden error item from the filter', () => {
    const tables = readFixture('closedxml-xlsx-pivottable_error_item_filter.xlsx');
    const t = tables[0]!;
    expect(t.filters).toHaveLength(1);
    expect(t.filters[0]?.field).toBe('b');
    // The #DIV/0! member (hidden via h="1") is not selected.
    expect(t.filters[0]?.selected).toEqual(['0.5', '0.6666666666666666', '0.8333333333333334']);
    // Error literals survive as strings in the records.
    expect(t.records[3]?.[1]).toBe('#DIV/0!');
  });

  it('resolves page-field item indexes through the field item list', () => {
    const tables = readFixture('closedxml-xlsx-pivottable_duplicated_member_filter.xlsx');
    const t = tables[0]!;
    // pageField item="0" → items[0] → x=0 → sharedItems[0] = blank.
    expect(t.filters).toContainEqual({ field: 'pwdLastSet', selected: ['(blank)'] });
    // Row field with h="1" members: only the visible ones are selected.
    const company = t.filters.find((f) => f.field === 'company');
    expect(company?.selected).toEqual(['First type', 'Second type']);
  });

  it('parses tabular mode (two row fields) and first-header-row anchors', () => {
    const tabular = readFixture('closedxml-xlsx-pivottable_tabular_mode.xlsx')[0]!;
    expect(tabular.rows).toHaveLength(2);
    expect(tabular.values[0]?.aggregation).toBe('count');
    const fhr = readFixture('closedxml-xlsx-pivot_table_first_header_row.xlsx')[0]!;
    expect(fhr.anchor).toMatchObject({ row: 2, col: 6, ref: 'G3:AB8' });
    expect(fhr.columns).toHaveLength(2);
  });

  it('parses a synthetic full pivot (fields, hidden items, subtotal)', () => {
    const { tables } = readPivotTables(filesOf(minimalPivotPackage({ tableInner: FULL_TABLE_INNER })));
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.name).toBe('SalesPivot');
    expect(t.fieldNames).toEqual(['Region', 'Amount']);
    expect(t.records).toEqual([
      ['East', 10],
      ['West', 20],
    ]);
    expect(t.rows).toEqual(['Region']);
    expect(t.dataOnRows).toBe(false);
    expect(t.values).toEqual([{ field: 'Amount', aggregation: 'sum', label: 'Total Amount' }]);
    expect(t.filters).toEqual([{ field: 'Region', selected: ['East'] }]);
    expect(t.anchor).toMatchObject({ row: 0, col: 3, ref: 'D1:F5' });
    expect(t.styleName).toBe('PivotStyleMedium9');
    expect(t.warning).toBeUndefined();
  });

  it('marks a pivot with a missing cache definition instead of crashing', () => {
    const { tables } = readPivotTables(filesOf(minimalPivotPackage({ noCacheDef: true })));
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.warning).toMatch(/cache.*missing/i);
    expect(t.fieldNames).toEqual([]);
    expect(t.records).toEqual([]);
  });

  it('marks a pivot with no records (saveData=0 style) instead of crashing', () => {
    const { tables } = readPivotTables(
      filesOf(minimalPivotPackage({ noRecords: true, tableInner: FULL_TABLE_INNER })),
    );
    const t = tables[0]!;
    expect(t.hasRecords).toBe(false);
    expect(t.records).toEqual([]);
    expect(t.warning).toMatch(/no pivot cache records/i);
    // The spec mapping still works — only the data is missing.
    expect(t.rows).toEqual(['Region']);
    expect(t.values[0]?.field).toBe('Amount');
  });

  it('does not warn for an external (OLAP) cache with saveData=0 and no records (#132)', () => {
    const { tables } = readPivotTables(
      filesOf(
        minimalPivotPackage({ noRecords: true, externalCache: true, tableInner: FULL_TABLE_INNER }),
      ),
    );
    const t = tables[0]!;
    expect(t.source.kind).toBe('external');
    expect(t.hasRecords).toBe(false);
    expect(t.records).toEqual([]);
    // Records never live in the file for OLAP caches — the data model is
    // the source — so no error-style warning. Data fields still parse.
    expect(t.warning).toBeUndefined();
    expect(t.rows).toEqual(['Region']);
    expect(t.values[0]?.field).toBe('Amount');
  });
});

describe('pivot round-trip', () => {
  it('re-injects pivot parts byte-for-byte on save', () => {
    const adapter = new XlsxAdapter();
    const original = new Uint8Array(
      readFileSync(REAL('closedxml-Sources-PivotTable-AllSources-input.xlsx')),
    );
    const data = adapter.read(original);
    // The adapter surfaces the parsed pivots + raw parts via metadata.
    const tables = JSON.parse(String(data.metadata[PIVOT_TABLES_METADATA_KEY]));
    expect(tables).toHaveLength(7);
    expect(data.metadata[PIVOT_PARTS_METADATA_KEY]).toBeDefined();

    const saved = adapter.write(data);
    const files = filesOf(saved);
    // Every original pivot part is back, byte-identical.
    const origFiles = filesOf(original);
    for (const path of Object.keys(origFiles)) {
      if (!path.includes('/pivotCache/') && !path.includes('/pivotTables/')) continue;
      const a = origFiles[path]!;
      const b = files[path];
      expect(b, `missing part ${path}`).toBeDefined();
      expect(b!.length).toBe(a.length);
      expect(Buffer.from(b!).equals(Buffer.from(a))).toBe(true);
    }
    // The package links the parts: content types, workbook caches, rels.
    const ct = new TextDecoder().decode(files['[Content_Types].xml']!);
    expect(ct).toContain('pivotTable+xml');
    expect(ct).toContain('pivotCacheDefinition+xml');
    expect(ct).toContain('pivotCacheRecords+xml');
    const wb = new TextDecoder().decode(files['xl/workbook.xml']!);
    expect(wb).toContain('<pivotCaches>');
    const wbRels = new TextDecoder().decode(files['xl/_rels/workbook.xml.rels']!);
    expect(wbRels).toContain('/pivotCacheDefinition');
    // Re-parsing the saved file yields the same 7 pivots.
    const reparsed = readPivotTables(files).tables;
    expect(reparsed).toHaveLength(7);
    expect(reparsed.map((t) => t.name)).toEqual(tables.map((t: { name: string }) => t.name));
  });

  it('injectPivotParts is a no-op without raw parts (never throws)', () => {
    const pkg = minimalPivotPackage({});
    expect(injectPivotParts(pkg, undefined)).toBe(pkg);
    expect(injectPivotParts(pkg, null)).toBe(pkg);
    expect(injectPivotParts(pkg, { tables: [] })).toBe(pkg);
    // And it never throws on garbage bytes.
    expect(injectPivotParts(new Uint8Array([1, 2, 3]), { tables: [] })[0]).toBe(1);
  });

  it('injects into a package that never had pivots', () => {
    const withPivots = filesOf(minimalPivotPackage({ tableInner: FULL_TABLE_INNER }));
    const { rawParts } = readPivotTables(withPivots);
    // A bare package with one sheet and no pivot parts at all.
    const bare = zipSync({
      '[Content_Types].xml': enc.encode(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="x"/></Types>`,
      ),
      'xl/workbook.xml': enc.encode(
        `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': enc.encode(
        `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': enc.encode(`<worksheet/>`),
    });
    const out = filesOf(injectPivotParts(bare, rawParts));
    expect(out['xl/pivotTables/pivotTable1.xml']).toBeDefined();
    expect(out['xl/pivotCache/pivotCacheDefinition1.xml']).toBeDefined();
    expect(out['xl/pivotCache/pivotCacheRecords1.xml']).toBeDefined();
    const wb = new TextDecoder().decode(out['xl/workbook.xml']!);
    expect(wb).toContain('<pivotCaches><pivotCache cacheId="0" r:id="rId2"/></pivotCaches>');
    const sheetRels = new TextDecoder().decode(out['xl/worksheets/_rels/sheet1.xml.rels']!);
    expect(sheetRels).toContain('../pivotTables/pivotTable1.xml');
    // The injected package re-parses to the same pivot.
    const reparsed = readPivotTables(out).tables;
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.records).toEqual([
      ['East', 10],
      ['West', 20],
    ]);
  });
});

describe('sheetId for slicer -> pivot binding (#114)', () => {
  it('carries workbook sheetIds, disambiguating bxl3way\'s two pvtCF pivots', () => {
    const tables = readFixture('beyond-excel-bxl3way.xlsx');
    const cf = tables.filter((t) => t.name === 'pvtCF');
    expect(cf).toHaveLength(2);
    const bySheet = new Map(cf.map((t) => [t.sheetName, t.sheetId]));
    // Cash Flow sheetId=5, Summaries sheetId=16 (xl/workbook.xml).
    expect(bySheet.get('Cash Flow')).toBe(5);
    expect(bySheet.get('Summaries')).toBe(16);
    const earnings = tables.find((t) => t.name === 'pvtEarnings');
    expect(earnings?.sheetName).toBe('Summaries');
    expect(earnings?.sheetId).toBe(16);
  });
});
