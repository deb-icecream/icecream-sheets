/**
 * OOXML wave-2 slice C (audit §13.2): native drawings — pictures &
 * shapes in the XLSX adapter.
 *
 * Fixtures are built in-test with fflate (the smartart/charts pattern):
 * a hand-built source package the way Excel writes it — a drawing part
 * with xdr:pic (embedded xl/media/*) and xdr:sp shapes — plus model-
 * authored workbooks written through XlsxAdapter.write whose package
 * is asserted directly and read back through the importer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { WorkbookData } from '@icecream-sheets/engine';
import {
  XlsxAdapter,
  authorNativeDrawingParts,
  imagePixelSize,
  injectNativeDrawings,
  nativeAnchorRectPx,
  readDrawings,
  seedNativeDrawingDisplayModels,
  type NativePicture,
  type NativeShape,
  type SheetDataWithNativeDrawings,
} from '../src/index.js';

const dec = new TextDecoder();
const adapter = new XlsxAdapter();

function filesOf(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes.slice()))) out[k] = v as Uint8Array;
  return out;
}

function partText(bytes: Uint8Array, path: string): string {
  const raw = filesOf(bytes)[path];
  return raw ? dec.decode(raw) : '';
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/* Distinctive fake image bytes (content is opaque to the adapter). */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 250, 251, 252]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 74, 70, 73, 70, 0, 9, 8, 7, 0xff, 0xd9]);

const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const DRAWING_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">` +
  // Picture 1: twoCellAnchor B2:G10, PNG, name + alt text.
  '<xdr:twoCellAnchor editAs="oneCell">' +
  '<xdr:from><xdr:col>1</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>4763</xdr:rowOff></xdr:from>' +
  '<xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
  '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo" descr="Company &amp; Co logo"/>' +
  '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
  '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
  '<xdr:spPr><a:xfrm><a:off x="91440" y="19050"/><a:ext cx="4876800" cy="1600200"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>' +
  // Picture 2: oneCellAnchor at D4 with an EMU ext, JPEG, no alt text.
  '<xdr:oneCellAnchor>' +
  '<xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
  '<xdr:ext cx="1828800" cy="914400"/>' +
  '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Icon"/>' +
  '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
  '<xdr:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
  '<xdr:spPr><a:xfrm><a:off x="1828800" y="571500"/><a:ext cx="1828800" cy="914400"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>' +
  // Shape 1: roundRect, solid fill + line, two-paragraph text.
  '<xdr:twoCellAnchor>' +
  '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
  '<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
  '<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="4" name="Banner"/><xdr:cNvSpPr/></xdr:nvSpPr>' +
  '<xdr:spPr><a:xfrm><a:off x="0" y="2095500"/><a:ext cx="3048000" cy="762000"/></a:xfrm>' +
  '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"/></a:avLst></a:prstGeom>' +
  '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>' +
  '<a:ln w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></xdr:spPr>' +
  '<xdr:txBody><a:bodyPr/><a:lstStyle/>' +
  '<a:p><a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r></a:p>' +
  '<a:p><a:r><a:rPr lang="en-US"/><a:t>World</a:t></a:r></a:p>' +
  '</xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>' +
  // Shape 2: ellipse, fill only (no line), single-paragraph text.
  '<xdr:twoCellAnchor>' +
  '<xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
  '<xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
  '<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="5" name="Dot"/><xdr:cNvSpPr/></xdr:nvSpPr>' +
  '<xdr:spPr><a:xfrm><a:off x="3657600" y="2095500"/><a:ext cx="1219200" cy="571500"/></a:xfrm>' +
  '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' +
  '<a:solidFill><a:srgbClr val="ED7D31"/></a:solidFill></xdr:spPr>' +
  '<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Solo</a:t></a:r></a:p></xdr:txBody>' +
  '</xdr:sp><xdr:clientData/></xdr:twoCellAnchor>' +
  '</xdr:wsDr>';

const DRAWING_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${R}/image" Target="../media/image1.png"/>` +
  `<Relationship Id="rId2" Type="${R}/image" Target="../media/image2.jpeg"/>` +
  '</Relationships>';

