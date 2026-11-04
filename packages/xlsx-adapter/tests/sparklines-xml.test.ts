/**
 * Wave-2 slice D (audit §4.3): native sparkline round-trip —
 * worksheet `<extLst>` → `<x14:sparklineGroups>` ([MS-XLSX] §2.3.2).
 *
 * Every test round-trips REAL native OOXML: either a hand-built source
 * package the way Excel writes it (x14 extension in <extLst>, xm:f /
 * xm:sqref refs, theme/tint + rgb colors), parsed by XlsxAdapter.read,
 * or a model written by XlsxAdapter.write whose sheet XML is asserted
 * directly and then read back to the identical model.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { WorkbookData } from '@icecream-sheets/engine';
import {
  SPARKLINE_GROUPS_EXT_URI,
  XlsxAdapter,
  parseSparklineGroups,
  sheetXmlChunks,
  sparklineExtLstXml,
  sparklineGroupsToXml,
  spliceSparklineGroups,
  type SparklineGroup,
  type SheetDataWithNativeFeatures,
} from '../src/index.js';

const dec = new TextDecoder();
const adapter = new XlsxAdapter();

function partText(bytes: Uint8Array, path: string): string {
  const parts = unzipSync(bytes.slice());
  const raw = parts[path];
  return raw ? dec.decode(raw) : '';
}

function dataSheet(data: WorkbookData): SheetDataWithNativeFeatures {
  return data.sheets[0] as SheetDataWithNativeFeatures;
}

/* ------------------------------------------------------------------ */
/* Hand-built native source package (as Excel writes sparklines)       */
/* ------------------------------------------------------------------ */

const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM = 'http://schemas.microsoft.com/office/excel/2006/main';

const EXCEL_EXT_LST =
  `<extLst><ext uri="${SPARKLINE_GROUPS_EXT_URI}" xmlns:x14="${X14}">` +
  `<x14:sparklineGroups xmlns:xm="${XM}">` +
  // Group 1 — line, every switch + color + custom axis set.
  '<x14:sparklineGroup type="line" lineWeight="1.25" displayEmptyCellsAs="span" ' +
  'markers="1" high="1" low="1" first="1" last="1" negative="1" displayXAxis="1" ' +
  'displayHidden="1" minAxisType="custom" maxAxisType="custom" manualMin="-5" manualMax="15">' +
  '<x14:colorSeries theme="4" tint="-0.499984740745262"/>' +
  '<x14:colorNegative rgb="FFFF0000"/>' +
  '<x14:colorAxis theme="1"/>' +
  '<x14:colorMarkers theme="4" tint="-0.499984740745262"/>' +
  '<x14:colorFirst rgb="FF00B050"/>' +
  '<x14:colorLast rgb="FF0070C0"/>' +
  '<x14:colorHigh rgb="FF00B050"/>' +
  '<x14:colorLow rgb="FFFF0000"/>' +
  '<x14:sparklines>' +
  '<x14:sparkline><xm:f>Data!A1:E1</xm:f><xm:sqref>F1</xm:sqref></x14:sparkline>' +
  '<x14:sparkline><xm:f>Data!A2:E2</xm:f><xm:sqref>F2</xm:sqref></x14:sparkline>' +
  '</x14:sparklines></x14:sparklineGroup>' +
  // Group 2 — column, group-scaled axis, rgb series + theme negative.
  '<x14:sparklineGroup type="column" displayHidden="1" minAxisType="group" maxAxisType="group">' +
  '<x14:colorSeries rgb="FF548235"/>' +
  '<x14:colorNegative theme="9"/>' +
  '<x14:sparklines>' +
  '<x14:sparkline><xm:f>Data!A3:E3</xm:f><xm:sqref>F3</xm:sqref></x14:sparkline>' +
  '</x14:sparklines></x14:sparklineGroup>' +
  // Group 3 — stacked (win/loss), negative points + axis shown.
  '<x14:sparklineGroup type="stacked" negative="1" displayXAxis="1">' +
  '<x14:colorSeries theme="5"/>' +
  '<x14:colorNegative rgb="FFC00000"/>' +
  '<x14:sparklines>' +
  '<x14:sparkline><xm:f>Data!A4:E4</xm:f><xm:sqref>F4</xm:sqref></x14:sparkline>' +
  '</x14:sparklines></x14:sparklineGroup>' +
  // Group 4 — date-axis line group: the group-level <xm:f> is the date range.
  '<x14:sparklineGroup type="line" dateAxis="1" markers="1">' +
  '<x14:colorSeries theme="4"/>' +
  '<xm:f>Data!A5:E5</xm:f>' +
  '<x14:sparklines>' +
  '<x14:sparkline><xm:f>Data!A6:E6</xm:f><xm:sqref>F6</xm:sqref></x14:sparkline>' +
  '</x14:sparklines></x14:sparklineGroup>' +
  '</x14:sparklineGroups></ext></extLst>';

