import { describe, expect, it } from 'vitest';
import {
  diffMovedNativeCharts,
  reanchorNativeChartParts,
  type MovedNativeChart,
} from '../src/nativeChartReanchor';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function filesMap(drawingXml: string): Record<string, Uint8Array> {
  return {
    'xl/workbook.xml':
      ENC.encode(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dashboard" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels':
      ENC.encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': ENC.encode(`<worksheet><sheetData/></worksheet>`),
    'xl/worksheets/_rels/sheet1.xml.rels':
      ENC.encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
    'xl/drawings/drawing1.xml': ENC.encode(drawingXml),
  };
}

const DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Earnings"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>` +
  `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>24</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Cash Flow"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>` +
  `</xdr:wsDr>`;

describe('diffMovedNativeCharts', () => {
  const source = JSON.stringify([
    { sheetName: 'Dashboard', title: 'Earnings', anchor: { fromCol: 0, fromRow: 0, toCol: 6, toRow: 12 } },
    { sheetName: 'Dashboard', title: 'Cash Flow', anchor: { fromCol: 0, fromRow: 12, toCol: 6, toRow: 24 } },
  ]);
  it('returns moved pairs with px offsets converted to EMU', () => {
    const current = JSON.stringify([
      { sheet: 'Dashboard', title: 'Earnings', anchor: { fromCol: 1, fromRow: 2, toCol: 7, toRow: 14, fromColOff: 10, toRowOff: 5 } },
      { sheet: 'Dashboard', title: 'Cash Flow', anchor: { fromCol: 0, fromRow: 12, toCol: 6, toRow: 24 } },
    ]);
    const moved = diffMovedNativeCharts(source, current);
    expect(moved).toHaveLength(1);
    expect(moved[0].sheet).toBe('Dashboard');
    expect(moved[0].originalAnchor).toEqual({ fromCol: 0, fromRow: 0, toCol: 6, toRow: 12 });
    expect(moved[0].newAnchor.fromCol).toBe(1);
    expect(moved[0].newAnchor.fromColOff).toBe(10 * 9525);
    expect(moved[0].newAnchor.toRowOff).toBe(5 * 9525);
  });
  it('returns [] when nothing moved (EMU offsets equal in px space)', () => {
    const current = JSON.stringify([
      { sheet: 'Dashboard', title: 'Earnings', anchor: { fromCol: 0, fromRow: 0, toCol: 6, toRow: 12, fromColOff: 0 } },
      { sheet: 'Dashboard', title: 'Cash Flow', anchor: { fromCol: 0, fromRow: 12, toCol: 6, toRow: 24 } },
    ]);
    expect(diffMovedNativeCharts(source, current)).toEqual([]);
  });
  it('skips ambiguous duplicate titles instead of guessing', () => {
    const dupSource = JSON.stringify([
      { sheetName: 'Dashboard', title: 'Earnings', anchor: { fromCol: 0, fromRow: 0, toCol: 6, toRow: 12 } },
      { sheetName: 'Dashboard', title: 'Earnings', anchor: { fromCol: 7, fromRow: 0, toCol: 12, toRow: 12 } },
    ]);
    const current = JSON.stringify([
      { sheet: 'Dashboard', title: 'Earnings', anchor: { fromCol: 1, fromRow: 1, toCol: 7, toRow: 13 } },
    ]);
    expect(diffMovedNativeCharts(dupSource, current)).toEqual([]);
  });
  it('accepts parsed objects as well as JSON strings', () => {
    const current = [
      { sheet: 'Dashboard', title: 'Earnings', anchor: { fromCol: 2, fromRow: 0, toCol: 8, toRow: 12 } },
    ];
    const moved = diffMovedNativeCharts(JSON.parse(source), current);
    expect(moved).toHaveLength(1);
    expect(moved[0].newAnchor.fromCol).toBe(2);
  });
  it('returns [] for malformed input, never throws', () => {
    expect(diffMovedNativeCharts('not json', 'also not json')).toEqual([]);
    expect(diffMovedNativeCharts(undefined, undefined)).toEqual([]);
  });
});

describe('reanchorNativeChartParts', () => {
  it('rewrites exactly the moved anchor, leaving the other alone', () => {
    const files = filesMap(DRAWING);
    const moved: MovedNativeChart[] = [{
      sheet: 'Dashboard',
      originalAnchor: { fromCol: 0, fromRow: 0, toCol: 6, toRow: 12 },
      newAnchor: { fromCol: 1, fromRow: 2, toCol: 7, toRow: 14, fromColOff: 95250, toRowOff: 47625 },
    }];
    const report = reanchorNativeChartParts(files, moved);
    expect(report.rewritten).toBe(1);
    expect(report.skipped).toEqual([]);
    const out = DEC.decode(files['xl/drawings/drawing1.xml']);
    // Moved anchor carries the new cells + EMU offsets.
    expect(out).toContain('<xdr:from><xdr:col>1</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>');
    expect(out).toContain('<xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>47625</xdr:rowOff></xdr:to>');
    // Untouched anchor still present verbatim.
    expect(out).toContain('<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>');
  });
  it('rewrites anchors that carry attributes (editAs="oneCell")', () => {
    // Real files (bxl3way) write <xdr:twoCellAnchor editAs="oneCell">;
    // a tag matcher requiring ">" right after the name misses them.
    const attributed = DRAWING.replace(
      '<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col>',
      '<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col>',
    );
    const files = filesMap(attributed);
    const moved: MovedNativeChart[] = [{
      sheet: 'Dashboard',
      originalAnchor: { fromCol: 0, fromRow: 0, toCol: 6, toRow: 12 },
      newAnchor: { fromCol: 1, fromRow: 2, toCol: 7, toRow: 14 },
    }];
    const report = reanchorNativeChartParts(files, moved);
    expect(report.rewritten).toBe(1);
    const out = DEC.decode(files['xl/drawings/drawing1.xml']);
    expect(out).toContain('<xdr:twoCellAnchor editAs="oneCell">');
    expect(out).toContain('<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>');
  });
  it('skips a pair whose original anchor matches zero or several anchors', () => {
    const files = filesMap(DRAWING);
    const moved: MovedNativeChart[] = [
      { sheet: 'Dashboard', originalAnchor: { fromCol: 9, fromRow: 9, toCol: 10, toRow: 10 }, newAnchor: { fromCol: 1, fromRow: 1, toCol: 2, toRow: 2 } },
      { sheet: 'Nope', originalAnchor: { fromCol: 0, fromRow: 0, toCol: 6, toRow: 12 }, newAnchor: { fromCol: 1, fromRow: 1, toCol: 2, toRow: 2 } },
    ];
    const report = reanchorNativeChartParts(files, moved);
    expect(report.rewritten).toBe(0);
    expect(report.skipped).toHaveLength(2);
    expect(DEC.decode(files['xl/drawings/drawing1.xml'])).toBe(DRAWING);
  });
  it('is a no-op for an empty moved list', () => {
    const files = filesMap(DRAWING);
    const report = reanchorNativeChartParts(files, []);
    expect(report).toEqual({ rewritten: 0, skipped: [] });
    expect(DEC.decode(files['xl/drawings/drawing1.xml'])).toBe(DRAWING);
  });
});