/** A single-sheet package ("Data") whose sheet carries DRAWING_XML. */
function sourcePackage(drawingXml: string = DRAWING_XML, drawingRels: string = DRAWING_RELS): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.drawing+xml"/>' +
      '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}">` +
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/>` +
      '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}">` +
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Title</t></is></c><c r="B1"><v>42</v></c></row></sheetData>' +
      '<drawing r:id="rId7"/>' +
      '</worksheet>',
    ),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId7" Type="${R}/drawing" Target="../drawings/drawing1.xml"/>` +
      '</Relationships>',
    ),
    'xl/drawings/drawing1.xml': strToU8(drawingXml),
    'xl/drawings/_rels/drawing1.xml.rels': strToU8(drawingRels),
    'xl/media/image1.png': PNG_BYTES,
    'xl/media/image2.jpeg': JPEG_BYTES,
  });
}

function dataSheet(data: WorkbookData): SheetDataWithNativeDrawings {
  return data.sheets[0] as SheetDataWithNativeDrawings;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

describe('readDrawings: picture import', () => {
  it('extracts media bytes byte-identical, anchors exact, name + alt text', () => {
    const entries = readDrawings(filesOf(sourcePackage()));
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.sheetName).toBe('Data');
    expect(entry.sheetIndex).toBe(0);
    expect(entry.pictures).toHaveLength(2);

    const [logo, icon] = entry.pictures;
    expect(bytesEqual(logo!.mediaBytes, PNG_BYTES)).toBe(true);
    expect(logo!.name).toBe('Logo');
    expect(logo!.altText).toBe('Company & Co logo');
    expect(logo!.contentType).toBe('image/png');
    expect(logo!.anchor).toEqual({
      kind: 'twoCell',
      fromCol: 1, fromRow: 1, fromColOff: 9525, fromRowOff: 4763,
      toCol: 6, toRow: 9, toColOff: 0, toRowOff: 0,
    });

    expect(bytesEqual(icon!.mediaBytes, JPEG_BYTES)).toBe(true);
    expect(icon!.name).toBe('Icon');
    expect(icon!.altText).toBe('');
    expect(icon!.contentType).toBe('image/jpeg');
    expect(icon!.anchor).toEqual({
      kind: 'oneCell',
      fromCol: 3, fromRow: 3, fromColOff: 0, fromRowOff: 0,
      toCol: 3, toRow: 3, toColOff: 0, toRowOff: 0,
      extCx: 1828800, extCy: 914400,
    });
  });

  it('attaches the model to the sheet on adapter.read (fields only when present)', () => {
    const data = adapter.read(sourcePackage());
    const sheet = dataSheet(data);
    expect(sheet.rows[0]![0]).toBe('Title');
    expect(sheet.nativePictures).toHaveLength(2);
    expect(sheet.nativeShapes).toHaveLength(2);
    expect(sheet.nativeDrawingsRaw?.drawingPath).toBe('xl/drawings/drawing1.xml');
    expect(Object.keys(sheet.nativeDrawingsRaw!.mediaParts).sort()).toEqual([
      'xl/media/image1.png',
      'xl/media/image2.jpeg',
    ]);
  });
});

describe('readDrawings: shape import', () => {
  it('extracts preset, fill, line and text per shape', () => {
    const entry = readDrawings(filesOf(sourcePackage()))[0]!;
    expect(entry.shapes).toHaveLength(2);
    const [banner, dot] = entry.shapes;
    expect(banner).toMatchObject({
      preset: 'roundRect',
      fill: '4472C4',
      line: 'FF0000',
      text: 'Hello\nWorld',
      name: 'Banner',
    });
    expect(banner!.anchor).toMatchObject({ kind: 'twoCell', fromCol: 0, fromRow: 11, toCol: 4, toRow: 15 });
    expect(dot).toMatchObject({ preset: 'ellipse', fill: 'ED7D31', line: null, text: 'Solo', name: 'Dot' });
  });

  it('reads scheme colors and noFill per the documented convention', () => {
    const drawing =
      `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">` +
      '<xdr:twoCellAnchor>' +
      '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
      '<xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="S"/><xdr:cNvSpPr/></xdr:nvSpPr>' +
      '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>' +
      '<a:ln><a:noFill/></a:ln></xdr:spPr></xdr:sp><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
    const entry = readDrawings(filesOf(sourcePackage(drawing)))[0]!;
    expect(entry.shapes[0]).toMatchObject({ preset: 'rect', fill: 'scheme:accent1', line: null, text: '' });
  });
});