const EXPECTED_GROUPS: SparklineGroup[] = [
  {
    type: 'line',
    lineWeight: 1.25,
    displayEmptyCellsAs: 'span',
    markers: { show: true, high: true, low: true, first: true, last: true, negative: true },
    axis: { show: true, minType: 'custom', maxType: 'custom', manualMin: -5, manualMax: 15 },
    displayHidden: true,
    seriesColor: { theme: 4, tint: -0.499984740745262 },
    negativeColor: { rgb: 'FFFF0000' },
    axisColor: { theme: 1 },
    markersColor: { theme: 4, tint: -0.499984740745262 },
    firstColor: { rgb: 'FF00B050' },
    lastColor: { rgb: 'FF0070C0' },
    highColor: { rgb: 'FF00B050' },
    lowColor: { rgb: 'FFFF0000' },
    sparklines: [
      { dataRef: 'Data!A1:E1', targetRef: 'F1' },
      { dataRef: 'Data!A2:E2', targetRef: 'F2' },
    ],
  },
  {
    type: 'column',
    axis: { minType: 'group', maxType: 'group' },
    displayHidden: true,
    seriesColor: { rgb: 'FF548235' },
    negativeColor: { theme: 9 },
    sparklines: [{ dataRef: 'Data!A3:E3', targetRef: 'F3' }],
  },
  {
    type: 'stacked',
    markers: { negative: true },
    axis: { show: true },
    seriesColor: { theme: 5 },
    negativeColor: { rgb: 'FFC00000' },
    sparklines: [{ dataRef: 'Data!A4:E4', targetRef: 'F4' }],
  },
  {
    type: 'line',
    markers: { show: true },
    dateAxis: true,
    dateRef: 'Data!A5:E5',
    seriesColor: { theme: 4 },
    sparklines: [{ dataRef: 'Data!A6:E6', targetRef: 'F6' }],
  },
];

function sourcePackage(tailAfterData: string): Uint8Array {
  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    `xmlns:x14="${X14}" mc:Ignorable="x14">` +
    '<dimension ref="A1:F6"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>' +
    '<sheetData>' +
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c><c r="D1"><v>2</v></c><c r="E1"><v>5</v></c></row>' +
    '<row r="2"><c r="A2"><v>4</v></c><c r="B2"><v>1</v></c><c r="C2"><v>0</v></c><c r="D2"><v>-2</v></c><c r="E2"><v>3</v></c></row>' +
    '<row r="3"><c r="A3"><v>7</v></c><c r="B3"><v>7</v></c><c r="C3"><v>8</v></c><c r="D3"><v>6</v></c><c r="E3"><v>9</v></c></row>' +
    '<row r="4"><c r="A4"><v>1</v></c><c r="B4"><v>-1</v></c><c r="C4"><v>1</v></c><c r="D4"><v>-1</v></c><c r="E4"><v>1</v></c></row>' +
    '<row r="6"><c r="A6"><v>2</v></c><c r="B6"><v>4</v></c><c r="C6"><v>6</v></c><c r="D6"><v>5</v></c><c r="E6"><v>7</v></c></row>' +
    '</sheetData>' +
    tailAfterData +
    '</worksheet>';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '</styleSheet>',
    ),
  });
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

