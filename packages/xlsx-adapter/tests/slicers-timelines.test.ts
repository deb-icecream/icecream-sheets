import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import {
  SLICER_PARTS_METADATA_KEY,
  SLICERS_TIMELINES_METADATA_KEY,
  XlsxAdapter,
  injectSlicerTimelineParts,
  parseSlicerCacheXml,
  parseTimelineCacheXml,
  readSlicersTimelines,
  slicerCacheToXml,
  slicersTimelinesModelOf,
  timelineCacheToXml,
  type SlicersTimelinesModel,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = (name: string): string => join(HERE, '..', '..', '..', 'test-data', 'real-world', name);
const enc = new TextEncoder();
const dec = new TextDecoder();

function filesOf(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes.slice()))) out[k] = v as Uint8Array;
  return out;
}

const RELS_HEAD = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const X15 = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
const SLICER_CACHE_REL = 'http://schemas.microsoft.com/office/2007/relationships/slicerCache';
const TIMELINE_CACHE_REL = 'http://schemas.microsoft.com/office/2007/relationships/timelineCache';

/**
 * Synthetic package carrying every wave-3a part kind: a tabular slicer
 * cache, a table slicer cache, per-sheet slicer views, a timeline cache
 * (selection + bounds + pivot binding), a per-sheet timeline view at
 * months granularity, pivot-side linkage (cache-definition extLst refs +
 * the x15 timelineData marker + a pivot-table extLst ref), and drawing
 * graphic references.
 */
