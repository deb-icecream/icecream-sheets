/**
 * Slices 2–5 (audit §§14.3, 14.4, 6.1, 5.1/5.2): native worksheet
 * features in the XLSX adapter — mergeCells, autoFilter + sortState,
 * dataValidations, conditionalFormatting (+ dxfs).
 *
 * Every test round-trips REAL native OOXML: either a hand-built source
 * package (the way Excel writes it) parsed by XlsxAdapter.read, or a
 * model written by XlsxAdapter.write whose sheet/styles XML is asserted
 * directly and then read back to the identical model.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { WorkbookData } from '@icecream-sheets/engine';
import {
  XlsxAdapter,
  parseDataValidations,
  parseMergeCells,
  sheetXmlChunks,
  type NativeConditionalFormatting,
  type NativeDataValidation,
  type SheetDataWithNativeFeatures,
} from '../src/index.js';

const dec = new TextDecoder();
const adapter = new XlsxAdapter();

function partText(bytes: Uint8Array, path: string): string {
  const parts = unzipSync(bytes.slice());
  const raw = parts[path];
  return raw ? dec.decode(raw) : '';
}

/* ------------------------------------------------------------------ */
/* Hand-built native source package (as Excel would write it)          */
/* ------------------------------------------------------------------ */

const SOURCE_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<dxfs count="2">' +
  '<dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>' +
  '<dxf><fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill></dxf>' +
  '</dxfs></styleSheet>';

function sourcePackage(sheetBodyAfterData: string, styles = SOURCE_STYLES): Uint8Array {
  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:D6"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>' +
    '<sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Title</t></is></c><c r="B1"><v>10</v></c><c r="C1"><v>3</v></c><c r="D1"><v>7</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2"><v>4</v></c><c r="C2"><v>9</v></c><c r="D2"><v>1</v></c></row>' +
    '<row r="3"><c r="B3"><v>8</v></c><c r="C3"><v>2</v></c><c r="D3"><v>5</v></c></row>' +
    '</sheetData>' +
    sheetBodyAfterData +
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
    'xl/styles.xml': strToU8(styles),
  });
}

function dataSheet(data: WorkbookData): SheetDataWithNativeFeatures {
  return data.sheets[0] as SheetDataWithNativeFeatures;
}

/* ------------------------------------------------------------------ */
/* Slice 2 — merge cells                                               */
/* ------------------------------------------------------------------ */

describe('slice 2: mergeCells', () => {
  it('parses native merges on import (multiple, normalized)', () => {
    const bytes = sourcePackage(
      '<mergeCells count="3"><mergeCell ref="A1:D1"/><mergeCell ref="$B$3:$C$3"/><mergeCell ref="a5:b6"/></mergeCells>',
    );
    const sheet = dataSheet(adapter.read(bytes));
    expect(sheet.merges).toEqual(['A1:D1', 'B3:C3', 'A5:B6']);
    expect(sheet.rows[0]![0]).toBe('Title');
  });

  it('round-trips merges model -> XML -> model, in CT_Worksheet order', () => {
    const data: WorkbookData = {
      sheets: [{
        name: 'Data',
        rows: [['Title', null, null, null], [1, 2, 3, 4]],
        merges: ['A1:D1', 'A2:B2'],
      } as SheetDataWithNativeFeatures],
      metadata: {},
    };
    const bytes = adapter.write(data);
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('<mergeCells count="2"><mergeCell ref="A1:D1"/><mergeCell ref="A2:B2"/></mergeCells>');
    expect(xml.indexOf('</sheetData>')).toBeLessThan(xml.indexOf('<mergeCells'));
    const back = dataSheet(adapter.read(bytes));
    expect(back.merges).toEqual(['A1:D1', 'A2:B2']);
  });

  it('native source merges survive a full read -> write -> read loop', () => {
    const bytes = sourcePackage('<mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>');
    const once = adapter.read(bytes);
    const twice = adapter.read(adapter.write(once));
    expect(dataSheet(twice).merges).toEqual(['A1:D1']);
  });

  it('precedence: a present-but-empty merges field strips source merges on write', () => {
    const bytes = sourcePackage('<mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>');
    const data = adapter.read(bytes);
    dataSheet(data).merges = [];
    const out = partText(adapter.write(data), 'xl/worksheets/sheet1.xml');
    expect(out).not.toContain('<mergeCells');
    expect(parseMergeCells(out)).toEqual([]);
  });

  it('sheets without merges carry no field and write no element', () => {
    const data: WorkbookData = { sheets: [{ name: 'S', rows: [[1]] }], metadata: {} };
    const sheet = dataSheet(adapter.read(adapter.write(data)));
    expect(sheet.merges).toBeUndefined();
    expect(partText(adapter.write(data), 'xl/worksheets/sheet1.xml')).not.toContain('<mergeCells');
  });
});