describe('readDrawings: robustness', () => {
  it('skips a pic whose media cannot resolve and keeps the shape', () => {
    const drawing =
      `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">` +
      '<xdr:twoCellAnchor>' +
      '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
      '<xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Ghost"/></xdr:nvPicPr>' +
      '<xdr:blipFill><a:blip r:embed="rIdMissing"/></xdr:blipFill></xdr:pic>' +
      '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="3" name="Ok"/><xdr:cNvSpPr/></xdr:nvSpPr>' +
      '<xdr:spPr><a:prstGeom prst="triangle"><a:avLst/></a:prstGeom></xdr:spPr></xdr:sp>' +
      '<xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
    const entries = readDrawings(filesOf(sourcePackage(drawing)));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pictures).toEqual([]);
    expect(entries[0]!.shapes).toHaveLength(1);
    expect(entries[0]!.shapes[0]!.preset).toBe('triangle');
  });

  it('a malformed drawing never breaks the open', () => {
    const bytes = sourcePackage('<xdr:wsDr><xdr:twoCellAnchor><xdr:pic><a:blip');
    expect(readDrawings(filesOf(bytes))).toEqual([]);
    const data = adapter.read(bytes);
    expect(data.sheets[0]!.rows[0]![0]).toBe('Title');
    expect(dataSheet(data).nativePictures).toBeUndefined();
    expect(readDrawings({})).toEqual([]);
  });

  it('a chart-only drawing yields no pictures/shapes', () => {
    const drawing =
      `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">` +
      '<xdr:twoCellAnchor>' +
      '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
      '<xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/></xdr:nvGraphicFramePr>' +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic>` +
      '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
    expect(readDrawings(filesOf(sourcePackage(drawing)))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Preservation round-trip                                             */
/* ------------------------------------------------------------------ */

describe('preservation round-trip (import → classic write → re-import)', () => {
  it('carries the original drawing + media byte-for-byte through write()', () => {
    const data = adapter.read(sourcePackage());
    const saved = adapter.write(data);
    const files = filesOf(saved);

    // Media parts byte-identical at their original paths.
    expect(files['xl/media/image1.png']).toBeDefined();
    expect(bytesEqual(files['xl/media/image1.png']!, PNG_BYTES)).toBe(true);
    expect(files['xl/media/image2.jpeg']).toBeDefined();
    expect(bytesEqual(files['xl/media/image2.jpeg']!, JPEG_BYTES)).toBe(true);
    // The drawing part and its rels are the ORIGINAL bytes.
    expect(files['xl/drawings/drawing1.xml']).toBeDefined();
    expect(bytesEqual(files['xl/drawings/drawing1.xml']!, strToU8(DRAWING_XML))).toBe(true);
    expect(bytesEqual(files['xl/drawings/_rels/drawing1.xml.rels']!, strToU8(DRAWING_RELS))).toBe(true);
    // Wired: sheet carries <drawing> and a sheet→drawing relationship,
    // and the content types cover the drawing part.
    expect(partText(saved, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id=');
    expect(partText(saved, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain('/drawing');
    expect(partText(saved, '[Content_Types].xml')).toContain('/xl/drawings/drawing1.xml');

    // Re-import: the model is identical.
    const before = readDrawings(filesOf(sourcePackage()))[0]!;
    const after = readDrawings(files)[0]!;
    expect(after.pictures).toHaveLength(2);
    expect(after.shapes).toEqual(before.shapes);
    for (let i = 0; i < 2; i++) {
      const a = before.pictures[i]!;
      const b = after.pictures[i]!;
      expect(b.anchor).toEqual(a.anchor);
      expect(b.name).toBe(a.name);
      expect(b.altText).toBe(a.altText);
      expect(b.contentType).toBe(a.contentType);
      expect(bytesEqual(b.mediaBytes, a.mediaBytes)).toBe(true);
    }
    const reread = dataSheet(adapter.read(saved));
    expect(reread.nativePictures).toHaveLength(2);
    expect(reread.nativeShapes).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Authoring                                                           */
/* ------------------------------------------------------------------ */

const AUTHORED_PIC: NativePicture = {
  anchor: {
    kind: 'twoCell',
    fromCol: 1, fromRow: 2, fromColOff: 0, fromRowOff: 0,
    toCol: 5, toRow: 8, toColOff: 0, toRowOff: 0,
  },
  mediaBytes: PNG_BYTES,
  name: 'Authored Logo',
  altText: 'Alt text here',
  contentType: 'image/png',
};

const AUTHORED_SHAPE: NativeShape = {
  anchor: {
    kind: 'twoCell',
    fromCol: 0, fromRow: 10, fromColOff: 0, fromRowOff: 0,
    toCol: 3, toRow: 13, toColOff: 0, toRowOff: 0,
  },
  preset: 'ellipse',
  fill: '00B050',
  line: 'FF0000',
  text: 'Hi\nThere',
  name: 'MyShape',
};

describe('authoring (model → native drawing + media)', () => {
  it('writes a package whose drawing+media the importer reads back identically', () => {
    const data: WorkbookData = {
      sheets: [{
        name: 'S',
        rows: [[1]],
        nativePictures: [AUTHORED_PIC],
        nativeShapes: [AUTHORED_SHAPE],
      } as SheetDataWithNativeDrawings],
      metadata: {},
    };
    const saved = adapter.write(data);
    const files = filesOf(saved);

    // Media part written byte-identical; drawing + rels + content types.
    const mediaPaths = Object.keys(files).filter((p) => p.startsWith('xl/media/'));
    expect(mediaPaths).toEqual(['xl/media/image1.png']);
    expect(bytesEqual(files['xl/media/image1.png']!, PNG_BYTES)).toBe(true);
    const drawingXml = partText(saved, 'xl/drawings/drawing1.xml');
    expect(drawingXml).toContain('<xdr:pic>');
    expect(drawingXml).toContain('r:embed=');
    expect(drawingXml).toContain('<xdr:sp');
    expect(drawingXml).toContain('prst="ellipse"');
    expect(drawingXml).toContain('<a:srgbClr val="00B050"/>');
    expect(partText(saved, 'xl/drawings/_rels/drawing1.xml.rels')).toContain('/image');
    expect(partText(saved, 'xl/drawings/_rels/drawing1.xml.rels')).toContain('image1.png');
    expect(partText(saved, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id=');
    const ct = partText(saved, '[Content_Types].xml');
    expect(ct).toContain('/xl/drawings/drawing1.xml');
    expect(ct).toContain('/xl/media/image1.png');

    // The importer reads the authored file back to the same model.
    const sheet = dataSheet(adapter.read(saved));
    expect(sheet.nativePictures).toHaveLength(1);
    const pic = sheet.nativePictures![0]!;
    expect(pic.anchor).toEqual(AUTHORED_PIC.anchor);
    expect(pic.name).toBe('Authored Logo');
    expect(pic.altText).toBe('Alt text here');
    expect(pic.contentType).toBe('image/png');
    expect(bytesEqual(pic.mediaBytes, PNG_BYTES)).toBe(true);
    expect(sheet.nativeShapes).toEqual([AUTHORED_SHAPE]);
  });

  it('authors a oneCellAnchor picture with its EMU ext', () => {
    const pic: NativePicture = {
      ...AUTHORED_PIC,
      anchor: {
        kind: 'oneCell',
        fromCol: 2, fromRow: 4, fromColOff: 0, fromRowOff: 0,
        toCol: 2, toRow: 4, toColOff: 0, toRowOff: 0,
        extCx: 914400, extCy: 457200,
      },
    };
    const data: WorkbookData = {
      sheets: [{ name: 'S', rows: [[1]], nativePictures: [pic] } as SheetDataWithNativeDrawings],
      metadata: {},
    };
    const saved = adapter.write(data);
    expect(partText(saved, 'xl/drawings/drawing1.xml')).toContain('<xdr:oneCellAnchor>');
    expect(partText(saved, 'xl/drawings/drawing1.xml')).toContain('<xdr:ext cx="914400" cy="457200"/>');
    const back = dataSheet(adapter.read(saved)).nativePictures![0]!;
    expect(back.anchor).toEqual(pic.anchor);
  });

  it('authorNativeDrawingParts appends to an existing drawing part', () => {
    const base = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    const files = filesOf(base);
    const first = authorNativeDrawingParts(files, 'S', [AUTHORED_PIC], []);
    const secondPic: NativePicture = { ...AUTHORED_PIC, name: 'Second', mediaBytes: JPEG_BYTES, contentType: 'image/jpeg' };
    const second = authorNativeDrawingParts(files, 'S', [secondPic], [AUTHORED_SHAPE]);
    expect(second.drawingPath).toBe(first.drawingPath);
    expect(Object.keys(files).filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p))).toHaveLength(1);
    const entry = readDrawings(files)[0]!;
    expect(entry.pictures).toHaveLength(2);
    expect(entry.pictures.map((p) => p.name)).toEqual(['Authored Logo', 'Second']);
    expect(bytesEqual(entry.pictures[1]!.mediaBytes, JPEG_BYTES)).toBe(true);
    expect(entry.shapes).toEqual([AUTHORED_SHAPE]);
    expect(() => authorNativeDrawingParts(files, 'NoSuchSheet', [AUTHORED_PIC], [])).toThrow(/not in the package/);
  });

  it('an edited model (raw stash cleared) is authored, not preserved', () => {
    const data = adapter.read(sourcePackage());
    const sheet = dataSheet(data);
    sheet.nativeDrawingsRaw = undefined;
    sheet.nativePictures = [AUTHORED_PIC];
    sheet.nativeShapes = [];
    const saved = adapter.write(data);
    const entry = readDrawings(filesOf(saved))[0]!;
    expect(entry.pictures).toHaveLength(1);
    expect(entry.pictures[0]!.name).toBe('Authored Logo');
    expect(entry.shapes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* No drawings = unchanged                                             */
/* ------------------------------------------------------------------ */

describe('files without drawings are unchanged', () => {
  it('write() of a plain workbook carries no drawing/media parts and no fields', () => {
    const data: WorkbookData = { sheets: [{ name: 'S', rows: [[1, 2], [3, 4]] }], metadata: {} };
    const saved = adapter.write(data);
    const files = filesOf(saved);
    expect(Object.keys(files).some((p) => p.startsWith('xl/drawings/'))).toBe(false);
    expect(Object.keys(files).some((p) => p.startsWith('xl/media/'))).toBe(false);
    expect(readDrawings(files)).toEqual([]);
    const sheet = dataSheet(adapter.read(saved));
    expect(sheet.nativePictures).toBeUndefined();
    expect(sheet.nativeShapes).toBeUndefined();
    expect(sheet.nativeDrawingsRaw).toBeUndefined();
  });

  it('injectNativeDrawings is a byte-identical no-op without drawing fields', () => {
    const bytes = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    expect(injectNativeDrawings(bytes, [{ name: 'S', rows: [[1]] }])).toBe(bytes);
    expect(injectNativeDrawings(bytes, [])).toBe(bytes);
  });
});

/* ------------------------------------------------------------------ */
/* Display-model seeding (File-2 defect D1)                            */
/* ------------------------------------------------------------------ */

interface SeededPicture {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
  name: string;
  sheet: string;
}
interface SeededTextBox {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  sheet: string;
}

describe('seedNativeDrawingDisplayModels: imported drawings reach the app overlay models', () => {
  it('seeds icecream.pictures + icecream.textboxes from a read, with anchor geometry in px', () => {
    const data = adapter.read(sourcePackage());
    const pictures = data.metadata['icecream.pictures'] as SeededPicture[];
    expect(Array.isArray(pictures)).toBe(true);
    expect(pictures).toHaveLength(2);
    const logo = pictures.find((p) => p.name === 'Logo');
    expect(logo).toBeTruthy();
    // twoCell B2:G10, offsets 9525/4763 EMU, default 64/20 grid metrics.
    expect(logo?.sheet).toBe('Data');
    expect(logo?.x).toBe(65);
    expect(logo?.y).toBe(21);
    expect(logo?.w).toBe(319);
    expect(logo?.h).toBe(159);
    expect(logo?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const icon = pictures.find((p) => p.name === 'Icon');
    // oneCell D4, ext 1828800x914400 EMU = 192x96 px.
    expect(icon?.x).toBe(192);
    expect(icon?.y).toBe(60);
    expect(icon?.w).toBe(192);
    expect(icon?.h).toBe(96);
    expect(icon?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);

    const boxes = data.metadata['icecream.textboxes'] as SeededTextBox[];
    expect(Array.isArray(boxes)).toBe(true);
    expect(boxes).toHaveLength(2);
    const banner = boxes.find((b) => b.text.includes('Hello'));
    expect(banner?.text).toBe('Hello\nWorld');
    expect(banner?.sheet).toBe('Data');
    expect(banner?.x).toBe(0);
    expect(banner?.y).toBe(220);
    expect(banner?.w).toBe(256);
    expect(banner?.h).toBe(80);
  });

  it('never overwrites an app-owned metadata value', () => {
    const sheets: SheetDataWithNativeDrawings[] = [
      {
        name: 'S',
        rows: [],
        nativePictures: [
          {
            anchor: { kind: 'oneCell', fromCol: 0, fromRow: 0, fromColOff: 0, fromRowOff: 0, toCol: 0, toRow: 0, toColOff: 0, toRowOff: 0, extCx: 95250, extCy: 95250 },
            mediaBytes: PNG_BYTES,
            name: 'P',
            altText: '',
            contentType: 'image/png',
          },
        ],
      },
    ];
    const metadata: Record<string, unknown> = { 'icecream.pictures': [] };
    seedNativeDrawingDisplayModels(sheets, metadata);
    expect(metadata['icecream.pictures']).toEqual([]);
  });

  it('nativeAnchorRectPx uses the sheet’s own column widths / row heights', () => {
    const rect = nativeAnchorRectPx(
      { kind: 'twoCell', fromCol: 1, fromRow: 0, fromColOff: 0, fromRowOff: 0, toCol: 2, toRow: 1, toColOff: 0, toRowOff: 0 },
      { name: 'S', rows: [], colWidths: { '0': 100, '1': 50, '2': 70 }, rowHeights: { '0': 30 } },
    );
    expect(rect).toEqual({ x: 100, y: 0, w: 50, h: 30 });
  });

  it('imagePixelSize reads PNG / GIF / JPEG headers', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const dv = new DataView(png.buffer);
    dv.setUint32(16, 120);
    dv.setUint32(20, 90);
    expect(imagePixelSize(png)).toEqual({ w: 120, h: 90 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 7, 0, 5, 0]);
    expect(imagePixelSize(gif)).toEqual({ w: 7, h: 5 });
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0xff, 0xc0, 0, 17, 8, 0, 64, 0, 96,
    ]);
    expect(imagePixelSize(jpeg)).toEqual({ w: 96, h: 64 });
    expect(imagePixelSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('the File-2 fixture seeds all 23 pictures and 13 text boxes with the anchors in the right places', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const buf = new Uint8Array(
      readFileSync(join(here, '../../../test-data/real-world/closedxml-TryToLoad-DrawingSizeInPx.xlsx')),
    );
    const data = adapter.read(buf);
    const pictures = data.metadata['icecream.pictures'] as SeededPicture[];
    expect(pictures).toHaveLength(23);
    for (const p of pictures) {
      expect(p.dataUrl).toMatch(/^data:image\/(png|jpeg);base64,/);
      expect(p.w).toBeGreaterThanOrEqual(8);
      expect(p.h).toBeGreaterThanOrEqual(8);
    }
    expect(pictures.filter((p) => p.sheet === 'Images')).toHaveLength(22);
    const icon = pictures.find((p) => p.sheet === 'icons');
    expect(icon).toBeTruthy();
    // M2 anchor: 12 columns of 73 px + 251460 EMU; span 14x18 px.
    expect(icon?.x).toBe(902);
    expect(icon?.y).toBe(23);
    expect(icon?.w).toBe(14);
    expect(icon?.h).toBe(18);

    const boxes = data.metadata['icecream.textboxes'] as SeededTextBox[];
    expect(boxes).toHaveLength(13);
    const urls = boxes.find((b) => b.sheet === 'International URLs');
    expect(urls?.text).toContain('This table determines the localized URLs');
    // Cols A..M at the sheet's own widths (143 + 267 + 10x73) + 114300 EMU.
    expect(urls?.w).toBe(1152);
    expect(boxes.filter((b) => b.sheet === 'Images')).toHaveLength(12);
  });
});