function syntheticFiles(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ),
    'xl/workbook.xml': enc.encode(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Dashboard" sheetId="2" r:id="rId2"/></sheets>' +
        '<pivotCaches><pivotCache cacheId="0" r:id="rId10"/><pivotCache cacheId="1" r:id="rId11"/></pivotCaches>' +
        '<extLst>' +
        `<ext uri="{BBE1A952-AA13-448e-AADC-164F8A28A991}" xmlns:x14="${X14}"><x14:slicerCaches><x14:slicerCache r:id="rId20"/></x14:slicerCaches></ext>` +
        `<ext uri="{46BE6895-7355-4a93-B00E-2C351335B9C9}" xmlns:x15="${X15}"><x15:slicerCaches xmlns:x14="${X14}"><x14:slicerCache r:id="rId21"/></x15:slicerCaches></ext>` +
        '</extLst></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': enc.encode(
      RELS_HEAD +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>' +
        '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition2.xml"/>' +
        `<Relationship Id="rId20" Type="${SLICER_CACHE_REL}" Target="slicerCaches/slicerCache1.xml"/>` +
        `<Relationship Id="rId21" Type="${SLICER_CACHE_REL}" Target="slicerCaches/slicerCache2.xml"/>` +
        `<Relationship Id="rId22" Type="${TIMELINE_CACHE_REL}" Target="timelineCaches/timelineCache1.xml"/>` +
        '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': enc.encode(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': enc.encode(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    ),
    'xl/worksheets/_rels/sheet2.xml.rels': enc.encode(
      RELS_HEAD +
        '<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2007/relationships/slicer" Target="../slicers/slicer1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2007/relationships/timeline" Target="../timelines/timeline1.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/>' +
        '</Relationships>',
    ),
    'xl/slicerCaches/slicerCache1.xml': enc.encode(
      `<slicerCacheDefinition xmlns="${X14}" name="Slicer_Region" sourceName="Region">` +
        '<pivotTables><pivotTable tabId="2" name="PivotTable1"/></pivotTables>' +
        '<data><tabular pivotCacheId="0" sortOrder="descending" customListSort="0" showMissing="1" crossFilter="showItemsWithNoData">' +
        '<items count="3"><item x="0"/><item x="2" s="1"/><item x="3" nd="1"/></items></tabular></data>' +
        '</slicerCacheDefinition>',
    ),
    'xl/slicerCaches/slicerCache2.xml': enc.encode(
      `<slicerCacheDefinition xmlns="${X14}" name="Slicer_Type" sourceName="Type">` +
        `<extLst><ext uri="{2F2917AC-EB37-4324-AD4E-5DD8C200BD13}" xmlns:x15="${X15}"><x15:tableSlicerCache tableId="7" column="2"/></ext></extLst>` +
        '</slicerCacheDefinition>',
    ),
    'xl/slicers/slicer1.xml': enc.encode(
      `<slicers xmlns="${X14}">` +
        '<slicer name="slcRegion" cache="Slicer_Region" caption="Region" startItem="0" columnCount="2" rowHeight="200000"/>' +
        '<slicer name="slcType" cache="Slicer_Type" caption="Type" showCaption="0" lockedPosition="1" style="SlicerStyleLight2"/>' +
        '</slicers>',
    ),
    'xl/timelineCaches/timelineCache1.xml': enc.encode(
      `<timelineCacheDefinition xmlns="${X15}" name="Timeline_OrderDate" sourceName="OrderDate">` +
        '<pivotTables><pivotTable tabId="2" name="PivotTable1"/></pivotTables>' +
        '<state singleRangeFilterState="1" minimalRefreshVersion="6" lastRefreshVersion="6" pivotCacheId="1" filterType="dateAll">' +
        '<selection startDate="2023-03-01T00:00:00" endDate="2023-06-30T00:00:00"/>' +
        '<bounds startDate="2023-01-01T00:00:00" endDate="2023-12-31T00:00:00"/>' +
        '</state></timelineCacheDefinition>',
    ),
    'xl/timelines/timeline1.xml': enc.encode(
      `<timelines xmlns="${X15}">` +
        '<timeline name="tlOrderDate" cache="Timeline_OrderDate" caption="Order Date" showHeader="1" showSelectionLabel="1" showTimeLevel="1" showHorizontalScrollbar="0" level="months" selectionLevel="months" scrollingPosition="2023-01-01T00:00:00" style="TimeSlicerStyleLight1"/>' +
        '</timelines>',
    ),
    // Pivot cache 0: extLst carries a slicerCache relationship reference
    // (the pivotCacheDefinition-side linkage form) resolved via its .rels.
    'xl/pivotCache/pivotCacheDefinition1.xml': enc.encode(
      '<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" recordCount="0">' +
        '<cacheSource type="worksheet"><worksheetSource ref="A1:B4" sheet="Data"/></cacheSource><cacheFields count="0"/>' +
        `<extLst><ext uri="{725AE2AE-9491-48be-B2B4-4EB974FC191F}" xmlns:x14="${X14}"><x14:pivotCacheDefinition><x14:slicerCaches><x14:slicerCache r:id="rId5"/></x14:slicerCaches></x14:pivotCacheDefinition></ext></extLst>` +
        '</pivotCacheDefinition>',
    ),
    'xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels': enc.encode(
      RELS_HEAD +
        `<Relationship Id="rId5" Type="${SLICER_CACHE_REL}" Target="../slicerCaches/slicerCache1.xml"/>` +
        '</Relationships>',
    ),
    // Pivot cache 1: x15 timelinePivotCacheDefinition marker.
    'xl/pivotCache/pivotCacheDefinition2.xml': enc.encode(
      '<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" recordCount="0">' +
        '<cacheSource type="worksheet"><worksheetSource ref="A1:B4" sheet="Data"/></cacheSource><cacheFields count="0"/>' +
        `<extLst><ext uri="{BDD0DD68-6234-4B4C-9B7B-2A9B1D3B0001}" xmlns:x15="${X15}"><x15:timelinePivotCacheDefinition timelineData="1"/></ext></extLst>` +
        '</pivotCacheDefinition>',
    ),
    'xl/pivotTables/pivotTable1.xml': enc.encode(
      '<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="PivotTable1" cacheId="0">' +
        '<location ref="A1" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>' +
        `<extLst><ext uri="{962EF5D1-5CA2-4c93-8EF4-DBF5C05439D2}" xmlns:x14="${X14}"><x14:pivotTableDefinition><x14:slicerCaches><x14:slicerCache r:id="rId9"/></x14:slicerCaches></x14:pivotTableDefinition></ext></extLst>` +
        '</pivotTableDefinition>',
    ),
    'xl/pivotTables/_rels/pivotTable1.xml.rels': enc.encode(
      RELS_HEAD +
        `<Relationship Id="rId9" Type="${SLICER_CACHE_REL}" Target="../slicerCaches/slicerCache1.xml"/>` +
        '</Relationships>',
    ),
    'xl/drawings/drawing1.xml': enc.encode(
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="slcRegion"/></xdr:nvGraphicFramePr>' +
        '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2010/slicer"><sle:slicer xmlns:sle="http://schemas.microsoft.com/office/drawing/2010/slicer" name="slcRegion"/></a:graphicData></a:graphic></xdr:graphicFrame>' +
        '<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="tlOrderDate"/></xdr:nvGraphicFramePr>' +
        '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2012/timeslicer"><tsle:timeline xmlns:tsle="http://schemas.microsoft.com/office/drawing/2012/timeslicer" name="tlOrderDate"/></a:graphicData></a:graphic></xdr:graphicFrame>' +
        '</xdr:wsDr>',
    ),
  };
  return files;
}

/** A SheetJS-style output package: same sheets, NO slicer/timeline wiring at all. */
function barePackageFiles(): Record<string, Uint8Array> {
  return {
    '[Content_Types].xml': enc.encode(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ),
    'xl/workbook.xml': enc.encode(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Dashboard" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': enc.encode(
      RELS_HEAD +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': enc.encode(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': enc.encode(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    ),
  };
}

function coreModel(m: SlicersTimelinesModel): Omit<SlicersTimelinesModel, 'linkage' | 'drawingRefs'> {
  return {
    slicerCaches: m.slicerCaches,
    sheetSlicers: m.sheetSlicers,
    timelineCaches: m.timelineCaches,
    sheetTimelines: m.sheetTimelines,
  };
}

describe('readSlicersTimelines (synthetic package)', () => {
  const result = readSlicersTimelines(syntheticFiles());
  const model = slicersTimelinesModelOf(result);

  it('parses the tabular slicer cache: source, pivot binding, items, selection state', () => {
    const cache = result.slicerCaches.find((c) => c.name === 'Slicer_Region');
    expect(cache).toBeDefined();
    expect(cache!.sourceName).toBe('Region');
    expect(cache!.registry).toBe('x14');
    expect(cache!.pivotTables).toEqual([{ tabId: 2, name: 'PivotTable1' }]);
    expect(cache!.data).toEqual({
      kind: 'tabular',
      pivotCacheId: 0,
      sortOrder: 'descending',
      customListSort: false,
      showMissing: true,
      crossFilter: 'showItemsWithNoData',
      items: [
        { index: 0 },
        { index: 2, selected: true },
        { index: 3, nonDisplay: true },
      ],
    });
  });

  it('parses the table slicer cache from its x15 extension', () => {
    const cache = result.slicerCaches.find((c) => c.name === 'Slicer_Type');
    expect(cache).toBeDefined();
    expect(cache!.registry).toBe('x15');
    expect(cache!.data).toEqual({ kind: 'table', tableId: 7, column: 2 });
  });

  it('parses per-sheet slicer views bound to caches by name', () => {
    expect(result.sheetSlicers).toHaveLength(1);
    const ss = result.sheetSlicers[0]!;
    expect(ss.sheetName).toBe('Dashboard');
    expect(ss.slicers).toEqual([
      { name: 'slcRegion', cache: 'Slicer_Region', caption: 'Region', startItem: 0, columnCount: 2, rowHeight: 200000 },
      { name: 'slcType', cache: 'Slicer_Type', caption: 'Type', showCaption: false, lockedPosition: true, style: 'SlicerStyleLight2' },
    ]);
  });

  it('parses the timeline cache: pivot binding, bounds, selected range', () => {
    expect(result.timelineCaches).toHaveLength(1);
    const tc = result.timelineCaches[0]!;
    expect(tc.name).toBe('Timeline_OrderDate');
    expect(tc.sourceName).toBe('OrderDate');
    expect(tc.pivotTables).toEqual([{ tabId: 2, name: 'PivotTable1' }]);
    expect(tc.state).toEqual({
      pivotCacheId: 1,
      filterType: 'dateAll',
      minimalRefreshVersion: 6,
      lastRefreshVersion: 6,
      singleRangeFilterState: true,
      selection: { startDate: '2023-03-01T00:00:00', endDate: '2023-06-30T00:00:00' },
      bounds: { startDate: '2023-01-01T00:00:00', endDate: '2023-12-31T00:00:00' },
    });
  });

  it('parses the per-sheet timeline view with its granularity level', () => {
    expect(result.sheetTimelines).toHaveLength(1);
    const st = result.sheetTimelines[0]!;
    expect(st.sheetName).toBe('Dashboard');
    expect(st.timelines).toEqual([
      {
        name: 'tlOrderDate',
        cache: 'Timeline_OrderDate',
        caption: 'Order Date',
        showHeader: true,
        showSelectionLabel: true,
        showTimeLevel: true,
        showHorizontalScrollbar: false,
        level: 'months',
        selectionLevel: 'months',
        scrollingPosition: '2023-01-01T00:00:00',
        style: 'TimeSlicerStyleLight1',
      },
    ]);
  });

  it('resolves pivot linkage: cache-side bindings, def extLst refs, timelineData marker, table extLst refs', () => {
    const byId = new Map(model.linkage.caches.map((l) => [l.cacheId, l]));
    expect(byId.get(0)?.slicerCacheNames).toEqual(['Slicer_Region']);
    expect(byId.get(0)?.timelineCacheNames).toEqual([]);
    expect(byId.get(1)?.timelineCacheNames).toEqual(['Timeline_OrderDate']);
    expect(byId.get(1)?.timelineData).toBe(true);
    expect(model.linkage.tables).toEqual([
      { tablePath: 'xl/pivotTables/pivotTable1.xml', pivotTableName: 'PivotTable1', slicerCacheNames: ['Slicer_Region'] },
    ]);
  });

  it('captures drawing graphic references to slicer/timeline views', () => {
    expect(model.drawingRefs).toEqual([
      { partPath: 'xl/drawings/drawing1.xml', kind: 'slicer', name: 'slcRegion' },
      { partPath: 'xl/drawings/drawing1.xml', kind: 'timeline', name: 'tlOrderDate' },
    ]);
  });

  it('round-trips per part: parse → serialize → parse is the identity', () => {
    for (const cache of result.slicerCaches) {
      const again = parseSlicerCacheXml(slicerCacheToXml(cache), cache.partPath);
      expect(again).toEqual(cache);
    }
    for (const cache of result.timelineCaches) {
      const again = parseTimelineCacheXml(timelineCacheToXml(cache), cache.partPath);
      expect(again).toEqual(cache);
    }
  });

  it('regenerates every part into a bare package and re-reads an identical model', () => {
    const out = injectSlicerTimelineParts(zipSync(barePackageFiles()), JSON.stringify(model), result.rawParts);
    const files = filesOf(out);
    // Parts + wiring all landed.
    expect(files['xl/slicerCaches/slicerCache1.xml']).toBeDefined();
    expect(files['xl/slicerCaches/slicerCache2.xml']).toBeDefined();
    expect(files['xl/slicers/slicer1.xml']).toBeDefined();
    expect(files['xl/timelineCaches/timelineCache1.xml']).toBeDefined();
    expect(files['xl/timelines/timeline1.xml']).toBeDefined();
    const ct = dec.decode(files['[Content_Types].xml']!);
    expect(ct).toContain('application/vnd.ms-excel.slicerCache+xml');
    expect(ct).toContain('application/vnd.ms-excel.slicer+xml');
    expect(ct).toContain('application/vnd.ms-excel.timelineCache+xml');
    expect(ct).toContain('application/vnd.ms-excel.timeline+xml');
    const wbRels = dec.decode(files['xl/_rels/workbook.xml.rels']!);
    expect(wbRels).toContain('slicerCaches/slicerCache1.xml');
    expect(wbRels).toContain('timelineCaches/timelineCache1.xml');
    const wb = dec.decode(files['xl/workbook.xml']!);
    expect(wb).toContain('{BBE1A952-AA13-448e-AADC-164F8A28A991}');
    expect(wb).toContain('{46BE6895-7355-4a93-B00E-2C351335B9C9}');
    const sheetRels = dec.decode(files['xl/worksheets/_rels/sheet2.xml.rels']!);
    expect(sheetRels).toContain('../slicers/slicer1.xml');
    expect(sheetRels).toContain('../timelines/timeline1.xml');
    // Model identity after the full package round-trip.
    const reread = slicersTimelinesModelOf(readSlicersTimelines(files));
    expect(coreModel(reread)).toEqual(coreModel(model));
  });

  it('full-package round-trip preserves the model including pivot linkage', () => {
    const out = injectSlicerTimelineParts(zipSync(syntheticFiles()), JSON.stringify(model), result.rawParts);
    const reread = slicersTimelinesModelOf(readSlicersTimelines(filesOf(out)));
    expect(reread).toEqual(model);
  });

  it('is a no-op on packages without slicer/timeline data', () => {
    const bare = zipSync(barePackageFiles());
    const empty = readSlicersTimelines(filesOf(bare));
    expect(empty.slicerCaches).toEqual([]);
    expect(empty.timelineCaches).toEqual([]);
    expect(injectSlicerTimelineParts(bare, undefined, undefined)).toBe(bare);
    expect(injectSlicerTimelineParts(bare, '{"slicerCaches":[]}', null)).toBe(bare);
    expect(readSlicersTimelines({}).slicerCaches).toEqual([]);
  });
});

describe('real Excel file (beyond-excel-bxl3way.xlsx)', () => {
  const bytes = new Uint8Array(readFileSync(REAL('beyond-excel-bxl3way.xlsx')));
  const result = readSlicersTimelines(filesOf(bytes));
  const model = slicersTimelinesModelOf(result);

  it('parses the OLAP slicer cache: levels, ranges, items, selections, pivot tables', () => {
    const cache = result.slicerCaches.find((c) => c.name === 'Slicer_Year');
    expect(cache).toBeDefined();
    expect(cache!.uid).toBe('{C3332FE2-FBAF-438E-81D7-8402056A605D}');
    expect(cache!.sourceName).toBe('[tblCal].[Year]');
    expect(cache!.registry).toBe('x14');
    expect(cache!.pivotTables).toEqual([
      { tabId: 16, name: 'pvtEarnings' },
      { tabId: 16, name: 'pvtCF' },
      { tabId: 16, name: 'pvtYoY' },
      { tabId: 16, name: 'pvtCpR' },
    ]);
    expect(cache!.data?.kind).toBe('olap');
    if (cache!.data?.kind !== 'olap') throw new Error('expected olap');
    expect(cache!.data.pivotCacheId).toBe(219062112);
    expect(cache!.data.levels).toHaveLength(2);
    expect(cache!.data.levels[0]).toEqual({
      uniqueName: '[tblCal].[Year].[(All)]',
      sourceCaption: '(All)',
      count: 0,
      ranges: [],
    });
    const year = cache!.data.levels[1]!;
    expect(year.uniqueName).toBe('[tblCal].[Year].[Year]');
    expect(year.count).toBe(10);
    expect(year.ranges).toHaveLength(1);
    expect(year.ranges[0]!.startItem).toBe(0);
    expect(year.ranges[0]!.items).toHaveLength(10);
    expect(year.ranges[0]!.items[0]).toEqual({ name: '[tblCal].[Year].&[2012]', caption: '2012' });
    expect(year.ranges[0]!.items[9]).toEqual({ name: '[tblCal].[Year].&[2021]', caption: '2021' });
    expect(cache!.data.selections).toEqual([{ name: '[tblCal].[Year].[All]', ranges: [] }]);
  });

  it('parses the table slicer cache and both per-sheet views', () => {
    const table = result.slicerCaches.find((c) => c.name === 'Slicer_Type');
    expect(table).toBeDefined();
    expect(table!.registry).toBe('x15');
    expect(table!.data).toEqual({ kind: 'table', tableId: 16, column: 2 });
    const byView = new Map<string, string>();
    for (const ss of result.sheetSlicers) for (const v of ss.slicers) byView.set(v.name, ss.sheetName);
    expect(byView.get('slcType')).toBe('TOC');
    expect(byView.get('slcYear')).toBe('Dashboard');
    const year = result.sheetSlicers.flatMap((s) => s.slicers).find((v) => v.name === 'slcYear');
    expect(year).toEqual({
      name: 'slcYear',
      uid: '{24B930FE-5FF8-4723-A0FF-6A5DC72855F7}',
      cache: 'Slicer_Year',
      caption: 'Year',
      level: 1,
      rowHeight: 234950,
    });
  });

  it('captures the drawing references for both slicer views', () => {
    const names = result.drawingRefs.filter((r) => r.kind === 'slicer').map((r) => r.name);
    expect(names).toContain('slcYear');
    expect(names).toContain('slcType');
  });

  it('round-trips per part: parse → serialize → parse is the identity', () => {
    for (const cache of result.slicerCaches) {
      const again = parseSlicerCacheXml(slicerCacheToXml(cache), cache.partPath);
      expect(again).toEqual(cache);
    }
  });

  it('regenerates into a bare package and re-reads an identical core model', () => {
    const bare = barePackageFiles();
    // Same sheet names AND positions as the real file (TOC is sheet #3,
    // Dashboard #12) so sheetIndex values line up after the round-trip.
    const names = ['FMTs', 'Cover', 'TOC', 'Constants', 'Imports', 'Inputs', 'Calcs', 'Income', 'Cash Flow', 'Balance', 'Summaries', 'Dashboard', 'CHKs'];
    const sheetsXml = names
      .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('');
    const relsXml = names
      .map(
        (n, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('');
    bare['xl/workbook.xml'] = enc.encode(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${sheetsXml}</sheets></workbook>`,
    );
    bare['xl/_rels/workbook.xml.rels'] = enc.encode(RELS_HEAD + relsXml + '</Relationships>');
    const out = injectSlicerTimelineParts(zipSync(bare), JSON.stringify(model), result.rawParts);
    const reread = slicersTimelinesModelOf(readSlicersTimelines(filesOf(out)));
    expect(coreModel(reread)).toEqual(coreModel(model));
  });

  it('flows through XlsxAdapter metadata and survives adapter write()', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(bytes);
    const raw = data.metadata[SLICERS_TIMELINES_METADATA_KEY];
    expect(typeof raw).toBe('string');
    const parsed = JSON.parse(raw as string) as SlicersTimelinesModel;
    expect(parsed.slicerCaches.map((c) => c.name).sort()).toEqual(['Slicer_Type', 'Slicer_Year']);
    expect(data.metadata[SLICER_PARTS_METADATA_KEY]).toBeDefined();

    const saved = adapter.write(data);
    const reread = slicersTimelinesModelOf(readSlicersTimelines(filesOf(saved)));
    expect(coreModel(reread)).toEqual(coreModel(model));
  });
});