/* ------------------------------------------------------------------ */
/* Slice 3 — autoFilter + sortState                                    */
/* ------------------------------------------------------------------ */

const SOURCE_FILTER =
  '<autoFilter ref="A1:D3">' +
  '<filterColumn colId="0"><filters><filter val="x"/><filter val="y"/><dateGroupItem year="2024" month="3" dateTimeGrouping="month"/></filters></filterColumn>' +
  '<filterColumn colId="1" hiddenButton="1"><customFilters and="0"><customFilter operator="greaterThan" val="2"/><customFilter operator="lessThan" val="9"/></customFilters></filterColumn>' +
  '<filterColumn colId="2"><top10 top="1" percent="1" val="10" filterVal="5"/></filterColumn>' +
  '<filterColumn colId="3"><dynamicFilter type="aboveAverage" val="4.5"/></filterColumn>' +
  '</autoFilter>' +
  '<sortState ref="A1:D3" caseSensitive="1"><sortCondition ref="B1:B3" descending="1"/><sortCondition ref="A1:A3"/></sortState>';

describe('slice 3: autoFilter + sortState', () => {
  it('parses every filterColumn family + sortState from a native file', () => {
    const sheet = dataSheet(adapter.read(sourcePackage(SOURCE_FILTER)));
    expect(sheet.autoFilter?.ref).toBe('A1:D3');
    expect(sheet.autoFilter?.filterColumns).toHaveLength(4);
    const [c0, c1, c2, c3] = sheet.autoFilter!.filterColumns;
    expect(c0!.filters?.values).toEqual(['x', 'y']);
    expect(c0!.filters?.dateGroups).toEqual([{ dateTimeGrouping: 'month', year: 2024, month: 3 }]);
    expect(c1!.hiddenButton).toBe(true);
    expect(c1!.customFilters).toEqual({
      and: false,
      filters: [
        { operator: 'greaterThan', val: '2' },
        { operator: 'lessThan', val: '9' },
      ],
    });
    expect(c2!.top10).toEqual({ val: 10, top: true, percent: true, filterVal: 5 });
    expect(c3!.dynamicFilter).toEqual({ type: 'aboveAverage', val: 4.5 });
    expect(sheet.sortState).toEqual({
      ref: 'A1:D3',
      caseSensitive: true,
      conditions: [
        { ref: 'B1:B3', descending: true },
        { ref: 'A1:A3' },
      ],
    });
  });

  it('parses colorFilter and iconFilter columns', () => {
    const xml =
      '<autoFilter ref="A1:B2"><filterColumn colId="0"><colorFilter dxfId="1" cellColor="0"/></filterColumn>' +
      '<filterColumn colId="1"><iconFilter iconSet="3Arrows" iconId="1"/></filterColumn></autoFilter>';
    const sheet = dataSheet(adapter.read(sourcePackage(xml)));
    expect(sheet.autoFilter?.filterColumns[0]!.colorFilter).toEqual({ dxfId: 1, cellColor: false });
    expect(sheet.autoFilter?.filterColumns[1]!.iconFilter).toEqual({ iconSet: '3Arrows', iconId: 1 });
  });

  it('round-trips the full filter model through write -> read identically', () => {
    const once = adapter.read(sourcePackage(SOURCE_FILTER));
    const bytes = adapter.write(once);
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    // CT_Worksheet order: autoFilter before sortState, both after sheetData.
    expect(xml.indexOf('</sheetData>')).toBeLessThan(xml.indexOf('<autoFilter'));
    expect(xml.indexOf('<autoFilter')).toBeLessThan(xml.indexOf('<sortState'));
    const twice = dataSheet(adapter.read(bytes));
    expect(twice.autoFilter).toEqual(dataSheet(once).autoFilter);
    expect(twice.sortState).toEqual(dataSheet(once).sortState);
  });
});

