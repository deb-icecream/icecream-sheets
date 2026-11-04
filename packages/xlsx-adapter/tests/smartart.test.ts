import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import {
  SMARTART_METADATA_KEY,
  SMARTART_PARTS_METADATA_KEY,
  injectSmartArtParts,
  layoutIdToFamily,
  readSmartArt,
  XlsxAdapter,
  type ImportedSmartArt,
  type SmartArtRawParts,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', '..', 'test-data', 'real-world', 'smartart-diagrams.xlsx');
/** Genuine Excel-authored org chart (Vertex42 template): <a:t> runs, suffixed layout id. */
const REAL_FIXTURE = join(HERE, '..', '..', '..', 'test-data', 'cycle6-fixtures', 'smartart.xlsx');

function filesOf(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes.slice()))) out[k] = v as Uint8Array;
  return out;
}

const ENC = new TextEncoder();
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Minimal single-sheet package with one diagram (used for edge cases). */
function minimalPackage(opts?: {
  layoutId?: string;
  layoutName?: string;
  items?: string[];
  omitLayout?: boolean;
  omitDm?: boolean;
}): Uint8Array {
  const layoutId = opts?.layoutId ?? 'basicCycle';
  const layoutName = opts?.layoutName ?? 'Basic Cycle';
  const items = opts?.items ?? ['One', 'Two', 'Three'];
  const pts = items
    .map((t) => `<dgm:pt modelId="{00000000-0000-0000-0000-000000000000}"><dgm:prSet/><dgm:spPr/><dgm:t>${t}</dgm:t></dgm:pt>`)
    .join('');
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': ENC.encode(
      `<workbook xmlns:r="${R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': ENC.encode(
      `<Relationships><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': ENC.encode(`<worksheet><sheetData/></worksheet>`),
    'xl/worksheets/_rels/sheet1.xml.rels': ENC.encode(
      `<Relationships><Relationship Id="rId1" Type="${R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    ),
    'xl/drawings/drawing1.xml': ENC.encode(
      `<xdr:wsDr><xdr:twoCellAnchor>` +
        `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="D1"/>` +
        `<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="${DGM}">` +
        `<dgm:relIds xmlns:dgm="${DGM}" xmlns:r="${R}" r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/>` +
        `</a:graphicData></a:graphic><xdr:clientData/></xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>`,
    ),
    'xl/drawings/_rels/drawing1.xml.rels': ENC.encode(
      `<Relationships>` +
        `<Relationship Id="rId1" Type="${R}/diagramData" Target="../diagrams/data1.xml"/>` +
        `<Relationship Id="rId2" Type="${R}/diagramLayout" Target="../diagrams/layout1.xml"/>` +
        `<Relationship Id="rId3" Type="${R}/diagramQuickStyle" Target="../diagrams/quickStyle1.xml"/>` +
        `<Relationship Id="rId4" Type="${R}/diagramColors" Target="../diagrams/colors1.xml"/>` +
        `</Relationships>`,
    ),
  };
  if (!opts?.omitDm) {
    files['xl/diagrams/data1.xml'] = ENC.encode(
      `<dgm:dataModel xmlns:dgm="${DGM}"><dgm:ptLst>${pts}</dgm:ptLst><dgm:cxnLst/>` +
        `<dgm:bg/><dgm:whole/></dgm:dataModel>`,
    );
  }
  if (!opts?.omitLayout) {
    files['xl/diagrams/layout1.xml'] = ENC.encode(
      `<dgm:layoutDef xmlns:dgm="${DGM}" name="${layoutName}" uniqueId="urn:microsoft.com/office/officeart/2005/8/layout/${layoutId}"/>`,
    );
  }
  files['xl/diagrams/colors1.xml'] = ENC.encode(`<dgm:colorsDef xmlns:dgm="${DGM}" name="C"/>`);
  files['xl/diagrams/quickStyle1.xml'] = ENC.encode(`<dgm:styleDef xmlns:dgm="${DGM}" name="S"/>`);
  return zipSync(files);
}

describe('layoutIdToFamily', () => {
  it('maps exact catalogue ids to all seven families', () => {
    const cases: Array<[string, string]> = [
      ['basicBlockList', 'list'],
      ['basicChevronProcess', 'process'],
      ['basicCycle', 'cycle'],
      ['orgChart', 'hierarchy'],
      ['tableHierarchy', 'hierarchy'],
      ['basicVenn', 'relationship'],
      ['basicRadial', 'relationship'],
      ['basicPyramid', 'pyramid'],
      ['segmentedPyramid', 'pyramid'],
      ['gridMatrix', 'matrix'],
      ['cycleMatrix', 'matrix'],
    ];
    for (const [id, family] of cases) {
      const r = layoutIdToFamily(id, id);
      expect(r.family).toBe(family);
      expect(r.fallbackNote).toBeNull();
    }
  });

  it('strips "+" suffixes for exact matches (pictureOrgChart+Icon)', () => {
    const r = layoutIdToFamily('pictureOrgChart+Icon', 'Picture Organization Chart');
    expect(r.family).toBe('hierarchy');
    expect(r.fallbackNote).toBeNull();
  });

  it('falls back via keyword heuristics and reports the substitution', () => {
    const r = layoutIdToFamily('mysticFunnelWidget', 'Mystic Funnel Widget');
    expect(r.family).toBe('process');
    expect(r.fallbackNote).not.toBeNull();
    expect(r.fallbackNote!).toContain('Mystic Funnel Widget');
    expect(r.fallbackNote!).toContain('Process');
    expect(layoutIdToFamily('fancyPyramidX', 'Fancy Pyramid X').family).toBe('pyramid');
    expect(layoutIdToFamily('weirdMatrixZ', 'Weird Matrix Z').family).toBe('matrix');
    expect(layoutIdToFamily('totallyUnknownLayout', 'Totally Unknown').family).toBe('process');
    expect(layoutIdToFamily('', '').fallbackNote).not.toBeNull();
  });
});

describe('readSmartArt', () => {
  it('parses all three diagrams from the real fixture', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const { diagrams, rawParts } = readSmartArt(filesOf(bytes));
    expect(diagrams.length).toBe(3);

    const bySheet = new Map(diagrams.map((d) => [d.sheetName, d]));
    const proc = bySheet.get('Process')!;
    expect(proc.layoutId).toBe('basicProcess');
    expect(proc.layoutName).toBe('Basic Process');
    expect(proc.family).toBe('process');
    expect(proc.fallbackNote).toBeNull();
    expect(proc.items).toEqual(['Gather requirements', 'Design', 'Build', 'Validate & ship']);
    expect(proc.anchor).toMatchObject({ fromCol: 1, fromRow: 1, toCol: 8, toRow: 18 });
    expect(proc.sheetIndex).toBe(0);

    const org = bySheet.get('Org')!;
    expect(org.layoutId).toBe('orgChart');
    expect(org.family).toBe('hierarchy');
    expect(org.fallbackNote).toBeNull();
    expect(org.items).toEqual([
      'Ava Chen (CEO)',
      'Ben Ortiz (CTO)',
      'Cara Lin (CFO)',
      'Dan Wu (COO)',
    ]);

    const fb = bySheet.get('Fallback')!;
    expect(fb.layoutId).toBe('mysticFunnelWidget');
    expect(fb.family).toBe('process');
    expect(fb.fallbackNote).not.toBeNull();
    expect(fb.fallbackNote!).toContain('Mystic Funnel Widget');
    expect(fb.items).toEqual(['Awareness', 'Interest', 'Decision']);

    // Raw parts stashed for round-trip: 3 sheets × 4 parts.
    expect(rawParts.diagrams.length).toBe(3);
    expect(Object.keys(rawParts.parts).length).toBe(12);
  });

  it('skips empty-text structural points', () => {
    const bytes = minimalPackage({
      items: ['Alpha', '', 'Gamma'],
      layoutId: 'verticalBulletList',
      layoutName: 'Vertical Bullet List',
    });
    const { diagrams } = readSmartArt(filesOf(bytes));
    expect(diagrams.length).toBe(1);
    expect(diagrams[0].items).toEqual(['Alpha', 'Gamma']);
    expect(diagrams[0].family).toBe('list');
  });

  it('parses genuine Excel-authored SmartArt: <a:t> runs, title layout name', () => {
    const bytes = new Uint8Array(readFileSync(REAL_FIXTURE));
    const { diagrams } = readSmartArt(filesOf(bytes));
    expect(diagrams.length).toBe(1);
    const d = diagrams[0];
    expect(d.sheetName).toBe('Company Organization Chart');
    expect(d.layoutId).toBe('pictureOrgChart+Icon');
    // Real files omit layoutDef/@name; the name comes from <dgm:title val>.
    expect(d.layoutName).toBe('Picture Organization Chart');
    expect(d.family).toBe('hierarchy');
    expect(d.fallbackNote).toBeNull();
    expect(d.items.length).toBe(16);
    expect(d.items[0]).toBe('President [Name]');
    expect(d.items[1]).toBe('VP - Sales [Name]');
    expect(d.items[2]).toBe('VP - Production [Name]');
    // Multi-paragraph nodes join paragraphs with a space.
    expect(d.items[4]).toBe('Manager [Department] [Name] [Phone / Email]');
    // No raw drawingML markup leaks into the labels.
    expect(d.items.every((t) => !/[<>]/.test(t))).toBe(true);
    expect(d.anchor).toMatchObject({ fromCol: 0, fromRow: 4, toCol: 8, toRow: 47 });
  });

  it('never throws and yields nothing when parts are missing', () => {
    expect(readSmartArt(filesOf(minimalPackage({ omitLayout: true }))).diagrams).toEqual([]);
    expect(readSmartArt(filesOf(minimalPackage({ omitDm: true }))).diagrams).toEqual([]);
    expect(readSmartArt({})).toEqual({ diagrams: [], rawParts: { diagrams: [], parts: {} } });
  });

  it('attaches diagrams to workbook metadata on read()', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(new Uint8Array(readFileSync(FIXTURE)));
    const raw = data.metadata[SMARTART_METADATA_KEY];
    expect(typeof raw).toBe('string');
    const diagrams = JSON.parse(raw as string) as ImportedSmartArt[];
    expect(diagrams.length).toBe(3);
    expect(diagrams.every((d) => d.items.length > 0)).toBe(true);
    const rawParts = data.metadata[SMARTART_PARTS_METADATA_KEY] as SmartArtRawParts;
    expect(rawParts.diagrams.length).toBe(3);
  });
});

describe('injectSmartArtParts', () => {
  it('round-trips diagram parts byte-for-byte through write()', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(new Uint8Array(readFileSync(FIXTURE)));
    const before = data.metadata[SMARTART_PARTS_METADATA_KEY] as SmartArtRawParts;

    const saved = adapter.write(data);
    const files = filesOf(saved);

    // Every original part is back, byte-identical.
    for (const [path, b64] of Object.entries(before.parts)) {
      expect(files[path], `missing ${path}`).toBeDefined();
      const restored = Buffer.from(b64, 'base64');
      expect(Buffer.from(files[path]).equals(restored), `corrupt ${path}`).toBe(true);
    }
    // Drawing parts + rels re-emitted and wired to the sheets.
    const drawings = Object.keys(files).filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p));
    expect(drawings.length).toBe(3);
    const relsFiles = Object.keys(files).filter((p) => /_rels\/drawing\d+\.xml\.rels$/.test(p));
    expect(relsFiles.length).toBe(3);
    for (const dp of drawings) {
      const xml = new TextDecoder().decode(files[dp]);
      expect(xml).toContain('dgm:relIds');
      expect(xml).toContain('http://schemas.openxmlformats.org/drawingml/2006/diagram');
    }
    // Content types cover the re-emitted parts.
    const ct = new TextDecoder().decode(files['[Content_Types].xml']);
    expect(ct).toContain('diagramData+xml');
    expect(ct).toContain('diagramLayout+xml');
    // The round-tripped file still parses to the same three diagrams.
    const { diagrams } = readSmartArt(files);
    expect(diagrams.length).toBe(3);
    const texts = diagrams.map((d) => d.items.join('|')).sort();
    expect(texts).toContain('Gather requirements|Design|Build|Validate & ship');
    expect(texts).toContain('Ava Chen (CEO)|Ben Ortiz (CTO)|Cara Lin (CFO)|Dan Wu (COO)');
  });

  it('is a no-op without raw parts and never throws on garbage', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    expect(injectSmartArtParts(bytes, undefined)).toBe(bytes);
    expect(injectSmartArtParts(bytes, {})).toBe(bytes);
    expect(injectSmartArtParts(bytes, { diagrams: [], parts: {} })).toBe(bytes);
  });
});
