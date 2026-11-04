/**
 * Native XLSX drawings — pictures & shapes import, preservation and
 * authoring (audit §13.2 of OOXML-BEYOND-FUNCTIONS.md).
 *
 * SheetJS CE drops drawing parts entirely, and the other drawing
 * consumers in this package mine them only for charts (charts.ts) and
 * SmartArt diagrams (smartart.ts). Ordinary DrawingML content — an
 * embedded photo/logo (`xdr:pic` → `xl/media/*`) and autoshapes
 * (`xdr:sp` with preset geometry, fill/line and a text body) — was
 * neither parsed nor written. This module is the file-layer half of
 * §13.2 (DrawingML §20.5, spreadsheet drawings):
 *
 * - READ (`readDrawings` / `attachNativeDrawings`): for every sheet,
 *   follow `xl/worksheets/_rels/sheetN.xml.rels` → drawing part and
 *   extract, per anchor (`xdr:twoCellAnchor` from/to, or
 *   `xdr:oneCellAnchor` + `<xdr:ext>` size in EMUs):
 *     · `xdr:pic` → {@link NativePicture}: the `a:blip` `r:embed`
 *       relationship resolved through the drawing's rels to the media
 *       part's bytes (kept byte-identical), the `xdr:cNvPr` name and
 *       `descr` alt text, and the media content type (from
 *       [Content_Types].xml, falling back to the part extension).
 *     · `xdr:sp` → {@link NativeShape}: the `a:prstGeom` preset, the
 *       solid-fill color of `xdr:spPr` and of its `a:ln` line (SRGB hex
 *       as written, `scheme:<name>` for scheme colors; null when the
 *       element carries no solid fill), and the text body's plain text
 *       (paragraphs joined with '\n').
 *   The model attaches to the sheet objects as OPTIONAL fields
 *   (`nativePictures` / `nativeShapes`, plus the `nativeDrawingsRaw`
 *   preservation stash), set only when the file actually carries the
 *   feature — the nativeSheetFeatures.ts precedent. Best-effort: a
 *   malformed drawing never breaks an open.
 *
 * - PRESERVE (`injectNativeDrawings`, raw branch): when a sheet still
 *   carries its `nativeDrawingsRaw` stash (i.e. the model was not
 *   rebuilt by an editor — an editor that replaces the pictures/shapes
 *   must clear the stash), the sheet's ORIGINAL drawing part, its
 *   drawing rels and its media parts are carried through the classic
 *   SheetJS rebuild byte-for-byte, and the sheet→drawing relationship
 *   and `<drawing>` element are re-wired (SheetJS drops all of it).
 *   If the output package already has a drawing part for the sheet
 *   (e.g. the SmartArt injector ran first and created one), the raw
 *   bytes cannot also own the part, so the pictures/shapes are
 *   appended to that drawing via the authoring branch instead —
 *   content is preserved, exotic per-picture formatting is not.
 *
 * - AUTHOR (`authorNativeDrawingParts` / the inject authoring
 *   branch): given model pictures (bytes + anchor) and shapes, emit a
 *   valid `xl/drawings/drawingN.xml` part (created, or appended to the
 *   sheet's existing drawing part — a sheet has only one), the
 *   `xl/media/imageN.*` parts, the drawing + sheet relationships, the
 *   sheet's `<drawing>` element and the [Content_Types].xml
 *   overrides, so a written file shows the picture/shape in Excel.
 *   Shape authoring IS included: preset geometry, solid SRGB fill /
 *   line and plain-text body — the same fidelity the importer reads.
 *
 * Fidelity choices (DrawingML §20.5): anchors keep the cell indices
 * AND the EMU offsets (`colOff`/`rowOff`, 0-based cells) exactly as
 * written; a twoCellAnchor's `to` is authoritative, a oneCellAnchor
 * carries its size only in `<xdr:ext cx cy>` (EMUs) so `toCol/toRow`
 * mirror `fromCol/fromRow` there and the size lives in
 * `extCx/extCy`. Picture `xfrm` offsets/extents inside `spPr` are not
 * modeled — position is the anchor's job (that is how Excel resolves
 * it too for anchored pictures).
 *
 * Design-doc note: the design docs are silent on native drawing
 * import (same finding as charts.ts / smartart.ts); the mapping above
 * is this module's own contract, cloned from those two modules'
 * patterns (unzip-only parse via fflate, inject*Parts write shape).
 */
import { unzipSync } from 'fflate';
import type { SheetData } from '@icecream-sheets/engine';
import { zipSyncStable } from './zipStable.js';
import { sheetPartPaths, type ZipLike } from './formulaRecovery.js';

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/**
 * A DrawingML anchor (§20.5.2): cell indices are 0-based, offsets are
 * EMUs within the cell. For `twoCell`, `toCol/toRow` (+ offsets) are
 * the explicit opposite corner. For `oneCell`, there is no `to` in the
 * file — `toCol/toRow` mirror the `from` cell and the size is in
 * `extCx/extCy` (EMUs).
 */
export interface NativeDrawingAnchor {
  kind: 'twoCell' | 'oneCell';
  fromCol: number;
  fromRow: number;
  fromColOff: number;
  fromRowOff: number;
  toCol: number;
  toRow: number;
  toColOff: number;
  toRowOff: number;
  /** oneCellAnchor only: `<xdr:ext cx>` width in EMUs. */
  extCx?: number;
  /** oneCellAnchor only: `<xdr:ext cy>` height in EMUs. */
  extCy?: number;
}