describe('sparklines: parse', () => {
  it('parses a representative Excel-written group set field-by-field (all three types)', () => {
    const sheet = dataSheet(adapter.read(sourcePackage(EXCEL_EXT_LST)));
    expect(sheet.rows[0]).toEqual([1, 2, 3, 2, 5, null]); // cell data untouched
    const groups = sheet.sparklineGroups!;
    expect(groups).toHaveLength(4);
    const [line, column, stacked, dateAxis] = groups as [
      SparklineGroup, SparklineGroup, SparklineGroup, SparklineGroup,
    ];
    // Line group: every attribute family asserted.
    expect(line.type).toBe('line');
    expect(line.lineWeight).toBe(1.25);
    expect(line.displayEmptyCellsAs).toBe('span');
    expect(line.markers).toEqual({ show: true, high: true, low: true, first: true, last: true, negative: true });
    expect(line.axis).toEqual({ show: true, minType: 'custom', maxType: 'custom', manualMin: -5, manualMax: 15 });
    expect(line.displayHidden).toBe(true);
    expect(line.seriesColor).toEqual({ theme: 4, tint: -0.499984740745262 });
    expect(line.negativeColor).toEqual({ rgb: 'FFFF0000' });
    expect(line.axisColor).toEqual({ theme: 1 });
    expect(line.markersColor).toEqual({ theme: 4, tint: -0.499984740745262 });
    expect(line.firstColor).toEqual({ rgb: 'FF00B050' });
    expect(line.lastColor).toEqual({ rgb: 'FF0070C0' });
    expect(line.highColor).toEqual({ rgb: 'FF00B050' });
    expect(line.lowColor).toEqual({ rgb: 'FFFF0000' });
    expect(line.sparklines).toEqual([
      { dataRef: 'Data!A1:E1', targetRef: 'F1' },
      { dataRef: 'Data!A2:E2', targetRef: 'F2' },
    ]);
    // Column group: group-scaled axis, only the colors Excel wrote.
    expect(column).toEqual(EXPECTED_GROUPS[1]);
    // Stacked (win/loss) group.
    expect(stacked.type).toBe('stacked');
    expect(stacked.markers).toEqual({ negative: true });
    expect(stacked.negativeColor).toEqual({ rgb: 'FFC00000' });
    expect(stacked).toEqual(EXPECTED_GROUPS[2]);
    // Date-axis group: group-level <xm:f> lands in dateRef, not in a sparkline.
    expect(dateAxis.dateAxis).toBe(true);
    expect(dateAxis.dateRef).toBe('Data!A5:E5');
    expect(dateAxis).toEqual(EXPECTED_GROUPS[3]);
    // Whole-model equality against the hand-written expectation.
    expect(groups).toEqual(EXPECTED_GROUPS);
  });

  it('accepts the x14:f / x14:sqref writer variant and $-refs', () => {
    const xml =
      '<worksheet><sheetData/></worksheet>'.replace(
        '</worksheet>',
        `<extLst><ext uri="${SPARKLINE_GROUPS_EXT_URI}" xmlns:x14="${X14}">` +
        `<x14:sparklineGroups xmlns:xm="${XM}">` +
        '<x14:sparklineGroup type="column">' +
        '<x14:sparklines><x14:sparkline><x14:f>Data!$A$1:$E$1</x14:f><x14:sqref>$F$1</x14:sqref></x14:sparkline></x14:sparklines>' +
        '</x14:sparklineGroup></x14:sparklineGroups></ext></extLst></worksheet>',
      );
    expect(parseSparklineGroups(xml)).toEqual([{
      type: 'column',
      // Data refs are verbatim (formula grammar); targets are normalized.
      sparklines: [{ dataRef: 'Data!$A$1:$E$1', targetRef: 'F1' }],
    }]);
  });

  it('a sheet without sparklines parses to no field', () => {
    const sheet = dataSheet(adapter.read(sourcePackage('')));
    expect(sheet.sparklineGroups).toBeUndefined();
    expect(parseSparklineGroups('<worksheet><sheetData/></worksheet>')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Serialize + round-trips                                             */
/* ------------------------------------------------------------------ */

describe('sparklines: serialize + round-trip', () => {
  it('model -> XML -> parse is identical', () => {
    const xml = sparklineGroupsToXml(EXPECTED_GROUPS);
    expect(xml).toContain(`xmlns:xm="${XM}"`);
    expect(xml).toContain('type="stacked"');
    expect(xml).toContain('manualMin="-5"');
    expect(xml).toContain('manualMax="15"');
    expect(xml).toContain('<x14:colorNegative rgb="FFFF0000"/>');
    expect(xml).toContain('<xm:f>Data!A5:E5</xm:f>'); // date-axis range, before sparklines
    expect(xml.indexOf('<xm:f>Data!A5:E5</xm:f>')).toBeLessThan(xml.lastIndexOf('<x14:sparklines>'));
    const wrapped =
      `<worksheet><extLst><ext uri="${SPARKLINE_GROUPS_EXT_URI}" xmlns:x14="${X14}">${xml}</ext></extLst></worksheet>`;
    expect(parseSparklineGroups(wrapped)).toEqual(EXPECTED_GROUPS);
    // The extLst serializer carries the extension URI + x14 declaration.
    const extLst = sparklineExtLstXml(EXPECTED_GROUPS);
    expect(extLst).toContain(`uri="${SPARKLINE_GROUPS_EXT_URI}"`);
    expect(extLst).toContain(`xmlns:x14="${X14}"`);
    expect(parseSparklineGroups(`<worksheet>${extLst}</worksheet>`)).toEqual(EXPECTED_GROUPS);
    expect(sparklineExtLstXml([])).toBe('');
  });

  it('full package round-trip through the adapter preserves the groups', () => {
    const once = adapter.read(sourcePackage(EXCEL_EXT_LST));
    const bytes = adapter.write(once);
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    // Native x14 extension in <extLst>, worksheet root declares x14 + mc:Ignorable.
    expect(xml).toContain('<extLst>');
    expect(xml).toContain(`uri="${SPARKLINE_GROUPS_EXT_URI}"`);
    expect(xml).toContain('<x14:sparklineGroups');
    expect(xml).toContain(`xmlns:x14="${X14}"`);
    expect(xml).toMatch(/mc:Ignorable="[^"]*\bx14\b/);
    // extLst is the last worksheet child (CT_Worksheet order).
    expect(xml.indexOf('</sheetData>')).toBeLessThan(xml.indexOf('<extLst>'));
    expect(xml.indexOf('</extLst>')).toBeLessThan(xml.indexOf('</worksheet>'));
    const twice = dataSheet(adapter.read(bytes));
    expect(twice.sparklineGroups).toEqual(EXPECTED_GROUPS);
    // F2 (index 5) is the sparkline host cell: genuinely empty in Excel too
    // (sparklines float over the cell). The sparse classic-adapter row model
    // does not materialize a trailing empty cell, so the row re-reads at
    // length 5 with all data cells exact. (Coordinator correction to the
    // worker's original assertion, which expected a trailing null.)
    expect(twice.rows[1]).toEqual([4, 1, 0, -2, 3]);
  });

  it('coexists with mergeCells: both survive read -> write -> read, extLst last', () => {
    const tail =
      '<mergeCells count="1"><mergeCell ref="A1:E1"/></mergeCells>' + EXCEL_EXT_LST;
    const once = adapter.read(sourcePackage(tail));
    const bytes = adapter.write(once);
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml.indexOf('<mergeCells')).toBeLessThan(xml.indexOf('<extLst>'));
    const twice = dataSheet(adapter.read(bytes));
    expect(twice.merges).toEqual(['A1:E1']);
    expect(twice.sparklineGroups).toEqual(EXPECTED_GROUPS);
  });

  it('writes an app-authored model natively (stacked + custom axis + rgb colors)', () => {
    const groups: SparklineGroup[] = [{
      type: 'stacked',
      markers: { negative: true },
      axis: { show: true, minType: 'custom', maxType: 'custom', manualMin: -10, manualMax: 10 },
      displayHidden: false,
      seriesColor: { rgb: 'FF4472C4' },
      negativeColor: { rgb: 'FFFF0000' },
      sparklines: [{ dataRef: 'S!A1:E1', targetRef: 'F1' }],
    }];
    const data: WorkbookData = {
      sheets: [{ name: 'S', rows: [[1, -2, 3, -1, 2]], sparklineGroups: groups } as SheetDataWithNativeFeatures],
      metadata: {},
    };
    const bytes = adapter.write(data);
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('type="stacked"');
    expect(xml).toContain('negative="1"');
    expect(xml).toContain('displayHidden="0"'); // explicit false survives (presence is significant)
    expect(xml).toContain('manualMin="-10"');
    expect(xml).toContain('<x14:colorSeries rgb="FF4472C4"/>');
    expect(xml).toContain('<xm:f>S!A1:E1</xm:f><xm:sqref>F1</xm:sqref>');
    expect(dataSheet(adapter.read(bytes)).sparklineGroups).toEqual(groups);
  });

  it('sheets without sparklines gain no extLst on write', () => {
    const data: WorkbookData = { sheets: [{ name: 'S', rows: [[1, 2, 3]] }], metadata: {} };
    const xml = partText(adapter.write(data), 'xl/worksheets/sheet1.xml');
    expect(xml).not.toContain('<extLst');
    expect(xml).not.toContain('sparkline');
    expect(dataSheet(adapter.read(adapter.write(data))).sparklineGroups).toBeUndefined();
  });

  it('precedence: a present-but-empty sparklineGroups field strips source sparklines on write', () => {
    const data = adapter.read(sourcePackage(EXCEL_EXT_LST));
    dataSheet(data).sparklineGroups = [];
    const xml = partText(adapter.write(data), 'xl/worksheets/sheet1.xml');
    expect(xml).not.toContain('sparklineGroups');
    expect(xml).not.toContain(SPARKLINE_GROUPS_EXT_URI);
    expect(dataSheet(adapter.read(adapter.write(data))).sparklineGroups).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Splice unit behavior + streaming writer                             */
/* ------------------------------------------------------------------ */

describe('sparklines: splice + streaming', () => {
  it('splice preserves other extensions and replaces only the sparkline ext', () => {
    const otherExt =
      '<ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}" xmlns:x14="' + X14 + '">' +
      '<x14:conditionalFormattings/></ext>';
    const sheetXml =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
      `<extLst>${otherExt}` +
      EXCEL_EXT_LST.slice('<extLst>'.length, -'</extLst>'.length) +
      '</extLst></worksheet>';
    const replacement: SparklineGroup[] = [{
      type: 'line',
      sparklines: [{ dataRef: 'A1:E1', targetRef: 'F1' }],
    }];
    const out = spliceSparklineGroups(sheetXml, replacement);
    expect(out).toContain('conditionalFormattings'); // other ext untouched
    expect(out).toContain('<x14:sparklineGroup type="line">');
    expect(out).not.toContain('type="stacked"'); // old groups replaced
    expect(parseSparklineGroups(out)).toEqual(replacement);
    // Empty model removes only the sparkline ext; the other ext survives.
    const stripped = spliceSparklineGroups(sheetXml, []);
    expect(stripped).toContain('conditionalFormattings');
    expect(stripped).not.toContain('sparklineGroups');
    expect(parseSparklineGroups(stripped)).toEqual([]);
    // Undefined leaves the sheet byte-identical.
    expect(spliceSparklineGroups(sheetXml, undefined)).toBe(sheetXml);
  });

  it('streaming writer splices sparklineGroups and preserves the source extLst otherwise', () => {
    const groups: SparklineGroup[] = [{
      type: 'column',
      seriesColor: { theme: 4 },
      sparklines: [{ dataRef: 'A1:E1', targetRef: 'F1' }],
    }];
    const generated = [...sheetXmlChunks({
      sourceXml: null,
      cells: [{ row: 0, col: 0, input: 1 }],
      xfFor: () => 0,
      nativeFeatures: { sparklineGroups: groups },
    })].join('');
    expect(generated).toContain('<extLst>');
    expect(generated).toContain('<x14:sparklineGroup type="column">');
    expect(parseSparklineGroups(generated)).toEqual(groups);

    const srcXml =
      '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
      EXCEL_EXT_LST + '</worksheet>';
    // No nativeFeatures at all: the source extension survives verbatim.
    const preserved = [...sheetXmlChunks({
      sourceXml: srcXml,
      cells: [{ row: 0, col: 0, input: 2 }],
      xfFor: () => 0,
    })].join('');
    expect(parseSparklineGroups(preserved)).toEqual(EXPECTED_GROUPS);
    // nativeFeatures without sparklineGroups: still preserved.
    const preserved2 = [...sheetXmlChunks({
      sourceXml: srcXml,
      cells: [{ row: 0, col: 0, input: 2 }],
      xfFor: () => 0,
      nativeFeatures: { merges: ['A1:B1'] },
    })].join('');
    expect(parseSparklineGroups(preserved2)).toEqual(EXPECTED_GROUPS);
    // An explicit empty model strips the source extension.
    const stripped = [...sheetXmlChunks({
      sourceXml: srcXml,
      cells: [{ row: 0, col: 0, input: 2 }],
      xfFor: () => 0,
      nativeFeatures: { sparklineGroups: [] },
    })].join('');
    expect(stripped).not.toContain('sparklineGroups');
  });
});
