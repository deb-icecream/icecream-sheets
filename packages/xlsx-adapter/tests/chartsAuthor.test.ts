import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import {
  authorChartParts,
  buildChartXml,
  injectChartParts,
  readCharts,
  type ChartAuthorSpec,
  type ChartCellResolver,
} from '../src/index.js';

const ENC = new TextEncoder();

function filesOf(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes.slice()))) out[k] = v as Uint8Array;
  return out;
}

const VALUES: Record<string, { text: string; num: number | null }> = {
  '1:0': { text: 'Q1', num: null },
  '2:0': { text: 'Q2', num: null },
  '3:0': { text: 'Q3', num: null },
  '4:0': { text: 'Q4', num: null },
  '1:1': { text: '', num: 10 },
  '2:1': { text: '', num: 20 },
  '3:1': { text: '', num: 30 },
  '4:1': { text: '', num: 40 },
  '0:1': { text: 'Sales', num: null },
};

const resolveCell: ChartCellResolver = (_sheet, row, col) => VALUES[`${row}:${col}`] ?? { text: '', num: null };

/** Package with one "Data" sheet and NO drawing/chart parts. */
function barePackage(): Record<string, Uint8Array> {
  return {
    '[Content_Types].xml': ENC.encode(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    ),
    '_rels/.rels': ENC.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': ENC.encode(
      `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': ENC.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': ENC.encode(
      `<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Sales</t></is></c></row></sheetData></worksheet>`,
    ),
  };
}

function zipOf(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

const columnSpec: ChartAuthorSpec = {
  id: 42,
  kind: 'column-clustered',
  title: 'Sales by Quarter',
  range: { sheet: 'Data', startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
  seriesRanges: [
    {
      name: 'Sales',
      cat: { sheet: 'Data', startRow: 1, startCol: 0, endRow: 4, endCol: 0 },
      val: { sheet: 'Data', startRow: 1, startCol: 1, endRow: 4, endCol: 1 },
    },
  ],
  anchorCells: { fromCol: 3, fromRow: 1, toCol: 11, toRow: 16 },
};

describe('authorChartParts (files-map path)', () => {
  it('authors a native chart part that the REAL parser reads back (kind/title/series/anchor)', () => {
    const files = barePackage();
    const result = authorChartParts(files, [columnSpec], { resolveCell });
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.chartPaths).toEqual(['xl/charts/chart1.xml']);
    // Package surgery landed: chart + drawing + rels + content types + sheet <drawing>.
    expect(files['xl/drawings/drawing1.xml']).toBeDefined();
    expect(files['xl/drawings/_rels/drawing1.xml.rels']).toBeDefined();
    expect(files['xl/worksheets/_rels/sheet1.xml.rels']).toBeDefined();
    const ct = new TextDecoder().decode(files['[Content_Types].xml']);
    expect(ct).toContain('PartName="/xl/charts/chart1.xml"');
    expect(ct).toContain('PartName="/xl/drawings/drawing1.xml"');
    const sheetXml = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
    expect(sheetXml).toContain('<drawing r:id=');
    expect(result.drawingRidBySheet.get('Data')).toBeDefined();

    const charts = readCharts(files);
    expect(charts.length).toBe(1);
    const c = charts[0]!;
    expect(c.kind).toBe('barChart');
    expect(c.barDir).toBe('col');
    expect(c.title).toBe('Sales by Quarter');
    expect(c.sheetName).toBe('Data');
    expect(c.series.length).toBe(1);
    expect(c.series[0]!.name).toBe('Sales');
    expect(c.series[0]!.catFormula).toBe('Data!$A$2:$A$5');
    expect(c.series[0]!.valFormula).toBe('Data!$B$2:$B$5');
    expect(c.series[0]!.catCache).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(c.series[0]!.valCache).toEqual([10, 20, 30, 40]);
    expect(c.anchor).toEqual({ fromCol: 3, fromRow: 1, toCol: 11, toRow: 16 });
  });

  it('round-trips every authorable kind through the real parser', () => {
    const cases: Array<[string, string, string | undefined]> = [
      ['column-clustered', 'barChart', 'col'],
      ['column-stacked', 'barChart', 'col'],
      ['bar-clustered', 'barChart', 'bar'],
      ['line', 'lineChart', undefined],
      ['line-markers', 'lineChart', undefined],
      ['area', 'areaChart', undefined],
      ['pie', 'pieChart', undefined],
      ['doughnut', 'doughnutChart', undefined],
    ];
    for (const [kind, wantKind, wantDir] of cases) {
      const files = barePackage();
      const result = authorChartParts(files, [{ ...columnSpec, kind }], { resolveCell });
      expect(result.added).toBe(1);
      const charts = readCharts(files);
      expect(charts.length, kind).toBe(1);
      expect(charts[0]!.kind, kind).toBe(wantKind);
      expect(charts[0]!.barDir, kind).toBe(wantDir);
      expect(charts[0]!.title, kind).toBe('Sales by Quarter');
      expect(charts[0]!.series[0]!.valFormula, kind).toBe('Data!$B$2:$B$5');
    }
    // Stacked grouping + doughnut holeSize are in the emitted XML.
    const stacked = buildChartXml(
      { ...columnSpec, kind: 'column-stacked' },
      [{ name: 'Sales', valFormula: 'Data!$B$2:$B$5', valValues: [1] }],
    );
    expect(stacked).toContain('<c:grouping val="stacked"/>');
    const doughnut = buildChartXml(
      { ...columnSpec, kind: 'doughnut' },
      [{ name: 'Sales', valFormula: 'Data!$B$2:$B$5', valValues: [1] }],
    );
    expect(doughnut).toContain('<c:holeSize val="50"/>');
  });

  it('appends to an EXISTING drawing part instead of creating a second one', () => {
    const files = barePackage();
    authorChartParts(files, [columnSpec], { resolveCell });
    const second: ChartAuthorSpec = {
      ...columnSpec,
      id: 43,
      kind: 'line',
      title: 'Second Chart',
      anchorCells: { fromCol: 3, fromRow: 18, toCol: 11, toRow: 33 },
    };
    const result = authorChartParts(files, [second], { resolveCell });
    expect(result.added).toBe(1);
    expect(result.chartPaths).toEqual(['xl/charts/chart2.xml']);
    const drawingPaths = Object.keys(files).filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p));
    expect(drawingPaths).toEqual(['xl/drawings/drawing1.xml']);
    const drawingXml = new TextDecoder().decode(files['xl/drawings/drawing1.xml']);
    expect(drawingXml.match(/<xdr:twoCellAnchor>/g)?.length).toBe(2);
    const charts = readCharts(files);
    expect(charts.length).toBe(2);
    expect(charts.map((c) => c.title).sort()).toEqual(['Sales by Quarter', 'Second Chart']);
  });

  it('dedups a spec that already exists as a native part (no duplicate chartN)', () => {
    const files = barePackage();
    authorChartParts(files, [columnSpec], { resolveCell });
    const again = authorChartParts(files, [columnSpec], { resolveCell });
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
    expect(Object.keys(files).filter((p) => p.startsWith('xl/charts/'))).toEqual(['xl/charts/chart1.xml']);
    expect(readCharts(files).length).toBe(1);
  });

  it('fails closed on non-authorable kinds BEFORE mutating the package', () => {
    const files = barePackage();
    const before = Object.keys(files).sort();
    expect(() => authorChartParts(files, [{ ...columnSpec, kind: 'scatter' }], { resolveCell })).toThrow(
      /not authorable/,
    );
    expect(Object.keys(files).sort()).toEqual(before);
    expect(() => buildChartXml({ ...columnSpec, kind: 'combo-column-line' }, [{ name: 'x', valFormula: 'Data!$B$2' }])).toThrow(
      /not authorable/,
    );
  });

  it('derives series from the plain range (Excel layout) when seriesRanges are absent', () => {
    const files = barePackage();
    const spec: ChartAuthorSpec = {
      kind: 'column-clustered',
      title: 'Derived',
      range: { sheet: 'Data', startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
    };
    authorChartParts(files, [spec], { resolveCell });
    const charts = readCharts(files);
    expect(charts.length).toBe(1);
    expect(charts[0]!.series[0]!.catFormula).toBe('Data!$A$2:$A$5');
    expect(charts[0]!.series[0]!.valFormula).toBe('Data!$B$2:$B$5');
    expect(charts[0]!.series[0]!.name).toBe('Sales');
    // Default anchor: below the data, 8 cols × 15 rows.
    expect(charts[0]!.anchor).toEqual({ fromCol: 0, fromRow: 6, toCol: 8, toRow: 21 });
  });
});

describe('injectChartParts (sourceBytes zip-surgery path)', () => {
  it('authors a chart into package bytes that readCharts parses back', () => {
    const bytes = zipOf(barePackage());
    const out = injectChartParts(bytes, [columnSpec], { resolveCell });
    expect(out).not.toBe(bytes);
    const charts = readCharts(filesOf(out));
    expect(charts.length).toBe(1);
    expect(charts[0]!.kind).toBe('barChart');
    expect(charts[0]!.title).toBe('Sales by Quarter');
    expect(charts[0]!.series[0]!.valCache).toEqual([10, 20, 30, 40]);
  });

  it('is idempotent: injecting the same spec twice yields the input bytes unchanged the second time', () => {
    const once = injectChartParts(zipOf(barePackage()), [columnSpec], { resolveCell });
    const twice = injectChartParts(once, [columnSpec], { resolveCell });
    expect(twice).toBe(once);
    expect(readCharts(filesOf(twice)).length).toBe(1);
  });

  it('never throws: unsupported kinds and corrupt bytes return the input unchanged', () => {
    const bytes = zipOf(barePackage());
    expect(injectChartParts(bytes, [{ ...columnSpec, kind: 'scatter' }], { resolveCell })).toBe(bytes);
    const junk = new Uint8Array([1, 2, 3]);
    expect(injectChartParts(junk, [columnSpec], { resolveCell })).toBe(junk);
    expect(injectChartParts(bytes, [], { resolveCell })).toBe(bytes);
  });
});