/** An embedded picture from `xdr:pic` (image bytes live in xl/media/*). */
export interface NativePicture {
  anchor: NativeDrawingAnchor;
  /** The media part's bytes, byte-identical to the file's part. */
  mediaBytes: Uint8Array;
  /** `xdr:cNvPr/@name` ('' when absent). */
  name: string;
  /** `xdr:cNvPr/@descr` alt text ('' when absent). */
  altText: string;
  /** e.g. 'image/png' — from [Content_Types].xml or the extension. */
  contentType: string;
}

/** An autoshape from `xdr:sp`. */
export interface NativeShape {
  anchor: NativeDrawingAnchor;
  /** `a:prstGeom/@prst` (e.g. 'rect', 'ellipse', 'roundRect'); 'custom'
   *  for `a:custGeom`, '' when the shape carries no geometry element. */
  preset: string;
  /**
   * Solid-fill color of `xdr:spPr`: the SRGB hex exactly as written
   * (e.g. '4472C4'), or `scheme:<name>` for a scheme color. Null when
   * there is no `a:solidFill` (incl. explicit `a:noFill`).
   */
  fill: string | null;
  /** Solid-fill color of the `a:ln` line, same convention as `fill`. */
  line: string | null;
  /** Plain text of `xdr:txBody` (paragraphs joined with '\n'; '' when none). */
  text: string;
  /** `xdr:cNvPr/@name` ('' when absent). */
  name?: string;
}

/**
 * The original drawing + media parts of one sheet, stashed on import
 * for byte-for-byte preservation through the classic SheetJS rebuild.
 * Bytes are the package's own part bytes (not copies of the model).
 */
export interface NativeDrawingRaw {
  /** Original drawing part path, e.g. 'xl/drawings/drawing1.xml'. */
  drawingPath: string;
  /** Original drawing part bytes. */
  drawingBytes: Uint8Array;
  /** Original `xl/drawings/_rels/drawingN.xml.rels` bytes, when present. */
  drawingRelsBytes?: Uint8Array;
  /** Media part path → bytes, for every image part the drawing's rels name. */
  mediaParts: Record<string, Uint8Array>;
}

/** The optional native-drawing fields a sheet object may carry. */
export interface NativeDrawingFields {
  nativePictures?: NativePicture[];
  nativeShapes?: NativeShape[];
  /**
   * Preservation stash (see {@link NativeDrawingRaw}). Present only on
   * sheets imported from a file with a drawing; an editor that changes
   * the pictures/shapes must clear it so the write path authors a
   * fresh drawing from the model instead of re-emitting the original.
   */
  nativeDrawingsRaw?: NativeDrawingRaw;
}

/** SheetData plus the adapter's native-drawing extension fields. */
export type SheetDataWithNativeDrawings = SheetData & NativeDrawingFields;

/** One sheet's parsed drawings (the `readDrawings` result element). */
export interface SheetNativeDrawings {
  sheetIndex: number;
  sheetName: string;
  pictures: NativePicture[];
  shapes: NativeShape[];
  raw?: NativeDrawingRaw;
}

/* ------------------------------------------------------------------ */
/* Small XML helpers (cloned from charts.ts / smartart.ts conventions) */
/* ------------------------------------------------------------------ */

const DEC = new TextDecoder();
const ENC = new TextEncoder();

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strip namespace prefixes from element tags (`<xdr:pic>` → `<pic>`,
 * `<a:blip>` → `<blip>`). Attributes — including `r:embed` — are
 * untouched. All element lookups below use the stripped local names
 * (the charts.ts pattern; producers vary their prefixes).
 */
function stripPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

