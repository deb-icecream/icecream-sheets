/**
 * Native XLSX SmartArt (drawingML diagram) import.
 *
 * SheetJS community edition drops drawingML diagrams entirely, so this
 * module reads them directly from the OOXML package with fflate (the same
 * unzip-only pattern as charts.ts — no new dependencies):
 *
 * - read:  for every worksheet part, follow
 *          `xl/worksheets/_rels/sheetN.xml.rels` → drawing part →
 *          `xl/drawings/drawingN.xml` (`xdr:graphicFrame` →
 *          `a:graphicData` with the `.../diagram` uri → `dgm:relIds`
 *          `r:dm/r:lo/r:qs/r:cs`) → `xl/drawings/_rels/drawingN.xml.rels` →
 *          diagram parts (`xl/diagrams/dataN.xml` for the text model,
 *          `xl/diagrams/layoutN.xml` for the layout identity, plus
 *          colors/quickStyle for byte-for-byte round-trip).
 *
 * Design-doc note (checked 2026-10-19): the 13 design docs are silent on
 * imported drawingML diagrams — native-reports-and-dashboards.md covers
 * report/dashboard visuals bound to tables and queries, not XLSX SmartArt
 * import. The mapping below is therefore the module's own contract:
 * EVERY diagram layout maps to a SmartArt family — never skipped
 * (user-locked requirement 2026-10-19). Layouts with no exact family map
 * to the closest family via keyword heuristics and carry a `fallbackNote`
 * so the web app can show the substitution visibly; nothing is ever
 * silently dropped.
 */

import { unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';

export type SmartArtFamily =
  | 'list'
  | 'process'
  | 'cycle'
  | 'hierarchy'
  | 'relationship'
  | 'pyramid'
  | 'matrix';

export interface SmartArtAnchor {
  /** 0-based. */
  fromCol: number;
  /** 0-based. */
  fromRow: number;
  /** 0-based. */
  toCol: number;
  /** 0-based. */
  toRow: number;
}

export interface ImportedSmartArt {
  /** 0-based index into the workbook's sheet order. */
  sheetIndex: number;
  /** Exact sheet name (matches the loaded sheet). */
  sheetName: string;
  /** Layout identity tail, e.g. 'basicProcess' (from the layoutDef uniqueId). */
  layoutId: string;
  /** Layout display name, e.g. 'Basic Process' (from the layoutDef name). */
  layoutName: string;
  /** Resolved render family — never empty. */
  family: SmartArtFamily;
  /** Null when the layout mapped exactly; otherwise a human-readable note
   *  describing the closest-kind substitution (for the visible note). */
  fallbackNote: string | null;
  /** Node text in document order (empty-text structural points omitted). */
  items: string[];
  anchor: SmartArtAnchor;
}

/** Workbook-metadata key (contract shared with the web app). */
export const SMARTART_METADATA_KEY = 'icecream.smartart';
/** Raw-parts key (contract shared with the write path; not user metadata). */
export const SMARTART_PARTS_METADATA_KEY = 'xlsx.smartartParts';

/** graphicData uri that marks a graphicFrame as a SmartArt diagram. */
const DIAGRAM_URI = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const LAYOUT_URN_PREFIX = 'urn:microsoft.com/office/officeart/2005/8/layout/';

/** Minimal XML entity unescape for text/attribute values. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

/** All `<prefix:name ...>...</prefix:name>` blocks (non-greedy). */
function elements(xml: string, qualified: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${qualified}[\\s>][\\s\\S]*?</${qualified}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

/** Integer child element value (`<xdr:col>1</xdr:col>`), or null. */
function intChild(xml: string, qualified: string): number | null {
  const m = new RegExp(`<${qualified}>(-?\\d+)</${qualified}>`).exec(xml);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Resolve a relationship Target (possibly `../`-relative) against the part
 * that owns the .rels file.
 */
function resolveTarget(ownerPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const dir = ownerPart.includes('/') ? ownerPart.slice(0, ownerPart.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  for (const seg of (dir + target).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** r:id → resolved part path for relationships whose Type ends with `suffix`. */
function relTargets(
  files: Record<string, Uint8Array>,
  relsPath: string,
  typeSuffix: string,
  ownerPart: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const raw = files[relsPath];
  if (!raw) return out;
  const rels = new TextDecoder().decode(raw);
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    const type = attr(tag, 'Type') ?? '';
    if (id && target && type.endsWith(typeSuffix)) {
      out.set(id, resolveTarget(ownerPart, target));
    }
  }
  return out;
}

/** Sheet name → worksheet part path, via xl/workbook.xml. Exact: no sheetN guessing. */
function sheetPartPaths(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) return out;
  const wb = new TextDecoder().decode(wbXml);
  const targetByRid = relTargets(files, 'xl/_rels/workbook.xml.rels', '/worksheet', 'xl/workbook.xml');
  for (const tag of wb.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id');
    if (name && rid) {
      const path = targetByRid.get(rid);
      if (path) out.push({ name, path });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout → family mapping
// ---------------------------------------------------------------------------

/**
 * Exact layout-id → family map. layoutId is the tail of the layoutDef
 * uniqueId (`urn:microsoft.com/office/officeart/2005/8/layout/<id>`).
 * Covers the mainstream SmartArt catalogue; anything missing falls through
 * to keyword heuristics, and anything still unmatched falls back to
 * 'process' — the mapping NEVER fails (never silently dropped).
 */
const EXACT_FAMILY: Record<string, SmartArtFamily> = {
  // List
  basicBlockList: 'list',
  horizontalBulletList: 'list',
  verticalBulletList: 'list',
  verticalBoxList: 'list',
  tabbedArcList: 'list',
  trapezoidList: 'list',
  tableList: 'list',
  stackList: 'list',
  descendingBlockList: 'list',
  squareAccentList: 'list',
  verticalBracketList: 'list',
  horizontalPictureList: 'list',
  verticalPictureList: 'list',
  // Process
  basicProcess: 'process',
  basicChevronProcess: 'process',
  basicTimeline: 'process',
  circleAccentTimeline: 'process',
  chevronList: 'process',
  closedChevronProcess: 'process',
  continuousArrowProcess: 'process',
  continuousBlockProcess: 'process',
  detailedProcess: 'process',
  descendingProcess: 'process',
  funnel: 'process',
  gear: 'process',
  increasingArrowsProcess: 'process',
  increasingCircleProcess: 'process',
  interleavedProcess: 'process',
  oppositeArrows: 'process',
  phasedProcess: 'process',
  randomToResultProcess: 'process',
  repeatingBendingProcess: 'process',
  staggeredProcess: 'process',
  stepDownProcess: 'process',
  stepUpProcess: 'process',
  subStepProcess: 'process',
  upArrow: 'process',
  alternatingFlow: 'process',
  arrowRibbon: 'process',
  // Cycle
  basicCycle: 'cycle',
  basicPie: 'cycle',
  blockCycle: 'cycle',
  continuousCycle: 'cycle',
  multidirectionalCycle: 'cycle',
  nonDirectionalCycle: 'cycle',
  opposingIdeas: 'cycle',
  segmentedCycle: 'cycle',
  textCycle: 'cycle',
  radialCycle: 'cycle',
  // Hierarchy
  tableHierarchy: 'hierarchy',
  labelledHierarchy: 'hierarchy',
  labeledHierarchy: 'hierarchy',
  hierarchy: 'hierarchy',
  orgChart: 'hierarchy',
  organizationChart: 'hierarchy',
  horizontalOrganizationChart: 'hierarchy',
  halfCircleOrganizationChart: 'hierarchy',
  circlePictureHierarchy: 'hierarchy',
  horizontalHierarchy: 'hierarchy',
  horizontalLabeledHierarchy: 'hierarchy',
  horizontalLabelledHierarchy: 'hierarchy',
  nameAndTitleOrganizationChart: 'hierarchy',
  nameAndTitleOrgChart: 'hierarchy',
  pictureOrganizationChart: 'hierarchy',
  pictureOrgChart: 'hierarchy',
  // Relationship
  basicRadial: 'relationship',
  basicTarget: 'relationship',
  basicVenn: 'relationship',
  bracketText: 'relationship',
  convergingArrows: 'relationship',
  divergingArrows: 'relationship',
  counterBalanceArrows: 'relationship',
  plusAndMinus: 'relationship',
  radialList: 'relationship',
  radialVenn: 'relationship',
  relationshipPicture: 'relationship',
  segmentedProcess: 'relationship',
  stackedVenn: 'relationship',
  arrowLoop: 'relationship',
  nestedTarget: 'relationship',
  bubblePictureList: 'relationship',
  circleRelationship: 'relationship',
  // Pyramid
  basicPyramid: 'pyramid',
  invertedPyramid: 'pyramid',
  segmentedPyramid: 'pyramid',
  // Matrix
  basicMatrix: 'matrix',
  cycleMatrix: 'matrix',
  gridMatrix: 'matrix',
  titleMatrix: 'matrix',
};

interface FamilyResolution {
  family: SmartArtFamily;
  /** Null when the layout mapped exactly; otherwise the closest-kind note. */
  fallbackNote: string | null;
}

function displayName(layoutId: string, layoutName: string): string {
  return layoutName || layoutId || 'Unnamed layout';
}

/**
 * Map a layoutDef identity to a render family. Never throws and never
 * fails: exact map → keyword heuristics → 'process' default. The default
 * is reported, never silent.
 */
export function layoutIdToFamily(layoutId: string, layoutName: string): FamilyResolution {
  const id = (layoutId || '').trim();
  const exact = EXACT_FAMILY[id];
  if (exact) return { family: exact, fallbackNote: null };
  // Real Excel-authored files carry suffixed layout ids (e.g.
  // 'pictureOrgChart+Icon'); the base catalogue id is the exact match.
  const plus = id.indexOf('+');
  if (plus > 0) {
    const base = EXACT_FAMILY[id.slice(0, plus)];
    if (base) return { family: base, fallbackNote: null };
  }
  const lower = id.toLowerCase();
  const name = displayName(id, layoutName);
  const keyword = (family: SmartArtFamily, words: string[]): boolean =>
    words.some((w) => lower.includes(w));
  let family: SmartArtFamily;
  if (keyword('pyramid', ['pyramid'])) family = 'pyramid';
  else if (keyword('matrix', ['matrix'])) family = 'matrix';
  else if (keyword('cycle', ['cycle'])) family = 'cycle';
  else if (keyword('relationship', ['venn', 'radial', 'target', 'converging', 'diverging', 'balance'])) family = 'relationship';
  else if (keyword('hierarchy', ['hierarch', 'orgchart', 'organization', 'org '])) family = 'hierarchy';
  else if (
    keyword('process', ['process', 'chevron', 'timeline', 'funnel', 'flow', 'arrow', 'gear', 'step', 'ribbon', 'accent'])
  )
    family = 'process';
  else if (keyword('list', ['list', 'bullet', 'stack', 'trapezoid', 'bracket'])) family = 'list';
  else family = 'process';
  return {
    family,
    fallbackNote:
      `SmartArt layout "${name}" (${id || 'unknown id'}) has no exact layout renderer; ` +
      `rendered as ${family.charAt(0).toUpperCase() + family.slice(1)} (closest match).`,
  };
}

// ---------------------------------------------------------------------------
// Diagram part parsing
// ---------------------------------------------------------------------------

/** Layout identity from `xl/diagrams/layoutN.xml`. */
function parseLayout(layoutXml: string): { layoutId: string; layoutName: string } {
  const defTag = /<dgm:layoutDef\b[^>]*>/.exec(layoutXml)?.[0] ?? '';
  const uniqueId = attr(defTag, 'uniqueId') ?? '';
  let layoutId = uniqueId;
  if (uniqueId.startsWith(LAYOUT_URN_PREFIX)) layoutId = uniqueId.slice(LAYOUT_URN_PREFIX.length);
  // Genuine Excel-authored files often omit layoutDef/@name and carry the
  // display name on <dgm:title val="..."/>.
  const titleTag = /<dgm:title\b[^>]*>/.exec(layoutXml)?.[0] ?? '';
  const layoutName = attr(defTag, 'name') || attr(titleTag, 'val') || '';
  return { layoutId, layoutName };
}

/**
 * Text items from `xl/diagrams/dataN.xml`: the display text of every
 * `<dgm:pt>` in document order. Genuine Excel-authored files nest the text
 * in drawingML runs — `<dgm:t>` wraps `<a:p>` paragraphs of `<a:r>` runs
 * with `<a:t>` text; each paragraph's runs are concatenated and paragraphs
 * joined with a space. Programmatic fixtures sometimes carry plain text
 * directly inside `<dgm:t>` (no `<a:t>` runs) — strip the tags then.
 * Points with no text are structural containers (e.g. the document root)
 * and are omitted.
 */
function parseDataModel(dataXml: string): string[] {
  const items: string[] = [];
  for (const pt of elements(dataXml, 'dgm:pt')) {
    const text = ptText(pt);
    if (text) items.push(text);
  }
  return items;
}

/** All `<a:t>` run texts inside a scope (tags stripped, entities unescaped). */
function aTextRuns(scope: string): string[] {
  const runs: string[] = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const run = unescapeXml(m[1].replace(/<[^>]+>/g, ''));
    if (run) runs.push(run);
  }
  return runs;
}

/** Display text of one `<dgm:pt>` ('' when it has no text). */
function ptText(pt: string): string {
  const body = element(pt, 'dgm:t') || pt;
  const paragraphs: string[] = [];
  const pBlocks = elements(body, 'a:p');
  for (const block of pBlocks.length > 0 ? pBlocks : [body]) {
    const para = aTextRuns(block).join('').replace(/\s+/g, ' ').trim();
    if (para) paragraphs.push(para);
  }
  if (paragraphs.length > 0) return paragraphs.join(' ');
  // Fallback: plain text directly inside <dgm:t> (programmatic fixtures).
  const texts: string[] = [];
  const re = /<dgm:t(?:\s[^>]*)?>([\s\S]*?)<\/dgm:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = unescapeXml(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (t) texts.push(t);
  }
  return texts.join(' ');
}

interface DiagramAnchor {
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
}

/** Anchor cells from the enclosing xdr anchor of a graphicFrame. */
function anchorOf(anchorXml: string): DiagramAnchor {
  const from = element(anchorXml, 'xdr:from');
  const to = element(anchorXml, 'xdr:to');
  const fromCol = Math.max(0, (from ? intChild(from, 'xdr:col') : null) ?? 0);
  const fromRow = Math.max(0, (from ? intChild(from, 'xdr:row') : null) ?? 0);
  const toCol = Math.max(fromCol + 1, (to ? intChild(to, 'xdr:col') : null) ?? fromCol + 5);
  const toRow = Math.max(fromRow + 1, (to ? intChild(to, 'xdr:row') : null) ?? fromRow + 8);
  return { fromCol, fromRow, toCol, toRow };
}

function element(xml: string, qualified: string): string {
  const m = new RegExp(`<${qualified}[\\s>][\\s\\S]*?</${qualified}>`).exec(xml);
  return m ? m[0] : '';
}

/** Raw diagram parts kept for byte-for-byte round-trip on save. */
export interface SmartArtRawParts {
  diagrams: Array<{
    sheetName: string;
    anchor: DiagramAnchor;
    /** Part paths for dm/lo/qs/cs, in that order. */
    partPaths: [string, string, string, string];
  }>;
  /** part path → base64 bytes (diagram data/layout/colors/quickStyle parts). */
  parts: Record<string, string>;
}

export interface ReadSmartArtResult {
  diagrams: ImportedSmartArt[];
  rawParts: SmartArtRawParts;
}

const DEC = new TextDecoder();
const ENC = new TextEncoder();

function u8ToBase64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

/**
 * Read all drawingML SmartArt diagrams from an unzipped OOXML package
 * (path → bytes, as produced by fflate's unzipSync).
 * Never throws: any missing/corrupt part yields fewer diagrams, never an error.
 */
export function readSmartArt(files: Record<string, Uint8Array>): ReadSmartArtResult {
  const diagrams: ImportedSmartArt[] = [];
  const rawParts: SmartArtRawParts = { diagrams: [], parts: {} };
  try {
    const sheets = sheetPartPaths(files);
    sheets.forEach(({ name: sheetName, path: sheetPath }, sheetIndex) => {
      // sheetN.xml → xl/worksheets/_rels/sheetN.xml.rels → drawing part.
      const dir = sheetPath.includes('/') ? sheetPath.slice(0, sheetPath.lastIndexOf('/')) : '';
      const sheetRelsPath = `${dir}/_rels/${sheetPath.slice(sheetPath.lastIndexOf('/') + 1)}.rels`;
      const drawingByRid = relTargets(files, sheetRelsPath, '/drawing', sheetPath);
      for (const drawingPath of drawingByRid.values()) {
        const drawingRaw = files[drawingPath];
        if (!drawingRaw) continue;
        const drawing = DEC.decode(drawingRaw);
        const diagramByRid = new Map<string, Map<string, string>>();
        // Group rel targets by relationship so r:dm/r:lo/r:qs/r:cs resolve
        // to the right part kinds.
        const relsPath = drawingPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
        const dmByRid = relTargets(files, relsPath, '/diagramData', drawingPath);
        const loByRid = relTargets(files, relsPath, '/diagramLayout', drawingPath);
        const qsByRid = relTargets(files, relsPath, '/diagramQuickStyle', drawingPath);
        const csByRid = relTargets(files, relsPath, '/diagramColors', drawingPath);
        diagramByRid.set('dm', dmByRid);
        diagramByRid.set('lo', loByRid);
        diagramByRid.set('qs', qsByRid);
        diagramByRid.set('cs', csByRid);
        // A graphicFrame may sit in any xdr anchor flavour.
        const anchors = [
          ...elements(drawing, 'xdr:twoCellAnchor'),
          ...elements(drawing, 'xdr:oneCellAnchor'),
          ...elements(drawing, 'xdr:absoluteAnchor'),
        ];
        for (const anchorXml of anchors) {
          for (const frame of elements(anchorXml, 'xdr:graphicFrame')) {
            const graphicData = element(frame, 'a:graphicData');
            const uri = /<a:graphicData\b[^>]*>/.exec(graphicData)?.[0] ?? '';
            if (attr(uri, 'uri') !== DIAGRAM_URI) continue;
            const relIdsTag = /<dgm:relIds\b[^>]*\/?>/.exec(frame)?.[0] ?? '';
            const dmRid = attr(relIdsTag, 'r:dm');
            const loRid = attr(relIdsTag, 'r:lo');
            const qsRid = attr(relIdsTag, 'r:qs');
            const csRid = attr(relIdsTag, 'r:cs');
            const dmPath = dmRid ? dmByRid.get(dmRid) : undefined;
            const loPath = loRid ? loByRid.get(loRid) : undefined;
            const qsPath = qsRid ? qsByRid.get(qsRid) : undefined;
            const csPath = csRid ? csByRid.get(csRid) : undefined;
            if (!dmPath || !loPath) continue;
            const dmRaw = files[dmPath];
            const loRaw = files[loPath];
            if (!dmRaw || !loRaw) continue;
            const { layoutId, layoutName } = parseLayout(DEC.decode(loRaw));
            const { family, fallbackNote } = layoutIdToFamily(layoutId, layoutName);
            const items = parseDataModel(DEC.decode(dmRaw));
            const anchor = anchorOf(anchorXml);
            diagrams.push({
              sheetIndex,
              sheetName,
              layoutId,
              layoutName,
              family,
              fallbackNote,
              items,
              anchor,
            });
            // Stash raw part bytes for the write path. qs/cs are optional
            // (some producers omit them); dm/lo are required and present.
            const partPaths: [string, string, string, string] = [
              dmPath,
              loPath,
              qsPath ?? '',
              csPath ?? '',
            ];
            for (const p of partPaths) {
              const raw = p ? files[p] : undefined;
              if (raw && !rawParts.parts[p]) rawParts.parts[p] = u8ToBase64(raw);
            }
            rawParts.diagrams.push({ sheetName, anchor, partPaths });
          }
        }
      }
    });
  } catch {
    // Best-effort: SmartArt import must never break the open.
  }
  return { diagrams, rawParts };
}

// ---------------------------------------------------------------------------
// Round-trip: re-emit diagram parts on save
// ---------------------------------------------------------------------------

const DIAGRAM_CONTENT_TYPES: Record<string, string> = {
  data: 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml',
  layout: 'application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml',
  colors: 'application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml',
  quickStyle: 'application/vnd.openxmlformats-officedocument.drawingml.diagramQuickStyle+xml',
};

function partKindOf(path: string): keyof typeof DIAGRAM_CONTENT_TYPES | null {
  if (/\/data\d+\.xml$/.test(path)) return 'data';
  if (/\/layout\d+\.xml$/.test(path)) return 'layout';
  if (/\/colors\d+\.xml$/.test(path)) return 'colors';
  if (/\/quickStyle\d+\.xml$/.test(path)) return 'quickStyle';
  return null;
}

function ensureContentType(files: Record<string, Uint8Array>, path: string): void {
  const kind = partKindOf(path);
  const ct = kind ? DIAGRAM_CONTENT_TYPES[kind] : undefined;
  if (!ct) return;
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return;
  let xml = DEC.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return;
  if (!xml.includes('</Types>')) return;
  xml = xml.replace('</Types>', `<Override PartName="/${path}" ContentType="${ct}"/></Types>`);
  files[ctPath] = ENC.encode(xml);
}

function ensureDrawingContentType(files: Record<string, Uint8Array>, path: string): void {
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return;
  let xml = DEC.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return;
  if (!xml.includes('</Types>')) return;
  xml = xml.replace(
    '</Types>',
    `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.drawing+xml"/></Types>`,
  );
  files[ctPath] = ENC.encode(xml);
}

function base64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Pick a part path that does not collide with an existing one. */
function freePartPath(files: Record<string, Uint8Array>, dir: string, stem: string, ext: string): string {
  let n = 1;
  while (files[`${dir}/${stem}${n}.${ext}`]) n += 1;
  return `${dir}/${stem}${n}.${ext}`;
}

function buildDrawingXml(frames: Array<{ anchor: DiagramAnchor; rids: [string, string, string, string] }>): string {
  const anchors = frames
    .map(({ anchor: a, rids }, i) => {
      const id = i + 2;
      return (
        `<xdr:twoCellAnchor>` +
        `<xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
        `<xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
        `<xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro="">` +
        `<xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="SmartArt ${i + 1}"/>` +
        `<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="${DIAGRAM_URI}">` +
        `<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
        `r:dm="${rids[0]}" r:lo="${rids[1]}" r:qs="${rids[2]}" r:cs="${rids[3]}"/>` +
        `</a:graphicData></a:graphic><xdr:clientData/>` +
        `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      );
    })
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`
  );
}

const REL_TYPES = {
  dm: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData',
  lo: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout',
  qs: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle',
  cs: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors',
} as const;

/**
 * Re-emit SmartArt diagrams into a saved package: the original diagram
 * parts (data/layout/colors/quickStyle) go back byte-for-byte, a fresh
 * drawing part per sheet re-anchors them, and the sheet rels are wired.
 * Mirrors the pivot-table round-trip pattern. Never throws and never
 * fails the save — a hint must not break one.
 */
export function injectSmartArtParts(
  packageBytes: Uint8Array,
  rawParts: SmartArtRawParts | unknown,
): Uint8Array {
  try {
    if (!rawParts || typeof rawParts !== 'object') return packageBytes;
    const rp = rawParts as SmartArtRawParts;
    if (!Array.isArray(rp.diagrams) || rp.diagrams.length === 0) return packageBytes;
    const parts = rp.parts ?? {};
    const partPaths = Object.keys(parts).filter(
      (p) => typeof parts[p] === 'string' && (parts[p] as string).length > 0,
    );
    if (partPaths.length === 0) return packageBytes;

    // fflate is the adapter's unzip/zip engine (same as the rest of the
    // write path); re-zip deterministically via zipSyncStable.
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;

    // 1. Re-add the diagram part bytes (rename on collision).
    const remap = new Map<string, string>();
    for (const p of partPaths) {
      const target = files[p] ? freePartPath(files, 'xl/diagrams', p.split('/').pop()!.replace(/\d+\.xml$/, ''), 'xml') : p;
      try {
        files[target] = base64ToU8(parts[p]);
      } catch {
        continue;
      }
      remap.set(p, target);
      ensureContentType(files, target);
    }
    if (remap.size === 0) return packageBytes;

    // 2. Sheet names in the SAVED workbook (SheetJS order) → sheet part paths.
    const sheets = sheetPartPaths(files);
    const sheetPathByName = new Map(sheets.map((s) => [s.name, s.path]));

    // 3. Group diagrams by sheet; build one drawing part per sheet.
    const bySheet = new Map<string, Array<{ anchor: DiagramAnchor; partPaths: [string, string, string, string] }>>();
    for (const d of rp.diagrams) {
      const list = bySheet.get(d.sheetName) ?? [];
      list.push(d);
      bySheet.set(d.sheetName, list);
    }
    let touched = false;
    for (const [sheetName, list] of bySheet) {
      const sheetPath = sheetPathByName.get(sheetName);
      if (!sheetPath) continue;
      const frames: Array<{ anchor: DiagramAnchor; rids: [string, string, string, string] }> = [];
      const targets: Array<[string, string, string, string]> = [];
      for (const d of list) {
        const resolved = d.partPaths.map((p) => remap.get(p) ?? '') as [string, string, string, string];
        if (!resolved[0] || !resolved[1]) continue;
        // qs/cs are optional parts; re-emit an empty self-reference-free
        // rel only when the part exists. Excel tolerates missing qs/cs.
        const rids: [string, string, string, string] = ['rId1', 'rId2', 'rId3', 'rId4'];
        frames.push({ anchor: d.anchor, rids });
        targets.push(resolved);
      }
      if (frames.length === 0) continue;
      // One drawing part + rels per sheet, serving all its diagrams.
      const drawingPath = freePartPath(files, 'xl/drawings', 'drawing', 'xml');
      // Merge all diagram rels into one rels file with unique rIds.
      const allRels: string[] = [];
      const framesWithRids = frames.map(({ anchor }, i) => {
        const base = i * 4;
        const rids: [string, string, string, string] = [
          `rId${base + 1}`,
          `rId${base + 2}`,
          `rId${base + 3}`,
          `rId${base + 4}`,
        ];
        const t = targets[i];
        const rel = (id: string, type: string, target: string) =>
          `<Relationship Id="${id}" Type="${type}" Target="../diagrams/${escapeAttr(target.split('/').pop() ?? target)}"/>`;
        allRels.push(rel(rids[0], REL_TYPES.dm, t[0]));
        allRels.push(rel(rids[1], REL_TYPES.lo, t[1]));
        if (files[t[2]]) allRels.push(rel(rids[2], REL_TYPES.qs, t[2]));
        if (files[t[3]]) allRels.push(rel(rids[3], REL_TYPES.cs, t[3]));
        return { anchor, rids };
      });
      files[drawingPath] = ENC.encode(buildDrawingXml(framesWithRids));
      ensureDrawingContentType(files, drawingPath);
      const relsPath = drawingPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
      files[relsPath] = ENC.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${allRels.join('')}</Relationships>`,
      );
      // Wire the sheet → drawing relationship.
      const sheetRelsPath = sheetPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
      const drawingTarget = `../drawings/${drawingPath.split('/').pop()}`;
      const existing = files[sheetRelsPath] ? DEC.decode(files[sheetRelsPath]) : '';
      if (!existing.includes(`Target="${drawingTarget}"`)) {
        const relsXml = existing.includes('</Relationships>')
          ? existing.replace(
              '</Relationships>',
              `<Relationship Id="rIdSmartArt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${drawingTarget}"/></Relationships>`,
            )
          : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rIdSmartArt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${drawingTarget}"/>` +
            `</Relationships>`;
        files[sheetRelsPath] = ENC.encode(relsXml);
      }
      touched = true;
    }
    if (!touched) return packageBytes;
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}
