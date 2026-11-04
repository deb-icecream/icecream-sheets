import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import {
  CHARTS_METADATA_KEY,
  readCharts,
  serializeTrendlineXml,
  XlsxAdapter,
  type ImportedChart,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_FILE = join(HERE, '..', '..', '..', 'test-data', 'real-world', 'compressexcel-saas-3statement.xlsx');

function filesOf(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes.slice()))) out[k] = v as Uint8Array;
  return out;
}

function minimalPackage(chartTag: string, innerPrefix = ''): Uint8Array {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml':
      enc.encode(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels':
      enc.encode(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': enc.encode(`<worksheet><sheetData/></worksheet>`),
    'xl/worksheets/_rels/sheet1.xml.rels':
      enc.encode(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
    'xl/drawings/drawing1.xml':
      enc.encode(`<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></xdr:twoCellAnchor></xdr:wsDr>`),
    'xl/drawings/_rels/drawing1.xml.rels':
      enc.encode(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`),
    'xl/charts/chart1.xml':
      enc.encode(
        `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">Sales</a:t></c:rich></c:tx></c:title>` +
          `<c:plotArea><${chartTag}>${innerPrefix}<c:ser><c:tx><c:rich><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">Q1</a:t></c:rich></c:tx><c:cat><c:strRef><c:f>Data!$A$2:$A$5</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$B$2:$B$5</c:f></c:numRef></c:val></c:ser></${chartTag}></c:plotArea>` +
          `</c:chart></c:chartSpace>`,
      ),
  };
  return zipSync(files);
}

describe('readCharts', () => {
  it('extracts every chart from the real 21-sheet SaaS model (12 chart parts)', () => {
    const bytes = new Uint8Array(readFileSync(REAL_FILE));
    const charts = readCharts(filesOf(bytes));
    // 12 xl/charts/chartN.xml parts exist in the file; all must be found.
    expect(charts.length).toBe(12);
    for (const c of charts) {
      expect(typeof c.kind).toBe('string');
      expect(c.kind.length).toBeGreaterThan(0);
      expect(c.series.length).toBeGreaterThanOrEqual(1);
      expect(typeof c.sheetName).toBe('string');
      expect(c.sheetName.length).toBeGreaterThan(0);
      expect(c.anchor.fromCol).toBeGreaterThanOrEqual(0);
      expect(c.anchor.fromRow).toBeGreaterThanOrEqual(0);
      expect(c.anchor.toCol).toBeGreaterThan(c.anchor.fromCol - 1);
      expect(c.anchor.toRow).toBeGreaterThan(c.anchor.fromRow - 1);
      for (const s of c.series) {
        // Every series in this file has a plain A1 value formula.
        expect(s.valFormula).toMatch(/!/);
      }
    }
    const kinds = new Set(charts.map((c) => c.kind));
    expect(kinds.has('lineChart')).toBe(true);
    expect(kinds.has('barChart')).toBe(true);
    // Titles are real text, not empty.
    expect(charts.some((c) => c.title.length > 0)).toBe(true);
  });

  it('attaches charts to workbook metadata on read()', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(new Uint8Array(readFileSync(REAL_FILE)));
    const raw = data.metadata[CHARTS_METADATA_KEY];
    expect(typeof raw).toBe('string');
    const charts = JSON.parse(raw as string) as ImportedChart[];
    expect(charts.length).toBe(12);
  });

  it('returns [] for a package without drawings (never throws)', () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    expect(readCharts(filesOf(bytes))).toEqual([]);
    const data = adapter.read(bytes);
    expect(data.metadata[CHARTS_METADATA_KEY]).toBe('[]');
  });

  it('returns [] for corrupt input (never throws)', () => {
    expect(readCharts({})).toEqual([]);
    expect(readCharts({ 'xl/workbook.xml': new TextEncoder().encode('<broken') })).toEqual([]);
  });

  const kindCases: Array<[string, string, string?]> = [
    ['c:barChart', 'barChart'],
    ['c:barChart', 'barChart', 'bar'],
    ['c:lineChart', 'lineChart'],
    ['c:pieChart', 'pieChart'],
    ['c:areaChart', 'areaChart'],
    ['c:scatterChart', 'scatterChart'],
    ['c:doughnutChart', 'doughnutChart'],
    ['c:radarChart', 'radarChart'],
    ['c:bubbleChart', 'bubbleChart'],
    ['c:stockChart', 'stockChart'],
    ['c:surfaceChart', 'surfaceChart'],
    ['c:line3DChart', 'line3DChart'],
    ['c:bar3DChart', 'bar3DChart', 'col'],
    ['c:pie3DChart', 'pie3DChart'],
    ['c:area3DChart', 'area3DChart'],
    ['c:surface3DChart', 'surface3DChart'],
    ['c:ofPieChart', 'ofPieChart'],
  ];
  for (const [tag, wantKind, barDir] of kindCases) {
    it(`parses kind ${wantKind}${barDir ? ` (barDir=${barDir})` : ''} with series formulas and anchor`, () => {
      const pkg = minimalPackage(tag, barDir ? `<c:barDir val="${barDir}"/>` : '');
      const charts = readCharts(filesOf(pkg));
      expect(charts.length).toBe(1);
      const c = charts[0];
      expect(c.kind).toBe(wantKind);
      expect(c.sheetName).toBe('Data');
      expect(c.sheetIndex).toBe(0);
      expect(c.title).toBe('Sales');
      expect(c.series.length).toBe(1);
      expect(c.series[0].name).toBe('Q1');
      expect(c.series[0].catFormula).toBe('Data!$A$2:$A$5');
      expect(c.series[0].valFormula).toBe('Data!$B$2:$B$5');
      expect(c.anchor).toEqual({ fromCol: 1, fromRow: 2, toCol: 5, toRow: 10 });
      if (barDir) expect(c.barDir).toBe(barDir);
    });
  }

  it('reads category formulas from c:multiLvlStrRef (multi-level string refs)', () => {
    const enc = new TextEncoder();
    // Same envelope as minimalPackage(), but the series uses a
    // multi-level string reference for its categories (as written by Excel
    // for e.g. scenario charts).
    const files: Record<string, Uint8Array> = {
      'xl/workbook.xml':
        enc.encode(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels':
        enc.encode(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
      'xl/worksheets/sheet1.xml': enc.encode(`<worksheet><sheetData/></worksheet>`),
      'xl/worksheets/_rels/sheet1.xml.rels':
        enc.encode(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
      'xl/drawings/drawing1.xml':
        enc.encode(`<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></xdr:twoCellAnchor></xdr:wsDr>`),
      'xl/drawings/_rels/drawing1.xml.rels':
        enc.encode(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`),
      'xl/charts/chart1.xml':
        enc.encode(
          `<c:chartSpace><c:chart><c:plotArea><c:barChart><c:barDir val="col"/>` +
            `<c:ser><c:tx><c:rich><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">Revenue</a:t></c:rich></c:tx>` +
            `<c:cat><c:multiLvlStrRef><c:f>&apos;SCENARIO ANALYSIS&apos;!$C$7:$E$7</c:f>` +
            `<c:multiLvlStrCache><c:ptCount val="1"/>` +
            `<c:lvl><c:pt idx="0"><c:v>Upside</c:v></c:pt></c:lvl>` +
            `</c:multiLvlStrCache></c:multiLvlStrRef></c:cat>` +
            `<c:val><c:numRef><c:f>Data!$B$2:$B$5</c:f></c:numRef></c:val></c:ser>` +
            `</c:barChart></c:plotArea></c:chart></c:chartSpace>`,
        ),
    };
    const charts = readCharts(files);
    expect(charts.length).toBe(1);
    expect(charts[0].series[0].catFormula).toBe("'SCENARIO ANALYSIS'!$C$7:$E$7");
    expect(charts[0].series[0].valFormula).toBe('Data!$B$2:$B$5');
  });

  it('detects combo plot types and secondary axes from axis ids', () => {
    const enc = new TextEncoder();
    const chartXml = (barAx: string, lineAx: string) =>
      `<c:chartSpace><c:chart><c:plotArea>` +
      `<c:barChart><c:barDir val="col"/><c:ser><c:val><c:numRef><c:f>Data!$B$2:$B$5</c:f></c:numRef></c:val></c:ser><c:axId val="${barAx}"/></c:barChart>` +
      `<c:lineChart><c:ser><c:val><c:numRef><c:f>Data!$C$2:$C$5</c:f></c:numRef></c:val></c:ser><c:axId val="${lineAx}"/></c:lineChart>` +
      `</c:plotArea></c:chart></c:chartSpace>`;
    const pkgWith = (barAx: string, lineAx: string) => {
      const files = filesOf(minimalPackage('c:barChart'));
      files['xl/charts/chart1.xml'] = enc.encode(chartXml(barAx, lineAx));
      return files;
    };
    // Disjoint axis ids: the line series is on Excel's secondary axis.
    const combo = readCharts(pkgWith('111', '222'));
    expect(combo.length).toBe(1);
    expect(combo[0].plotTypes).toEqual(['barChart', 'lineChart']);
    expect(combo[0].secondaryAxis).toBe(true);
    expect(combo[0].series).toHaveLength(2);
    // Shared axis id: single-axis combo.
    const shared = readCharts(pkgWith('111', '111'));
    expect(shared[0].secondaryAxis).toBe(false);
    expect(shared[0].plotTypes).toEqual(['barChart', 'lineChart']);
    // No axis ids at all: never claim a secondary axis.
    const bareFiles = pkgWith('111', '111');
    bareFiles['xl/charts/chart1.xml'] = enc.encode(
      chartXml('111', '111').replaceAll(/<c:axId[^/]*\/>/g, ''),
    );
    const noAx = readCharts(bareFiles);
    expect(noAx[0].secondaryAxis).toBe(false);
  });

  it('reports a single plot type for ordinary charts', () => {
    const charts = readCharts(filesOf(minimalPackage('c:lineChart')));
    expect(charts.length).toBe(1);
    expect(charts[0].plotTypes).toEqual(['lineChart']);
    expect(charts[0].secondaryAxis).toBe(false);
  });

  it('resolves quoted sheet names with escaped entities in formulas', () => {    const enc = new TextEncoder();
    const pkg = minimalPackage('c:lineChart');
    // Rewrite the chart part with an escaped, quoted sheet name formula.
    const files = filesOf(pkg);
    const chart = new TextDecoder().decode(files['xl/charts/chart1.xml'])
      .replaceAll('Data!$B$2:$B$5', '&apos;My Sheet&apos;!$B$2:$B$5');
    files['xl/charts/chart1.xml'] = enc.encode(chart);
    const charts = readCharts(files);
    expect(charts[0].series[0].valFormula).toBe(`'My Sheet'!$B$2:$B$5`);
  });

  it('parses <c:pivotSource> into the pivot-table name (pivot charts)', () => {
    const enc = new TextEncoder();
    const pkg = minimalPackage('c:barChart', '<c:barDir val="col"/>');
    const files = filesOf(pkg);
    // Excel writes pivot charts with a <c:pivotSource> element in the plot
    // area and usually no per-series formulas.
    const chart = new TextDecoder().decode(files['xl/charts/chart1.xml']).replace(
      '</c:plotArea>',
      '</c:plotArea><c:pivotSource><c:name>[Wb.xlsx]Data!PivotTable1</c:name><c:fmtId val="2"/></c:pivotSource>',
    );
    files['xl/charts/chart1.xml'] = enc.encode(chart);
    const charts = readCharts(files);
    expect(charts.length).toBe(1);
    expect(charts[0].pivotSource).toBe('PivotTable1');
  });

  it('keeps the pivot-table name when the workbook/sheet carry specials', () => {
    const enc = new TextEncoder();
    const pkg = minimalPackage('c:barChart', '<c:barDir val="col"/>');
    const files = filesOf(pkg);
    const chart = new TextDecoder().decode(files['xl/charts/chart1.xml']).replace(
      '</c:plotArea>',
      '</c:plotArea><c:pivotSource><c:name>[My Wb (2).xlsx]My Sheet!pvt_Sales-2024</c:name><c:fmtId val="7"/></c:pivotSource>',
    );
    files['xl/charts/chart1.xml'] = enc.encode(chart);
    const charts = readCharts(files);
    expect(charts[0].pivotSource).toBe('pvt_Sales-2024');
  });

  it('leaves pivotSource undefined on regular charts', () => {
    const pkg = minimalPackage('c:pieChart');
    const charts = readCharts(filesOf(pkg));
    expect(charts.length).toBe(1);
    expect(charts[0].pivotSource).toBeUndefined();
  });

  it('reads the 4 real pivot charts from the BXL3Way model', () => {
    const path = join(HERE, '..', '..', '..', 'test-data', 'real-world', 'beyond-excel-bxl3way.xlsx');
    const charts = readCharts(filesOf(new Uint8Array(readFileSync(path))));
    const pivotCharts = charts.filter((c) => c.pivotSource !== undefined);
    expect(pivotCharts.length).toBe(4);
    expect(pivotCharts.map((c) => c.pivotSource).sort()).toEqual(
      ['pvtCF', 'pvtCpR', 'pvtEarnings', 'pvtYoY'],
    );
    for (const c of pivotCharts) {
      expect(c.kind).toBe('barChart');
      expect(typeof c.title).toBe('string');
    }
  });
});

describe('trendlines', () => {
  const TL_FILE = join(HERE, '..', '..', '..', 'test-data', 'real-world', 'xlsxpopulate-ranges-out.xlsx');

  it('parses the real poly trendline from xlsxpopulate-ranges-out.xlsx', () => {
    const charts = readCharts(filesOf(new Uint8Array(readFileSync(TL_FILE))));
    const withTl = charts.filter((c) => c.series.some((s) => s.trendlines.length > 0));
    expect(withTl.length).toBe(1);
    const chart = withTl[0];
    expect(chart.series).toHaveLength(2);
    expect(chart.series[0].trendlines).toEqual([]);
    const tl = chart.series[1].trendlines[0];
    expect(tl.name).toBe('CTR Trend');
    expect(tl.type).toBe('polynomial');
    expect(tl.order).toBe(2);
    expect(tl.displayEquation).toBeUndefined();
    expect(tl.displayRSquared).toBeUndefined();
  });

  it('parses all trendline options from synthetic XML', () => {
    const enc = new TextEncoder();
    const pkg = minimalPackage('c:lineChart');
    const files = filesOf(pkg);
    const xml = new TextDecoder().decode(files['xl/charts/chart1.xml']);
    const tlXml =
      '<c:trendline><c:name>My TL</c:name><c:trendlineType val="exp"/>' +
      '<c:forward val="3"/><c:backward val="1.5"/><c:intercept val="2.5"/>' +
      '<c:dispRSqr val="1"/><c:dispEq val="1"/></c:trendline>' +
      '<c:trendline><c:name>MA</c:name><c:trendlineType val="movingAvg"/><c:period val="4"/></c:trendline>' +
      '<c:trendline><c:name>??</c:name><c:trendlineType val="bogus"/></c:trendline>';
    files['xl/charts/chart1.xml'] = enc.encode(xml.replace('</c:ser>', `${tlXml}</c:ser>`));
    const charts = readCharts(files);
    const tls = charts[0].series[0].trendlines;
    // bogus type is skipped
    expect(tls).toHaveLength(2);
    expect(tls[0]).toEqual({
      name: 'My TL',
      type: 'exponential',
      forward: 3,
      backward: 1.5,
      intercept: 2.5,
      displayEquation: true,
      displayRSquared: true,
    });
    expect(tls[1]).toEqual({ name: 'MA', type: 'movingAverage', period: 4 });
  });

  it('serializeTrendlineXml round-trips through the parser', () => {
    const specs = [
      { name: 'CTR Trend', type: 'polynomial', order: 2 },
      {
        name: 'My TL',
        type: 'exponential',
        forward: 3,
        backward: 1.5,
        intercept: 2.5,
        displayEquation: true,
        displayRSquared: true,
      },
      { name: 'MA', type: 'movingAverage', period: 4 },
      { name: 'P', type: 'power' },
      { name: 'L', type: 'logarithmic' },
      { name: 'Lin', type: 'linear' },
    ] as const;
    for (const spec of specs) {
      // Parse via a synthetic package: reuse seriesTrendlines through readCharts.
      const enc = new TextEncoder();
      const pkg = minimalPackage('c:lineChart');
      const files = filesOf(pkg);
      const chartXml = new TextDecoder().decode(files['xl/charts/chart1.xml']);
      files['xl/charts/chart1.xml'] = enc.encode(
        chartXml.replace('</c:ser>', `${serializeTrendlineXml(spec)}</c:ser>`),
      );
      const back = readCharts(files)[0].series[0].trendlines[0];
      expect(back).toEqual(spec);
    }
  });

  it('serializes Excel-faithful XML for the real fixture trendline', () => {
    const xml = serializeTrendlineXml({ name: 'CTR Trend', type: 'polynomial', order: 2 });
    expect(xml).toBe(
      '<c:trendline><c:name>CTR Trend</c:name><c:trendlineType val="poly"/>' +
        '<c:order val="2"/></c:trendline>',
    );
  });
});

describe('namespace-agnostic parsing', () => {
  const DEMO = join(HERE, '..', '..', '..', 'test-data', 'real-world', 'trendline-demo.xlsx');

  it('parses default-namespace chart XML with oneCellAnchor (openpyxl-style)', () => {
    const charts = readCharts(filesOf(new Uint8Array(readFileSync(DEMO))));
    expect(charts.length).toBe(1);
    const c = charts[0];
    expect(c.kind).toBe('lineChart');
    expect(c.title).toBe('Trendline demo');
    expect(c.series).toHaveLength(2);
    expect(c.series[0].valFormula).toBe(`'Data'!$B$2:$B$9`);
    expect(c.series[1].valFormula).toBe(`'Data'!$C$2:$C$9`);
    // oneCellAnchor at E2 with an <ext> size -> derived to-cell past from-cell
    expect(c.anchor.fromCol).toBe(4);
    expect(c.anchor.fromRow).toBe(1);
    expect(c.anchor.toCol).toBeGreaterThan(c.anchor.fromCol);
    expect(c.anchor.toRow).toBeGreaterThan(c.anchor.fromRow);
    const tls = c.series.flatMap((s) => s.trendlines);
    expect(tls).toHaveLength(2);
    expect(tls[0].type).toBe('polynomial');
    expect(tls[0].order).toBe(2);
    expect(tls[0].displayEquation).toBe(true);
    expect(tls[0].displayRSquared).toBe(true);
    expect(tls[1].type).toBe('linear');
    expect(tls[1].forward).toBe(2);
  });
});

describe('trendline metadata round-trip through save', () => {
  const DEMO = join(HERE, '..', '..', '..', 'test-data', 'real-world', 'trendline-demo.xlsx');

  it('trendlines survive read -> write -> read via the metadata channel', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(new Uint8Array(readFileSync(DEMO)));
    const before = JSON.parse(data.metadata[CHARTS_METADATA_KEY] as string) as ImportedChart[];
    const tlsBefore = before.flatMap((c) => c.series.flatMap((s) => s.trendlines));
    expect(tlsBefore).toHaveLength(2);

    const saved = adapter.write(data);
    const reread = adapter.read(saved);
    const after = JSON.parse(reread.metadata[CHARTS_METADATA_KEY] as string) as ImportedChart[];
    const tlsAfter = after.flatMap((c) => c.series.flatMap((s) => s.trendlines));
    expect(tlsAfter).toEqual(tlsBefore);
    expect(tlsAfter[0]).toMatchObject({ type: 'polynomial', order: 2, displayEquation: true });
    expect(tlsAfter[1]).toMatchObject({ type: 'linear', forward: 2 });
  });
});