/** First `<name ...>...</name>` block (non-greedy), on stripped XML. */
function element(xml: string, name: string): string {
  const m = new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`).exec(xml);
  if (m) return m[0];
  const self = new RegExp(`<${name}\\b[^>]*/>`).exec(xml);
  return self ? self[0] : '';
}

/** All `<name ...>...</name>` blocks (non-greedy), on stripped XML. */
function elements(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

/** Concatenated text of all `<t>…</t>` runs inside the given XML. */
function textRuns(xml: string): string {
  const parts: string[] = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) parts.push(unescapeXml(m[1].replace(/<[^>]+>/g, '')));
  return parts.join('');
}

/** Integer child element value (`<col>1</col>`), or null. */
function intChild(xml: string, name: string): number | null {
  const m = new RegExp(`<${name}>(-?\\d+)</${name}>`).exec(xml);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Resolve a relationship Target (possibly `../`-relative) against the
 * part that owns the .rels file.
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

interface RelEntry {
  id: string;
  type: string;
  target: string;
}

/** All relationships of a .rels part (empty when the part is absent). */
function relEntries(files: Record<string, Uint8Array>, relsPath: string): RelEntry[] {
  const raw = files[relsPath];
  if (!raw) return [];
  const rels = DEC.decode(raw);
  const out: RelEntry[] = [];
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    const type = attr(tag, 'Type') ?? '';
    if (id && target) out.push({ id, type, target });
  }
  return out;
}

/** r:id → resolved part path for relationships whose Type ends with `suffix`. */
function relTargets(
  files: Record<string, Uint8Array>,
  relsPath: string,
  typeSuffix: string,
  ownerPart: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of relEntries(files, relsPath)) {
    if (rel.type.endsWith(typeSuffix)) out.set(rel.id, resolveTarget(ownerPart, rel.target));
  }
  return out;
}

function relsPathFor(partPath: string): string {
  return partPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
}

/** Sheet name → worksheet part path via xl/workbook.xml (exact). */
function sheetPathsInOrder(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) return out;
  const wb = DEC.decode(wbXml);
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

/* ------------------------------------------------------------------ */
/* Media content types                                                 */
/* ------------------------------------------------------------------ */

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  webp: 'image/webp',
};

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/webp': 'webp',
};

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

/** Content type of a media part: [Content_Types].xml wins, extension fallback. */
function contentTypeForPart(files: Record<string, Uint8Array>, path: string): string {
  const ctRaw = files['[Content_Types].xml'];
  if (ctRaw) {
    const ct = DEC.decode(ctRaw);
    for (const tag of ct.match(/<Override\b[^>]*>/g) ?? []) {
      if (attr(tag, 'PartName') === `/${path}`) {
        const type = attr(tag, 'ContentType');
        if (type) return type;
      }
    }
    const ext = extensionOf(path);
    for (const tag of ct.match(/<Default\b[^>]*>/g) ?? []) {
      if ((attr(tag, 'Extension') ?? '').toLowerCase() === ext) {
        const type = attr(tag, 'ContentType');
        if (type) return type;
      }
    }
  }
  return EXT_TO_CONTENT_TYPE[extensionOf(path)] ?? 'application/octet-stream';
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

/** Parse one stripped anchor element into the model anchor. */
function parseAnchor(anchorXml: string, kind: 'twoCell' | 'oneCell'): NativeDrawingAnchor {
  const from = element(anchorXml, 'from');
  const fromCol = Math.max(0, (from ? intChild(from, 'col') : null) ?? 0);
  const fromRow = Math.max(0, (from ? intChild(from, 'row') : null) ?? 0);
  const anchor: NativeDrawingAnchor = {
    kind,
    fromCol,
    fromRow,
    fromColOff: (from ? intChild(from, 'colOff') : null) ?? 0,
    fromRowOff: (from ? intChild(from, 'rowOff') : null) ?? 0,
    toCol: fromCol,
    toRow: fromRow,
    toColOff: 0,
    toRowOff: 0,
  };
  if (kind === 'twoCell') {
    const to = element(anchorXml, 'to');
    if (to) {
      anchor.toCol = Math.max(0, intChild(to, 'col') ?? fromCol);
      anchor.toRow = Math.max(0, intChild(to, 'row') ?? fromRow);
      anchor.toColOff = intChild(to, 'colOff') ?? 0;
      anchor.toRowOff = intChild(to, 'rowOff') ?? 0;
    }
  } else {
    const extTag = /<ext\b[^>]*>/.exec(anchorXml)?.[0] ?? '';
    const cx = Number(attr(extTag, 'cx') ?? '');
    const cy = Number(attr(extTag, 'cy') ?? '');
    if (Number.isFinite(cx) && cx > 0) anchor.extCx = cx;
    if (Number.isFinite(cy) && cy > 0) anchor.extCy = cy;
  }
  return anchor;
}

/** The `<cNvPr …>` open tag inside a stripped pic/sp block. */
function cNvPrOf(block: string): { name: string; descr: string } {
  const tag = /<cNvPr\b[^>]*>/.exec(block)?.[0] ?? '';
  return { name: attr(tag, 'name') ?? '', descr: attr(tag, 'descr') ?? '' };
}

/** Solid-fill color inside a scope (spPr or ln), per the model convention. */
function solidFillColor(scope: string): string | null {
  if (!scope) return null;
  const fill = element(scope, 'solidFill');
  if (!fill) return null;
  const srgb = /<srgbClr\b[^>]*>/.exec(fill)?.[0] ?? '';
  const srgbVal = attr(srgb, 'val');
  if (srgbVal) return srgbVal;
  const sys = /<sysClr\b[^>]*>/.exec(fill)?.[0] ?? '';
  const lastClr = attr(sys, 'lastClr');
  if (lastClr) return lastClr;
  const scheme = /<schemeClr\b[^>]*>/.exec(fill)?.[0] ?? '';
  const schemeVal = attr(scheme, 'val');
  if (schemeVal) return `scheme:${schemeVal}`;
  return null;
}

/** Parse one stripped `<pic>` block; null when its image can't resolve. */
function parsePicture(
  picXml: string,
  anchor: NativeDrawingAnchor,
  imageByRid: Map<string, string>,
  files: Record<string, Uint8Array>,
): NativePicture | null {
  const blipTag = /<blip\b[^>]*>/.exec(picXml)?.[0] ?? '';
  const rid = attr(blipTag, 'r:embed') ?? attr(blipTag, 'embed');
  if (!rid) return null;
  const mediaPath = imageByRid.get(rid);
  const mediaBytes = mediaPath ? files[mediaPath] : undefined;
  if (!mediaPath || !mediaBytes) return null;
  const { name, descr } = cNvPrOf(picXml);
  return {
    anchor,
    mediaBytes: mediaBytes.slice(),
    name,
    altText: descr,
    contentType: contentTypeForPart(files, mediaPath),
  };
}

/** Parse one stripped `<sp>` block. */
function parseShape(spXml: string, anchor: NativeDrawingAnchor): NativeShape {
  const { name } = cNvPrOf(spXml);
  const spPr = element(spXml, 'spPr');
  let preset = '';
  const geomTag = /<prstGeom\b[^>]*>/.exec(spPr)?.[0] ?? '';
  const prst = attr(geomTag, 'prst');
  if (prst) preset = prst;
  else if (spPr.includes('<custGeom')) preset = 'custom';
  // Fill lives on spPr itself; the line's fill lives inside <ln>. Search
  // the fill outside the ln block so a line-only color is not misread.
  const lnBlock = spPr ? element(spPr, 'ln') : '';
  const spPrNoLn = lnBlock ? spPr.replace(lnBlock, '') : spPr;
  const fill = solidFillColor(spPrNoLn);
  const line = lnBlock ? solidFillColor(lnBlock) : null;
  // Text body: paragraphs of <t> runs, joined with '\n'.
  const txBody = element(spXml, 'txBody');
  let text = '';
  if (txBody) {
    const paras = elements(txBody, 'p');
    if (paras.length > 0) text = paras.map((p) => textRuns(p)).join('\n');
    else text = textRuns(txBody);
  }
  const shape: NativeShape = { anchor, preset, fill, line, text };
  if (name) shape.name = name;
  return shape;
}

/**
 * Read all native pictures & shapes from an unzipped OOXML package
 * (path → bytes, as produced by fflate's unzipSync), grouped per sheet
 * in workbook order. Never throws: a missing/corrupt drawing yields
 * fewer entries, never an error; a pic whose media can't resolve is
 * skipped (the anchor alone carries no displayable content).
 */
export function readDrawings(files: Record<string, Uint8Array>): SheetNativeDrawings[] {
  const out: SheetNativeDrawings[] = [];
  try {
    for (const [sheetIndex, { name: sheetName, path: sheetPath }] of sheetPathsInOrder(files).entries()) {
      const dir = sheetPath.includes('/') ? sheetPath.slice(0, sheetPath.lastIndexOf('/')) : '';
      const sheetRelsPath = `${dir}/_rels/${sheetPath.slice(sheetPath.lastIndexOf('/') + 1)}.rels`;
      const drawingByRid = relTargets(files, sheetRelsPath, '/drawing', sheetPath);
      for (const drawingPath of drawingByRid.values()) {
        const drawingRaw = files[drawingPath];
        if (!drawingRaw) continue;
        const drawingRelsPath = relsPathFor(drawingPath);
        const imageByRid = relTargets(files, drawingRelsPath, '/image', drawingPath);
        const drawing = stripPrefixes(DEC.decode(drawingRaw));
        const pictures: NativePicture[] = [];
        const shapes: NativeShape[] = [];
        const anchors: Array<{ xml: string; kind: 'twoCell' | 'oneCell' }> = [
          ...elements(drawing, 'twoCellAnchor').map((xml) => ({ xml, kind: 'twoCell' as const })),
          ...elements(drawing, 'oneCellAnchor').map((xml) => ({ xml, kind: 'oneCell' as const })),
        ];
        for (const { xml: anchorXml, kind } of anchors) {
          const anchor = parseAnchor(anchorXml, kind);
          for (const picXml of elements(anchorXml, 'pic')) {
            const pic = parsePicture(picXml, anchor, imageByRid, files);
            if (pic) pictures.push(pic);
          }
          for (const spXml of elements(anchorXml, 'sp')) {
            // A <sp> inside a pic's fallback etc. does not occur in
            // practice; every direct anchor-level sp is a shape.
            shapes.push(parseShape(spXml, anchor));
          }
        }
        if (pictures.length === 0 && shapes.length === 0) continue;
        // Preservation stash: the original drawing + rels + every media
        // part the drawing's rels name (byte-for-byte, as stored).
        const mediaParts: Record<string, Uint8Array> = {};
        for (const mediaPath of imageByRid.values()) {
          const bytes = files[mediaPath];
          if (bytes && !mediaParts[mediaPath]) mediaParts[mediaPath] = bytes.slice();
        }
        const raw: NativeDrawingRaw = {
          drawingPath,
          drawingBytes: drawingRaw.slice(),
          mediaParts,
        };
        const relsRaw = files[drawingRelsPath];
        if (relsRaw) raw.drawingRelsBytes = relsRaw.slice();
        out.push({ sheetIndex, sheetName, pictures, shapes, raw });
      }
    }
  } catch {
    // Best-effort: drawing import must never break the open.
  }
  return out;
}

/**
 * Parse native drawings from the package onto each sheet (mutates the
 * sheet objects; fields set only when present). Never throws.
 */
export function attachNativeDrawings(sheets: SheetData[], files: ZipLike | undefined): void {
  try {
    if (!files) return;
    const byName = new Map<string, SheetNativeDrawings>();
    for (const entry of readDrawings(files as Record<string, Uint8Array>)) {
      const prev = byName.get(entry.sheetName);
      if (!prev) {
        byName.set(entry.sheetName, entry);
      } else {
        // Multiple drawing parts per sheet are not legal OOXML, but if
        // a producer wrote them, keep every picture/shape found.
        prev.pictures.push(...entry.pictures);
        prev.shapes.push(...entry.shapes);
      }
    }
    for (const sheet of sheets) {
      const entry = byName.get(sheet.name);
      if (!entry) continue;
      const target = sheet as SheetDataWithNativeDrawings;
      if (entry.pictures.length > 0) target.nativePictures = entry.pictures;
      if (entry.shapes.length > 0) target.nativeShapes = entry.shapes;
      if (entry.raw) target.nativeDrawingsRaw = entry.raw;
    }
  } catch {
    // Best-effort: drawing import must never break the open.
  }
}

/* ------------------------------------------------------------------ */
/* Display-model seeding (read)                                        */
/* ------------------------------------------------------------------ */

/**
 * Metadata key the web app hydrates its picture overlays from. Mirrors
 * `PICTURES_METADATA_KEY` in apps/web/src/components/Pictures.tsx — the
 * adapter cannot import the web app, so the literal is duplicated by
 * design (same pattern as the page-setup seeding in adapter.ts).
 */
export const APP_PICTURES_METADATA_KEY = 'icecream.pictures';

/**
 * Metadata key the web app hydrates its text-box overlays from
 * (`TEXTBOXES_METADATA_KEY` in apps/web/src/components/Overlays.tsx).
 */
export const APP_TEXTBOXES_METADATA_KEY = 'icecream.textboxes';

/** DrawingML EMUs per CSS pixel (914400 EMU/inch ÷ 96 px/inch). */
const EMU_PER_PX = 9525;
/** Grid metrics the app falls back to when a sheet carries no dims. */
const DEFAULT_COL_PX = 64;
const DEFAULT_ROW_PX = 20;

/** Absolute px position of a cell edge plus an EMU offset within the cell. */
function axisOffsetPx(
  index: number,
  offEmu: number,
  dims: Record<string, number> | undefined,
  fallback: number,
): number {
  let px = 0;
  for (let i = 0; i < index; i++) px += dims?.[String(i)] ?? fallback;
  return px + offEmu / EMU_PER_PX;
}

/**
 * Convert a native drawing anchor to the app's absolute-pixel overlay
 * rect {x, y, w, h}, on the sheet's OWN column widths / row heights
 * (pixels in the SheetData model), matching how the grid lays the sheet
 * out. A oneCell anchor takes its size from `extCx/extCy`; a twoCell
 * anchor from the opposite corner. Values are rounded; width/height
 * can come back ≤ 0 for sloppily-authored anchors (callers fall back).
 */
export function nativeAnchorRectPx(
  anchor: NativeDrawingAnchor,
  sheet: SheetData,
): { x: number; y: number; w: number; h: number } {
  const x = axisOffsetPx(anchor.fromCol, anchor.fromColOff, sheet.colWidths, DEFAULT_COL_PX);
  const y = axisOffsetPx(anchor.fromRow, anchor.fromRowOff, sheet.rowHeights, DEFAULT_ROW_PX);
  let w: number;
  let h: number;
  if (anchor.kind === 'oneCell') {
    w = (anchor.extCx ?? 0) / EMU_PER_PX;
    h = (anchor.extCy ?? 0) / EMU_PER_PX;
  } else {
    w = axisOffsetPx(anchor.toCol, anchor.toColOff, sheet.colWidths, DEFAULT_COL_PX) - x;
    h = axisOffsetPx(anchor.toRow, anchor.toRowOff, sheet.rowHeights, DEFAULT_ROW_PX) - y;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Intrinsic pixel size of an image from its header bytes (PNG / GIF /
 * JPEG), or null when the format is unrecognized or the bytes are
 * truncated. Used only when an anchor's span is degenerate — Excel
 * stretches pictures to their anchor, so the anchor wins when sane.
 */
export function imagePixelSize(bytes: Uint8Array): { w: number; h: number } | null {
  // PNG: IHDR width/height are big-endian uint32 at offsets 16/20.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  // GIF: logical screen width/height are little-endian uint16 at 6/8.
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: bytes[6] | (bytes[7] << 8), h: bytes[8] | (bytes[9] << 8) };
  }
  // JPEG: scan marker segments for a start-of-frame (C0–C3) segment.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 4 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        if (i + 8 >= bytes.length) break;
        return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Chunked base64 (btoa-safe in Node + browser), same shape as macroProject's. */
function mediaBytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Seed the app's display models for imported drawings into workbook
 * metadata (File-2 visual-pass defect D1): before this seeding, NOTHING
 * downstream consumed `nativePictures`/`nativeShapes` — the engine drops
 * them, the gateway's /load response whitelists sheet fields without
 * them, and the web app renders pictures/text boxes only from the
 * `icecream.pictures` / `icecream.textboxes` metadata keys, which only
 * app-authored overlays ever populated. So every imported picture and
 * text shape was invisible on reopen in every mode (parts unharmed —
 * the write path preserves them from `nativeDrawingsRaw`).
 *
 * Runs in the read assembly funnel, so gateway, local and desktop opens
 * all get the models exactly once. Each key is seeded ONLY when absent:
 * an app-owned value (restored from custom properties, or set by an
 * earlier edit) always wins. Shapes seed as text boxes — the app's
 * closest overlay kind — and only when they carry text (a textless
 * autoshape has no app counterpart); the native fill/line are not
 * carried (the app text-box model has no fill field).
 */
export function seedNativeDrawingDisplayModels(
  sheets: SheetData[],
  metadata: Record<string, unknown>,
): void {
  if (metadata[APP_PICTURES_METADATA_KEY] === undefined) {
    const pictures: Array<Record<string, unknown>> = [];
    let id = 1;
    for (const sheet of sheets) {
      const native = (sheet as SheetDataWithNativeDrawings).nativePictures ?? [];
      for (const pic of native) {
        const rect = nativeAnchorRectPx(pic.anchor, sheet);
        let { w, h } = rect;
        if (w <= 0 || h <= 0) {
          const intrinsic = imagePixelSize(pic.mediaBytes);
          if (intrinsic) {
            if (w <= 0) w = intrinsic.w;
            if (h <= 0) h = intrinsic.h;
          }
        }
        const contentType = pic.contentType.startsWith('image/') ? pic.contentType : 'image/png';
        pictures.push({
          id: id++,
          x: rect.x,
          y: rect.y,
          w: Math.max(8, w),
          h: Math.max(8, h),
          dataUrl: `data:${contentType};base64,${mediaBytesToBase64(pic.mediaBytes)}`,
          name: pic.name || 'picture',
          sheet: sheet.name,
        });
      }
    }
    if (pictures.length > 0) metadata[APP_PICTURES_METADATA_KEY] = pictures;
  }
  if (metadata[APP_TEXTBOXES_METADATA_KEY] === undefined) {
    const boxes: Array<Record<string, unknown>> = [];
    let id = 1;
    for (const sheet of sheets) {
      const native = (sheet as SheetDataWithNativeDrawings).nativeShapes ?? [];
      for (const shape of native) {
        if (!shape.text) continue;
        const rect = nativeAnchorRectPx(shape.anchor, sheet);
        boxes.push({
          id: id++,
          x: rect.x,
          y: rect.y,
          w: Math.max(8, rect.w),
          h: Math.max(8, rect.h),
          text: shape.text,
          sheet: sheet.name,
        });
      }
    }
    if (boxes.length > 0) metadata[APP_TEXTBOXES_METADATA_KEY] = boxes;
  }
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.drawing+xml';

/** Pick a part path that does not collide with an existing one. */
function freePartPath(files: Record<string, Uint8Array>, dir: string, stem: string, ext: string): string {
  let n = 1;
  while (files[`${dir}/${stem}${n}.${ext}`]) n += 1;
  return `${dir}/${stem}${n}.${ext}`;
}

/** Fresh relationship id not already used in the rels XML. */
function freshRid(relsXml: string): string {
  const used = new Set<string>();
  for (const m of relsXml.match(/Id="([^"]*)"/g) ?? []) {
    const id = /^Id="([^"]*)"$/.exec(m)?.[1];
    if (id) used.add(id);
  }
  let n = 1;
  while (used.has(`rId${n}`)) n += 1;
  return `rId${n}`;
}

function emptyRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"></Relationships>`;
}