/* ------------------------------------------------------------------ */
/* Slice 4 — data validation                                           */
/* ------------------------------------------------------------------ */

const SOURCE_DV =
  '<dataValidations count="4">' +
  '<dataValidation type="whole" operator="between" allowBlank="1" showErrorMessage="1" errorStyle="warning" errorTitle="Bad qty" error="Enter 1-10" sqref="B1:B3"><formula1>1</formula1><formula2>10</formula2></dataValidation>' +
  '<dataValidation type="list" showInputMessage="1" promptTitle="Pick" prompt="Choose one" sqref="A2:A3 C2:C3"><formula1>"Red,Green,Blue"</formula1></dataValidation>' +
  '<dataValidation type="list" sqref="A5"><formula1>Lists!$A$1:$A$3</formula1></dataValidation>' +
  '<dataValidation type="custom" sqref="D1"><formula1>_xlfn.IFNA(D1,0)&gt;0</formula1></dataValidation>' +
  '</dataValidations>';

describe('slice 4: dataValidations', () => {
  it('parses all fields incl. multi-range sqref and both list forms', () => {
    const sheet = dataSheet(adapter.read(sourcePackage(SOURCE_DV)));
    const dvs = sheet.dataValidations!;
    expect(dvs).toHaveLength(4);
    expect(dvs[0]).toEqual({
      type: 'whole', operator: 'between', errorStyle: 'warning',
      allowBlank: true, showErrorMessage: true,
      errorTitle: 'Bad qty', error: 'Enter 1-10',
      formula1: '1', formula2: '10', sqref: 'B1:B3',
    });
    expect(dvs[1]).toEqual({
      type: 'list', showInputMessage: true,
      promptTitle: 'Pick', prompt: 'Choose one',
      formula1: '"Red,Green,Blue"', sqref: 'A2:A3 C2:C3',
    });
    expect(dvs[2]!.formula1).toBe('Lists!$A$1:$A$3');
    // Storage _xlfn prefixes are stripped on parse (engine-bare convention).
    expect(dvs[3]).toEqual({ type: 'custom', formula1: 'IFNA(D1,0)>0', sqref: 'D1' });
  });

  it('round-trips every validation type through write -> read', () => {
    const mk = (dv: NativeDataValidation): WorkbookData => ({
      sheets: [{ name: 'S', rows: [[1, 2], [3, 4]], dataValidations: [dv] } as SheetDataWithNativeFeatures],
      metadata: {},
    });
    const cases: NativeDataValidation[] = [
      { type: 'whole', operator: 'between', formula1: '1', formula2: '10', sqref: 'A1' },
      { type: 'decimal', operator: 'greaterThan', formula1: '0.5', sqref: 'A1:B2' },
      { type: 'date', operator: 'lessThan', formula1: 'DATE(2025,1,1)', sqref: 'A1' },
      { type: 'time', operator: 'notBetween', formula1: 'TIME(9,0,0)', formula2: 'TIME(17,0,0)', sqref: 'A1' },
      { type: 'textLength', operator: 'lessThanOrEqual', formula1: '8', sqref: 'A1' },
      { type: 'list', formula1: '"a,b,c"', sqref: 'A1' },
      { type: 'list', formula1: 'Other!$A$1:$A$4', sqref: 'B1:B4' },
      { type: 'custom', formula1: 'ISNUMBER(A1)', sqref: 'A1' },
      { type: 'none', sqref: 'A1' },
    ];
    for (const dv of cases) {
      const back = dataSheet(adapter.read(adapter.write(mk(dv))));
      expect(back.dataValidations).toEqual([dv]);
    }
  });

  it('writes native XML (count, sqref, formulas) that Excel reads', () => {
    const data: WorkbookData = {
      sheets: [{
        name: 'S', rows: [[1]],
        dataValidations: [{ type: 'list', formula1: '"x,y"', sqref: 'A1:A2', showDropDown: false }],
      } as SheetDataWithNativeFeatures],
      metadata: {},
    };
    const xml = partText(adapter.write(data), 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('<dataValidations count="1">');
    expect(xml).toContain('type="list"');
    expect(xml).toContain('<formula1>"x,y"</formula1>');
    // showDropDown=false is the OOXML default (dropdown shown): omitted.
    expect(xml).not.toContain('showDropDown');
    expect(parseDataValidations(xml)).toHaveLength(1);
  });

  it('re-applies _xlfn prefixes to validation formulas on write', () => {
    const once = adapter.read(sourcePackage(SOURCE_DV));
    const xml = partText(adapter.write(once), 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('_xlfn.IFNA(D1,0)');
    const twice = dataSheet(adapter.read(adapter.write(once)));
    expect(twice.dataValidations).toEqual(dataSheet(once).dataValidations);
  });
});

/* ------------------------------------------------------------------ */
/* Slice 5 — conditional formatting                                  */
/* ------------------------------------------------------------------ */

const SOURCE_CF =
  '<conditionalFormatting sqref="B1:B3">' +
  '<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan" stopIfTrue="1"><formula>5</formula></cfRule>' +
  '<cfRule type="expression" dxfId="1" priority="2"><formula>_xlfn.IFNA($B1,0)&gt;3</formula></cfRule>' +
  '</conditionalFormatting>' +
  '<conditionalFormatting sqref="C1:C3">' +
  '<cfRule type="colorScale" priority="3"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FF63BE7B"/><color rgb="FFFFEB84"/><color rgb="FFF8696B"/></colorScale></cfRule>' +
  '<cfRule type="dataBar" priority="4"><dataBar><cfvo type="num" val="0"/><cfvo type="num" val="10"/><color rgb="FF638EC6"/></dataBar></cfRule>' +
  '<cfRule type="iconSet" priority="5"><iconSet iconSet="3Arrows" showValue="0"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule>' +
  '<cfRule type="top10" priority="6" rank="3" percent="1" bottom="1"/>' +
  '</conditionalFormatting>';

describe('slice 5: conditionalFormatting + dxfs', () => {
  it('parses cellIs/expression rules with dxf payloads resolved from styles.xml', () => {
    const sheet = dataSheet(adapter.read(sourcePackage(SOURCE_CF)));
    const cfs = sheet.conditionalFormatting!;
    expect(cfs).toHaveLength(2);
    const [r0, r1] = cfs[0]!.rules;
    expect(r0).toMatchObject({ type: 'cellIs', operator: 'greaterThan', priority: 1, stopIfTrue: true, formulas: ['5'], dxfId: 0 });
    expect(r0!.dxf?.font?.bold).toBe(true);
    expect(r0!.dxf?.font?.color).toBe('#9C0006');
    expect(r0!.dxf?.fill?.fgColor).toEqual({ rgb: 'FFFFC7CE' });
    expect(r1!.type).toBe('expression');
    expect(r1!.formulas).toEqual(['IFNA($B1,0)>3']); // _xlfn stripped on parse
    expect(r1!.dxf?.fill?.bgColor).toEqual({ rgb: 'FFFFFF00' });
  });

  it('parses colorScale, dataBar, iconSet and top10 rules', () => {
    const sheet = dataSheet(adapter.read(sourcePackage(SOURCE_CF)));
    const rules = sheet.conditionalFormatting![1]!.rules;
    const scale = rules[0]!;
    expect(scale.colorScale?.cfvos).toEqual([
      { type: 'min' }, { type: 'percentile', val: '50' }, { type: 'max' },
    ]);
    expect(scale.colorScale?.colors).toEqual([
      { rgb: 'FF63BE7B' }, { rgb: 'FFFFEB84' }, { rgb: 'FFF8696B' },
    ]);
    expect(rules[1]!.dataBar?.cfvos).toEqual([{ type: 'num', val: '0' }, { type: 'num', val: '10' }]);
    expect(rules[1]!.dataBar?.color).toEqual({ rgb: 'FF638EC6' });
    expect(rules[2]!.iconSet).toMatchObject({ iconSet: '3Arrows', showValue: false });
    expect(rules[2]!.iconSet?.cfvos).toHaveLength(3);
    expect(rules[3]).toMatchObject({ type: 'top10', rank: 3, percent: true, bottom: true });
  });

  it('round-trips the CF model: write allocates dxfs and read restores the model', () => {
    const once = adapter.read(sourcePackage(SOURCE_CF));
    const bytes = adapter.write(once);
    const sheetXml = partText(bytes, 'xl/worksheets/sheet1.xml');
    const stylesXml = partText(bytes, 'xl/styles.xml');
    // Rules are native, dxf payloads allocated in styles.xml <dxfs>.
    expect(sheetXml).toContain('<conditionalFormatting sqref="B1:B3">');
    expect(sheetXml).toContain('type="cellIs"');
    expect(sheetXml).toContain('_xlfn.IFNA($B1,0)'); // re-prefixed on write
    expect(stylesXml).toContain('<dxfs');
    expect(stylesXml).toContain('FFFFC7CE');
    const twice = dataSheet(adapter.read(bytes));
    expect(twice.conditionalFormatting).toEqual(dataSheet(once).conditionalFormatting);
  });

  it('writes app-authored rules (cellIs+dxf fill, colorScale, dataBar, iconSet, top10, expression) natively', () => {
    const cfs: NativeConditionalFormatting[] = [{
      sqref: 'A1:A9',
      rules: [
        { type: 'cellIs', priority: 1, operator: 'between', formulas: ['1', '9'], dxf: { fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF00' }, bgColor: { rgb: 'FFFFFF00' } } } },
        { type: 'colorScale', priority: 2, colorScale: { cfvos: [{ type: 'min' }, { type: 'max' }], colors: [{ rgb: 'FF0000FF' }, { rgb: 'FFFF0000' }] } },
        { type: 'dataBar', priority: 3, dataBar: { cfvos: [{ type: 'autoMin' }, { type: 'autoMax' }], color: { rgb: 'FF638EC6' } } },
        { type: 'iconSet', priority: 4, iconSet: { iconSet: '3TrafficLights1', cfvos: [{ type: 'percent', val: '0' }, { type: 'percent', val: '50' }, { type: 'percent', val: '80' }] } },
        { type: 'top10', priority: 5, rank: 5 },
        { type: 'expression', priority: 6, formulas: ['A1>AVERAGE($A$1:$A$9)'], stopIfTrue: true },
        { type: 'duplicateValues', priority: 7, dxf: { font: { bold: true, color: '#FF0000' } } },
        { type: 'timePeriod', priority: 8, timePeriod: 'last7Days', formulas: ['TODAY()-7'] },
        { type: 'aboveAverage', priority: 9, aboveAverage: true, equalAverage: true },
        { type: 'containsText', priority: 10, operator: 'containsText', text: 'err', formulas: ['NOT(ISERROR(SEARCH("err",A1)))'] },
      ],
    }];
    const data: WorkbookData = {
      sheets: [{ name: 'S', rows: [[1], [2], [3]], conditionalFormatting: cfs } as SheetDataWithNativeFeatures],
      metadata: {},
    };
    const bytes = adapter.write(data);
    const sheetXml = partText(bytes, 'xl/worksheets/sheet1.xml');
    const stylesXml = partText(bytes, 'xl/styles.xml');
    expect(stylesXml).toContain('<dxfs count="2">'); // fill dxf + font dxf, deduped
    expect(sheetXml.indexOf('<mergeCells')).toBe(-1);
    const back = dataSheet(adapter.read(bytes));
    // Read-back rules additionally carry the dxfId the writer allocated
    // for their dxf payload (fill dxf = 0, font dxf = 1, in rule order).
    const expected = [{
      ...cfs[0]!,
      rules: cfs[0]!.rules.map((r) =>
        r.type === 'cellIs' ? { ...r, dxfId: 0 } : r.type === 'duplicateValues' ? { ...r, dxfId: 1 } : r,
      ),
    }];
    expect(back.conditionalFormatting).toEqual(expected);
  });

  it('round-trips the remaining cfRule families (uniqueValues, blanks/errors, text family, below-average)', () => {
    const body =
      '<conditionalFormatting sqref="A1:A9">' +
      '<cfRule type="uniqueValues" priority="1" dxfId="1"/>' +
      '<cfRule type="containsBlanks" priority="2"/>' +
      '<cfRule type="notContainsBlanks" priority="3"/>' +
      '<cfRule type="containsErrors" priority="4"/>' +
      '<cfRule type="notContainsErrors" priority="5"/>' +
      '<cfRule type="notContainsText" priority="6" operator="notContainsText" text="err"><formula>1</formula></cfRule>' +
      '<cfRule type="beginsWith" priority="7" operator="beginsWith" text="A"><formula>1</formula></cfRule>' +
      '<cfRule type="endsWith" priority="8" operator="endsWith" text="Z"><formula>1</formula></cfRule>' +
      '<cfRule type="aboveAverage" priority="9" aboveAverage="0" stdDev="2"/>' +
      '</conditionalFormatting>';
    const once = adapter.read(sourcePackage(body));
    const rules = dataSheet(once).conditionalFormatting![0]!.rules;
    expect(rules.map((r) => r.type)).toEqual([
      'uniqueValues', 'containsBlanks', 'notContainsBlanks', 'containsErrors',
      'notContainsErrors', 'notContainsText', 'beginsWith', 'endsWith', 'aboveAverage',
    ]);
    expect(rules[0]!.dxf?.fill?.bgColor).toEqual({ rgb: 'FFFFFF00' });
    expect(rules[8]).toMatchObject({ aboveAverage: false, stdDev: 2 });
    const twice = dataSheet(adapter.read(adapter.write(once)));
    // The dxf payload round-trips identically; its dxfId is re-allocated
    // against the rebuilt styles.xml (the only dxf here lands at 0),
    // exactly as in the app-authored-rules test above.
    const expected = dataSheet(once).conditionalFormatting!.map((cf) => ({
      ...cf,
      rules: cf.rules.map((r) => (r.dxf ? { ...r, dxfId: 0 } : r)),
    }));
    expect(twice.conditionalFormatting).toEqual(expected);
  });

  it('combined sheet: all five features coexist in CT_Worksheet order and round-trip', () => {
    const body =
      '<autoFilter ref="A1:D3"><filterColumn colId="0"><filters blank="1"><filter val="x"/></filters></filterColumn></autoFilter>' +
      '<sortState ref="A1:D3"><sortCondition ref="A1:A3"/></sortState>' +
      '<mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>' +
      SOURCE_CF +
      SOURCE_DV;
    const once = adapter.read(sourcePackage(body));
    const bytes = adapter.write(once);
    const xml = partText(bytes, 'xl/worksheets/sheet1.xml');
    const order = ['<autoFilter', '<sortState', '<mergeCells', '<conditionalFormatting', '<dataValidations']
      .map((t) => xml.indexOf(t));
    expect(order.every((i) => i > xml.indexOf('</sheetData>'))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const twice = dataSheet(adapter.read(bytes));
    const first = dataSheet(once);
    expect(twice.merges).toEqual(first.merges);
    expect(twice.autoFilter).toEqual(first.autoFilter);
    expect(twice.sortState).toEqual(first.sortState);
    expect(twice.dataValidations).toEqual(first.dataValidations);
    expect(twice.conditionalFormatting).toEqual(first.conditionalFormatting);
  });

  it('streaming writer splices nativeFeatures and preserves source blocks otherwise', () => {
    const withFeatures = [...sheetXmlChunks({
      sourceXml: null,
      cells: [{ row: 0, col: 0, input: 1 }],
      xfFor: () => 0,
      nativeFeatures: { merges: ['A1:B1'], dataValidations: [{ type: 'whole', operator: 'between', formula1: '1', formula2: '5', sqref: 'A1' }] },
    })].join('');
    expect(withFeatures).toContain('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>');
    expect(withFeatures).toContain('<dataValidations count="1">');
    expect(withFeatures.indexOf('</sheetData>')).toBeLessThan(withFeatures.indexOf('<mergeCells'));

    const srcXml =
      '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
      '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>';
    const preserved = [...sheetXmlChunks({
      sourceXml: srcXml,
      cells: [{ row: 0, col: 0, input: 2 }],
      xfFor: () => 0,
    })].join('');
    expect(preserved).toContain('<mergeCell ref="A1:B1"/>');
  });
});