function appendRel(relsXml: string, rid: string, type: string, target: string): string {
  const rel = `<Relationship Id="${rid}" Type="${type}" Target="${escapeXml(target)}"/>`;
  if (relsXml.includes('</Relationships>')) return relsXml.replace('</Relationships>', `${rel}</Relationships>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${rel}</Relationships>`;
}

function ensureContentType(files: Record<string, Uint8Array>, path: string, contentType: string): void {
  const ctPath = '[Content_Types].xml';
  const raw = files[ctPath];
  if (!raw) return;
  let xml = DEC.decode(raw);
  if (xml.includes(`PartName="/${path}"`)) return;
  if (!xml.includes('</Types>')) return;
  xml = xml.replace('</Types>', `<Override PartName="/${path}" ContentType="${contentType}"/></Types>`);
  files[ctPath] = ENC.encode(xml);
}

/** Insert `<drawing r:id="…"/>` into a sheet part (after </sheetData>). */
function insertDrawingElement(sheetXml: string, rid: string): string {
  if (/<drawing\b/.test(sheetXml)) return sheetXml;
  const el = `<drawing r:id="${rid}"/>`;
  if (sheetXml.includes('</sheetData>')) return sheetXml.replace('</sheetData>', `</sheetData>${el}`);
  if (/<sheetData\b[^>]*\/>/.test(sheetXml)) {
    return sheetXml.replace(/<sheetData\b[^>]*\/>/, (m) => `${m}${el}`);
  }
  return sheetXml.replace('</worksheet>', `${el}</worksheet>`);
}

function fromXml(a: NativeDrawingAnchor): string {
  return (
    `<xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>${a.fromColOff}</xdr:colOff>` +
    `<xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>${a.fromRowOff}</xdr:rowOff></xdr:from>`
  );
}

function toXml(a: NativeDrawingAnchor): string {
  return (
    `<xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>${a.toColOff}</xdr:colOff>` +
    `<xdr:row>${a.toRow}</xdr:row><xdr:rowOff>${a.toRowOff}</xdr:rowOff></xdr:to>`
  );
}

/** Wrap inner anchor content (pic/sp element) in its anchor element. */
function anchorWrap(a: NativeDrawingAnchor, inner: string): string {
  if (a.kind === 'oneCell') {
    const cx = a.extCx ?? 1828800;
    const cy = a.extCy ?? 1371600;
    return `<xdr:oneCellAnchor>${fromXml(a)}<xdr:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/>${inner}<xdr:clientData/></xdr:oneCellAnchor>`;
  }
  return `<xdr:twoCellAnchor>${fromXml(a)}${toXml(a)}${inner}<xdr:clientData/></xdr:twoCellAnchor>`;
}

function picXml(pic: NativePicture, rid: string, id: number): string {
  const name = pic.name || `Picture ${id - 1}`;
  const descr = pic.altText ? ` descr="${escapeXml(pic.altText)}"` : '';
  return (
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"${descr}>` +
    `<a:extLst/></xdr:cNvPr><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
  );
}

/** `<a:solidFill>` for a model color (SRGB hex or scheme: name), or ''. */
function solidFillXml(color: string | null): string {
  if (!color) return '';
  if (/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(color)) {
    return `<a:solidFill><a:srgbClr val="${color.toUpperCase()}"/></a:solidFill>`;
  }
  if (color.startsWith('scheme:')) {
    return `<a:solidFill><a:schemeClr val="${escapeXml(color.slice('scheme:'.length))}"/></a:solidFill>`;
  }
  return '';
}

function spXml(shape: NativeShape, id: number): string {
  const name = shape.name || `Shape ${id - 1}`;
  const preset = shape.preset && shape.preset !== 'custom' ? shape.preset : 'rect';
  const fill = solidFillXml(shape.fill);
  const lineColor = solidFillXml(shape.line);
  const line = lineColor ? `<a:ln>${lineColor}</a:ln>` : '';
  const paras = shape.text
    ? shape.text
        .split('\n')
        .map((p) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(p)}</a:t></a:r></a:p>`)
        .join('')
    : '';
  const txBody = paras
    ? `<xdr:txBody><a:bodyPr/><a:lstStyle/>${paras}</xdr:txBody>`
    : '';
  return (
    `<xdr:sp macro="" textlink="">` +
    `<xdr:nvSpPr><xdr:cNvPr id="${id}" name="${escapeXml(name)}"/><xdr:cNvSpPr/></xdr:nvSpPr>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>` +
    `<a:prstGeom prst="${escapeXml(preset)}"><a:avLst/></a:prstGeom>${fill}${line}</xdr:spPr>` +
    `${txBody}</xdr:sp>`
  );
}

function newDrawingXml(anchors: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="${OFFICE_REL_NS}">${anchors.join('')}</xdr:wsDr>`
  );
}

function appendAnchorToDrawing(drawingXml: string, anchorXml: string): string {
  const close = /<\/(\w+):wsDr>/.exec(drawingXml);
  if (close) return drawingXml.slice(0, close.index) + anchorXml + drawingXml.slice(close.index);
  if (drawingXml.includes('</wsDr>')) return drawingXml.replace('</wsDr>', `${anchorXml}</wsDr>`);
  return drawingXml + anchorXml;
}

export interface AuthorNativeDrawingResult {
  /** Media part paths created for the pictures, in picture order. */
  mediaPaths: string[];
  /** The sheet's drawing part path (created or pre-existing). */
  drawingPath: string;
}

/**
 * Author native drawing content for ONE sheet into an unzipped package
 * map (the `authorChartParts` shape): media parts for the pictures,
 * anchors appended to the sheet's drawing part (created when the sheet
 * has none), drawing/sheet relationships, the sheet's `<drawing>`
 * element and content-type overrides. Mutates `files` in place.
 * Throws when the sheet is not in the package (fail closed, before
 * any mutation for that sheet).
 */
export function authorNativeDrawingParts(
  files: Record<string, Uint8Array>,
  sheetName: string,
  pictures: readonly NativePicture[],
  shapes: readonly NativeShape[],
): AuthorNativeDrawingResult {
  const result: AuthorNativeDrawingResult = { mediaPaths: [], drawingPath: '' };
  if (pictures.length === 0 && shapes.length === 0) return result;
  const sheets = sheetPathsInOrder(files);
  const sheetPath = sheets.find((s) => s.name === sheetName)?.path;
  if (!sheetPath) throw new Error(`authorNativeDrawingParts: sheet "${sheetName}" is not in the package`);
  const sheetRelsPath = relsPathFor(sheetPath);

  // 1. Resolve (or create) the sheet's drawing part + wiring.
  const drawingByRid = relTargets(files, sheetRelsPath, '/drawing', sheetPath);
  let drawingPath: string | undefined = [...drawingByRid.values()][0];
  if (!drawingPath) {
    drawingPath = freePartPath(files, 'xl/drawings', 'drawing', 'xml');
    files[drawingPath] = ENC.encode(newDrawingXml([]));
    ensureContentType(files, drawingPath, DRAWING_CONTENT_TYPE);
    files[relsPathFor(drawingPath)] = ENC.encode(emptyRelsXml());
    const existingSheetRels = files[sheetRelsPath] ? DEC.decode(files[sheetRelsPath]) : emptyRelsXml();
    const rid = freshRid(existingSheetRels);
    files[sheetRelsPath] = ENC.encode(
      appendRel(existingSheetRels, rid, `${OFFICE_REL_NS}/drawing`, `../drawings/${drawingPath.split('/').pop()}`),
    );
    const sheetRaw = files[sheetPath];
    if (sheetRaw) files[sheetPath] = ENC.encode(insertDrawingElement(DEC.decode(sheetRaw), rid));
  }
  result.drawingPath = drawingPath;

  // 2. Media parts + anchors (fresh rIds / cNvPr ids throughout).
  const drawingRelsPath = relsPathFor(drawingPath);
  let drawingXml = DEC.decode(files[drawingPath] as Uint8Array);
  let drawingRelsXml = files[drawingRelsPath] ? DEC.decode(files[drawingRelsPath]) : emptyRelsXml();
  let maxNvId = 1;
  for (const m of drawingXml.match(/cNvPr id="(\d+)"/g) ?? []) {
    const id = Number(/^cNvPr id="(\d+)"$/.exec(m)?.[1] ?? 0);
    if (id > maxNvId) maxNvId = id;
  }
  let nextId = maxNvId + 1;
  for (const pic of pictures) {
    const ext = CONTENT_TYPE_TO_EXT[pic.contentType] ?? extensionOf(pic.name) ?? 'png';
    const mediaPath = freePartPath(files, 'xl/media', 'image', ext || 'png');
    files[mediaPath] = pic.mediaBytes.slice();
    ensureContentType(files, mediaPath, pic.contentType || EXT_TO_CONTENT_TYPE[ext] || 'image/png');
    result.mediaPaths.push(mediaPath);
    const rid = freshRid(drawingRelsXml);
    drawingRelsXml = appendRel(
      drawingRelsXml,
      rid,
      `${OFFICE_REL_NS}/image`,
      `../media/${mediaPath.split('/').pop()}`,
    );
    drawingXml = appendAnchorToDrawing(drawingXml, anchorWrap(pic.anchor, picXml(pic, rid, nextId)));
    nextId += 1;
  }
  for (const shape of shapes) {
    drawingXml = appendAnchorToDrawing(drawingXml, anchorWrap(shape.anchor, spXml(shape, nextId)));
    nextId += 1;
  }
  files[drawingPath] = ENC.encode(drawingXml);
  files[drawingRelsPath] = ENC.encode(drawingRelsXml);
  return result;
}

/**
 * Preservation branch for one sheet: emit the raw drawing + rels +
 * media byte-for-byte and wire the sheet to it. Returns false when the
 * output already has a drawing part for the sheet (the caller then
 * falls back to authoring the model into that part).
 */
function preserveRawDrawing(
  files: Record<string, Uint8Array>,
  sheetPath: string,
  raw: NativeDrawingRaw,
): boolean {
  const sheetRelsPath = relsPathFor(sheetPath);
  const existing = relTargets(files, sheetRelsPath, '/drawing', sheetPath);
  if (existing.size > 0) return false;
  const drawingPath = files[raw.drawingPath]
    ? freePartPath(files, 'xl/drawings', 'drawing', 'xml')
    : raw.drawingPath;
  files[drawingPath] = raw.drawingBytes.slice();
  ensureContentType(files, drawingPath, DRAWING_CONTENT_TYPE);
  if (raw.drawingRelsBytes) files[relsPathFor(drawingPath)] = raw.drawingRelsBytes.slice();
  for (const [mediaPath, bytes] of Object.entries(raw.mediaParts)) {
    if (!files[mediaPath]) files[mediaPath] = bytes.slice();
    ensureContentType(files, mediaPath, contentTypeForPart(files, mediaPath));
  }
  const existingSheetRels = files[sheetRelsPath] ? DEC.decode(files[sheetRelsPath]) : emptyRelsXml();
  const rid = freshRid(existingSheetRels);
  files[sheetRelsPath] = ENC.encode(
    appendRel(existingSheetRels, rid, `${OFFICE_REL_NS}/drawing`, `../drawings/${drawingPath.split('/').pop()}`),
  );
  const sheetRaw = files[sheetPath];
  if (sheetRaw) files[sheetPath] = ENC.encode(insertDrawingElement(DEC.decode(sheetRaw), rid));
  return true;
}

/**
 * Carry every sheet's native drawings through a rebuilt package
 * (the classic SheetJS write): sheets with a `nativeDrawingsRaw`
 * stash are preserved byte-for-byte; sheets with model pictures /
 * shapes (and no stash, or a drawing part already present) are
 * authored from the model. Sheets with no drawing fields are left
 * byte-identical. Never throws and never fails a save — on any
 * problem the input bytes are returned unchanged.
 */
export function injectNativeDrawings(
  packageBytes: Uint8Array,
  sheets: readonly SheetData[],
): Uint8Array {
  try {
    const featured = sheets as readonly SheetDataWithNativeDrawings[];
    const any = featured.some(
      (s) =>
        s.nativeDrawingsRaw !== undefined ||
        (s.nativePictures !== undefined && s.nativePictures.length > 0) ||
        (s.nativeShapes !== undefined && s.nativeShapes.length > 0),
    );
    if (!any) return packageBytes;
    const files = unzipSync(packageBytes.slice()) as Record<string, Uint8Array>;
    const pathByName = new Map(sheetPathsInOrder(files).map((s) => [s.name, s.path]));
    let touched = false;
    for (const sheet of featured) {
      const has =
        sheet.nativeDrawingsRaw !== undefined ||
        (sheet.nativePictures !== undefined && sheet.nativePictures.length > 0) ||
        (sheet.nativeShapes !== undefined && sheet.nativeShapes.length > 0);
      if (!has) continue;
      const sheetPath = pathByName.get(sheet.name);
      if (!sheetPath) continue;
      if (sheet.nativeDrawingsRaw) {
        if (preserveRawDrawing(files, sheetPath, sheet.nativeDrawingsRaw)) {
          touched = true;
          continue;
        }
        // A drawing part already exists in the output (another
        // injector created it): author the model into it instead.
      }
      const pictures = sheet.nativePictures ?? [];
      const shapes = sheet.nativeShapes ?? [];
      if (pictures.length === 0 && shapes.length === 0) continue;
      authorNativeDrawingParts(files, sheet.name, pictures, shapes);
      touched = true;
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}
