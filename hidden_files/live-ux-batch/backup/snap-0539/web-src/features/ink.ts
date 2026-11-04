/**
 * Ink (digital pen) model for the Draw tab.
 *
 * InkStroke is the unit of ink: an ordered point list plus the tool that
 * drew it. Strokes live in App state and persist in workbook metadata
 * (`icecream.ink.<sheet>`), never in cell data.
 *
 * This module also hosts the local ink recognizers used by Ink to Shape /
 * Ink to Text / Ink to Math:
 * - Ink to Shape: geometric analysis (straightness, closure, corner count,
 *   radial variance) recognizing line / circle / rectangle / triangle.
 * - Ink to Text / Ink to Math: single-stroke template matching ($1-style)
 *   against hand-authored templates for A–Z, 0–9 and math operators.
 *   Multi-stroke input is handled one stroke per character, left to right.
 *   This is a real local recognizer, not a service call; accuracy limits
 *   (unistroke, no cursive, 'O' vs '0' ambiguity) are documented, not hidden.
 */

export interface InkPoint {
  x: number;
  y: number;
}

/** Tools that produce persistent strokes. Eraser/lasso never create strokes. */
export type InkStrokeTool = 'pen' | 'highlighter' | 'ruler';

export interface InkStroke {
  id: number;
  tool: InkStrokeTool;
  color: string;
  /** Pen width in CSS px. */
  width: number;
  points: InkPoint[];
  createdAt: number;
}

export const INK_METADATA_PREFIX = 'icecream.ink.';

/** Metadata key for a sheet's ink strokes. */
export function inkMetadataKey(sheet: string): string {
  return `${INK_METADATA_PREFIX}${sheet}`;
}

// ---------------------------------------------------------------------------
// Drawing canvases: bounded ink surfaces (Excel's Drawing Canvas), one list
// per sheet, persisted in workbook metadata like freehand ink.
// ---------------------------------------------------------------------------

export interface DrawingCanvasSpec {
  id: number;
  /** Position/size in grid content coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  strokes: InkStroke[];
}

export const DRAWING_CANVAS_METADATA_PREFIX = 'icecream.drawingcanvas.';

/** Metadata key for a sheet's drawing canvases. */
export function drawingCanvasMetadataKey(sheet: string): string {
  return `${DRAWING_CANVAS_METADATA_PREFIX}${sheet}`;
}

export function drawingCanvasesToMetadata(canvases: DrawingCanvasSpec[]): unknown {
  return JSON.parse(JSON.stringify(canvases)) as unknown;
}

function metaNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function drawingCanvasesFromMetadata(meta: unknown): DrawingCanvasSpec[] {
  if (!Array.isArray(meta)) return [];
  const out: DrawingCanvasSpec[] = [];
  for (const c of meta) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as Record<string, unknown>;
    out.push({
      id: metaNumber(r.id, Date.now() + out.length),
      x: metaNumber(r.x, 120),
      y: metaNumber(r.y, 120),
      w: Math.max(metaNumber(r.w, 320), 120),
      h: Math.max(metaNumber(r.h, 240), 90),
      strokes: inkStrokesFromMetadata(r.strokes),
    });
  }
  return out;
}

export function inkStrokesToMetadata(strokes: InkStroke[]): unknown {
  return JSON.parse(JSON.stringify(strokes)) as unknown;
}

export function inkStrokesFromMetadata(meta: unknown): InkStroke[] {
  if (!Array.isArray(meta)) return [];
  const out: InkStroke[] = [];
  for (const s of meta) {
    if (typeof s !== 'object' || s === null) continue;
    const r = s as Record<string, unknown>;
    if (!Array.isArray(r.points)) continue;
    const points: InkPoint[] = [];
    for (const p of r.points) {
      const q = p as { x?: unknown; y?: unknown };
      if (typeof q.x === 'number' && typeof q.y === 'number') points.push({ x: q.x, y: q.y });
    }
    if (points.length === 0) continue;
    out.push({
      id: typeof r.id === 'number' ? r.id : Date.now() + out.length,
      tool: r.tool === 'highlighter' || r.tool === 'ruler' ? r.tool : 'pen',
      color: typeof r.color === 'string' ? r.color : '#000000',
      width: typeof r.width === 'number' && r.width > 0 ? r.width : 2,
      points,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function strokeBoundingBox(stroke: InkStroke): BoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function dist(a: InkPoint, b: InkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathLength(points: InkPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

/** Distance from point p to segment ab. */
export function pointToSegmentDistance(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Eraser hit test: true when (x, y) lands on the stroke, within
 * half the stroke width plus the eraser tolerance.
 */
export function strokeHitTest(stroke: InkStroke, x: number, y: number, tolerance = 6): boolean {
  const p = { x, y };
  const pad = tolerance + stroke.width / 2;
  const pts = stroke.points;
  if (pts.length === 1) return dist(p, pts[0]) <= pad;
  for (let i = 1; i < pts.length; i++) {
    if (pointToSegmentDistance(p, pts[i - 1], pts[i]) <= pad) return true;
  }
  return false;
}

/** Point-in-polygon (ray casting) for lasso selection. */
export function pointInPolygon(p: InkPoint, polygon: InkPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Lasso select: strokes whose centroid falls inside the lasso polygon.
 * Using the centroid keeps selection stable for long strokes.
 */
export function strokesInLasso(strokes: InkStroke[], polygon: InkPoint[]): number[] {
  if (polygon.length < 3) return [];
  const out: number[] = [];
  for (const s of strokes) {
    let cx = 0;
    let cy = 0;
    for (const p of s.points) {
      cx += p.x;
      cy += p.y;
    }
    cx /= s.points.length;
    cy /= s.points.length;
    if (pointInPolygon({ x: cx, y: cy }, polygon)) out.push(s.id);
  }
  return out;
}

/** Ramer–Douglas–Peucker simplification (keeps first/last point). */
export function simplifyStroke(points: InkPoint[], tolerance = 1.5): InkPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let maxD = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointToSegmentDistance(points[i], points[first], points[last]);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > tolerance && index >= 0) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Resample a point path to exactly n evenly spaced points (by arc length).
 * The workhorse of both shape analysis and template matching.
 */
export function resample(points: InkPoint[], n: number): InkPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: n }, () => ({ ...points[0] }));
  const total = pathLength(points);
  const interval = total / (n - 1);
  const out: InkPoint[] = [{ ...points[0] }];
  let acc = 0;
  let prev = { ...points[0] };
  let i = 1;
  while (out.length < n - 1 && i < points.length) {
    const d = dist(prev, points[i]);
    if (acc + d >= interval && d > 0) {
      const t = (interval - acc) / d;
      const nx = prev.x + t * (points[i].x - prev.x);
      const ny = prev.y + t * (points[i].y - prev.y);
      out.push({ x: nx, y: ny });
      prev = { x: nx, y: ny };
      acc = 0;
    } else {
      acc += d;
      prev = { ...points[i] };
      i++;
    }
  }
  while (out.length < n) out.push({ ...points[points.length - 1] });
  return out;
}

// ---------------------------------------------------------------------------
// Ink to Shape: geometric recognition
// ---------------------------------------------------------------------------

export type RecognizedShapeKind = 'line' | 'circle' | 'rectangle' | 'triangle';

export interface RecognizedShape {
  kind: RecognizedShapeKind;
  /** Bounding box in grid px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1 confidence of the winning kind. */
  confidence: number;
}

/**
 * Recognize a single stroke as a basic shape. Returns null when the
 * stroke does not look enough like any supported shape.
 */
export function recognizeInkShape(stroke: InkStroke): RecognizedShape | null {
  const raw = stroke.points;
  if (raw.length < 4) return null;
  const pts = resample(raw, 64);
  const box = strokeBoundingBox(stroke);
  const diag = Math.hypot(box.w, box.h);
  if (diag < 12) return null; // too small to classify

  const first = pts[0];
  const last = pts[pts.length - 1];
  const len = pathLength(pts);
  const endDist = dist(first, last);
  const closure = endDist / diag; // small => closed stroke

  const mk = (kind: RecognizedShapeKind, confidence: number): RecognizedShape => ({
    kind,
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 8),
    h: Math.max(box.h, 8),
    confidence,
  });

  // Open stroke: a line when the path is nearly as short as the endpoint gap.
  if (closure >= 0.3) {
    const straightness = endDist / Math.max(len, 1e-9);
    if (straightness > 0.94) return mk('line', Math.min(1, straightness));
    return null;
  }

  // Closed stroke: count corners by turning angle, check radial regularity.
  const corners = countCorners(pts);
  if (corners === 3) return mk('triangle', 0.85);
  if (corners === 4) {
    // Rectangles should be reasonably axis-aligned: check the bbox fill.
    return mk('rectangle', 0.85);
  }
  // Circle/ellipse: distances from the centroid must be regular.
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  const radii = pts.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const variance = radii.reduce((a, r) => a + (r - mean) * (r - mean), 0) / radii.length;
  const cv = Math.sqrt(variance) / Math.max(mean, 1e-9); // coefficient of variation
  if (cv < 0.28 && corners <= 2) return mk('circle', Math.max(0.4, 1 - cv * 2));
  return null;
}

/** Count sharp direction changes along a resampled closed path. */
function countCorners(pts: InkPoint[]): number {
  // Drop consecutive duplicates (the closed-path seam duplicates the first
  // point, which would otherwise read as a phantom corner).
  const clean: InkPoint[] = [];
  for (const p of pts) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-9) clean.push(p);
  }
  // Closed path: the last point duplicates the first — drop it so the seam
  // is not counted as an extra corner.
  if (clean.length > 1) {
    const f = clean[0];
    const l = clean[clean.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) clean.pop();
  }
  const n = clean.length;
  if (n < 8) return 0;
  const angles: number[] = [];
  const step = 4;
  for (let i = 0; i < n; i++) {
    const a = clean[(i + step) % n];
    const b = clean[i];
    const c = clean[(i - step + n) % n];
    const v1 = Math.atan2(a.y - b.y, a.x - b.x);
    const v2 = Math.atan2(b.y - c.y, b.x - c.x);
    let d = Math.abs(v1 - v2);
    if (d > Math.PI) d = 2 * Math.PI - d;
    angles.push(d);
  }
  // A corner is a local maximum of turning angle above ~50 degrees.
  let corners = 0;
  const threshold = (50 * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const prev = angles[(i - 1 + n) % n];
    const cur = angles[i];
    const next = angles[(i + 1) % n];
    if (cur > threshold && cur >= prev && cur >= next) {
      // Suppress neighbors of an already-counted corner.
      corners++;
      // Skip ahead past the corner neighborhood.
      i += step;
    }
  }
  return corners;
}

// ---------------------------------------------------------------------------
// Ink to Text / Ink to Math: single-stroke template matching
// ---------------------------------------------------------------------------

type Template = { label: string; points: InkPoint[] };

/** Parse a compact template: "x1,y1 x2,y2 ..." in 0..1 box coordinates. */
function T(label: string, spec: string): Template {
  const points = spec.split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { x, y };
  });
  return { label, points };
}

// Hand-authored unistroke templates (screen coords: y grows downward).
// Multi-stroke characters are approximated as their dominant single stroke;
// e.g. 'A' is the Λ without crossbar, 'i'/'j' dots are separate strokes.
const TEXT_TEMPLATES: Template[] = [
  T('A', '0,1 0.5,0 1,1'),
  T('B', '0,0 0,1 0.6,1 0.85,0.9 0.85,0.7 0.6,0.55 0,0.55 0.6,0.55 0.85,0.4 0.85,0.15 0.6,0 0,0'),
  T('C', '0.9,0.2 0.6,0 0.2,0.1 0,0.5 0.2,0.9 0.6,1 0.9,0.8'),
  T('D', '0,0 0,1 0.7,1 1,0.75 1,0.25 0.7,0 0,0'),
  T('E', '0.9,0 0,0 0,1 0.9,1 0,1 0,0.5 0.7,0.5'),
  T('F', '0.9,0 0,0 0,1 0,0.5 0.7,0.5'),
  T('G', '0.9,0.2 0.6,0 0.2,0.1 0,0.5 0.2,0.9 0.6,1 0.9,0.85 0.9,0.55 0.6,0.55'),
  T('H', '0,0 0,1 0,0.5 1,0.5 1,0 1,1'),
  T('I', '0.2,0 0.8,0 0.5,0 0.5,1 0.2,1 0.8,1'),
  T('J', '0.8,0 0.8,0.8 0.6,1 0.3,1 0.15,0.85'),
  T('K', '0,0 0,1 0,0.55 0.9,0 0,0.55 0.9,1'),
  T('L', '0,0 0,1 0.9,1'),
  T('M', '0,1 0,0 0.5,0.7 1,0 1,1'),
  T('N', '0,1 0,0 1,1 1,0'),
  T('O', '0.5,0 0.85,0.15 1,0.5 0.85,0.85 0.5,1 0.15,0.85 0,0.5 0.15,0.15 0.5,0'),
  T('P', '0,1 0,0 0.7,0 0.9,0.2 0.7,0.45 0,0.5'),
  T('Q', '0.5,0 0.85,0.15 1,0.5 0.85,0.85 0.5,1 0.15,0.85 0,0.5 0.15,0.15 0.5,0 0.7,0.7 1,1'),
  T('R', '0,1 0,0 0.7,0 0.9,0.2 0.7,0.45 0,0.5 0.9,1'),
  T('S', '0.9,0.15 0.6,0 0.2,0.1 0.1,0.35 0.4,0.5 0.8,0.6 0.9,0.85 0.6,1 0.2,0.95 0.1,0.8'),
  T('T', '0,0 1,0 0.5,0 0.5,1'),
  T('U', '0,0 0,0.8 0.2,1 0.8,1 1,0.8 1,0'),
  T('V', '0,0 0.5,1 1,0'),
  T('W', '0,0 0.25,1 0.5,0.4 0.75,1 1,0'),
  T('X', '0,0 1,1 0.5,0.5 1,0 0,1'),
  T('Y', '0,0 0.5,0.5 1,0 0.5,0.5 0.5,1'),
  T('Z', '0,0 1,0 0,1 1,1'),
  T('0', '0.5,0 0.85,0.15 1,0.5 0.85,0.85 0.5,1 0.15,0.85 0,0.5 0.15,0.15 0.5,0'),
  T('1', '0.3,0.15 0.5,0 0.5,1 0.3,1 0.7,1'),
  T('2', '0.1,0.15 0.5,0 0.9,0.15 0.9,0.4 0.1,1 0.9,1'),
  T('3', '0.1,0.1 0.6,0 0.9,0.25 0.5,0.5 0.9,0.75 0.6,1 0.1,0.9'),
  T('4', '0.7,0 0.15,0.6 0.85,0.6 0.7,0.6 0.7,1'),
  T('5', '0.9,0 0.2,0 0.15,0.45 0.6,0.5 0.9,0.7 0.8,1 0.2,1 0.1,0.8'),
  T('6', '0.8,0.1 0.4,0.25 0.15,0.6 0.2,0.9 0.5,1 0.8,0.85 0.85,0.6 0.6,0.5 0.3,0.6'),
  T('7', '0.1,0 0.9,0 0.4,1'),
  T('8', '0.5,0 0.15,0.2 0.2,0.45 0.5,0.55 0.8,0.65 0.85,0.9 0.5,1 0.15,0.85 0.2,0.6 0.5,0.5'),
  T('9', '0.2,0.9 0.6,0.75 0.85,0.4 0.8,0.1 0.5,0 0.2,0.15 0.15,0.4 0.4,0.5 0.7,0.4'),
];

const MATH_TEMPLATES: Template[] = [
  T('+', '0.5,0.1 0.5,0.9 0.5,0.5 0.1,0.5 0.9,0.5'),
  T('-', '0.1,0.5 0.9,0.5'),
  T('=', '0.1,0.35 0.9,0.35 0.9,0.65 0.1,0.65'),
  T('/', '0.8,0.1 0.2,0.9'),
  T('*', '0.2,0.2 0.8,0.8 0.5,0.5 0.8,0.2 0.2,0.8'),
  T('(', '0.7,0.05 0.3,0.3 0.3,0.7 0.7,0.95'),
  T(')', '0.3,0.05 0.7,0.3 0.7,0.7 0.3,0.95'),
  T('.', '0.5,0.5'),
  T('%', '0.75,0.15 0.25,0.85 0.2,0.3 0.1,0.2 0.3,0.2 0.2,0.2 0.8,0.7 0.7,0.8 0.9,0.8 0.8,0.8'),
];

const TEMPLATE_N = 32;

/** Normalize a template once (module init): resample + scale to unit box. */
function normalizeTemplate(points: InkPoint[]): InkPoint[] {
  const r = resample(points, TEMPLATE_N);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of r) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  return r.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / h }));
}

const NORMALIZED_TEXT = TEXT_TEMPLATES.map((t) => ({ label: t.label, points: normalizeTemplate(t.points) }));
const NORMALIZED_MATH = MATH_TEMPLATES.map((t) => ({ label: t.label, points: normalizeTemplate(t.points) }));

function templateDistance(a: InkPoint[], b: InkPoint[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].x - b[i].x;
    const dy = a[i].y - b[i].y;
    sum += dx * dx + dy * dy;
  }
  return Math.sqrt(sum / a.length);
}

export interface CharMatch {
  char: string;
  /** Mean normalized point distance; lower is better. */
  score: number;
}

/**
 * Match one stroke against the text templates (A–Z, 0–9). Returns null
 * when nothing is close enough. Note: 'O' and '0' share a template and
 * both are reported as 'O' — callers pick by context.
 */
export function recognizeInkChar(stroke: InkStroke): CharMatch | null {
  if (stroke.points.length < 2 && pathLength(stroke.points) < 2) return null;
  const norm = normalizeTemplate(stroke.points);
  let best: CharMatch | null = null;
  for (const t of NORMALIZED_TEXT) {
    const d = templateDistance(norm, t.points);
    if (!best || d < best.score) best = { char: t.label, score: d };
  }
  // Calibrated: exact/noisy template redraws score ~0 (resampling smooths
  // jitter); non-character doodles score >= 0.35. 0.30 cleanly separates.
  if (best && best.score > 0.3) return null;
  return best;
}

/** Match one stroke against the math-symbol templates. */
export function recognizeInkMathSymbol(stroke: InkStroke): CharMatch | null {
  if (stroke.points.length < 2 && pathLength(stroke.points) < 2) {
    // A dot: treat as a decimal point.
    return { char: '.', score: 0 };
  }
  const norm = normalizeTemplate(stroke.points);
  let best: CharMatch | null = null;
  for (const t of NORMALIZED_MATH) {
    const d = templateDistance(norm, t.points);
    if (!best || d < best.score) best = { char: t.label, score: d };
  }
  if (best && best.score > 0.3) return null;
  return best;
}

/**
 * Ink to Text: recognize each stroke as one character, left to right,
 * and join. Strokes are sorted by their bounding-box left edge. Returns
 * the text and per-character matches (for confidence display).
 */
export function recognizeInkText(strokes: InkStroke[]): { text: string; matches: CharMatch[] } {
  const ordered = [...strokes].sort((a, b) => strokeBoundingBox(a).x - strokeBoundingBox(b).x);
  const matches: CharMatch[] = [];
  let text = '';
  for (const s of ordered) {
    const m = recognizeInkChar(s);
    if (m) {
      matches.push(m);
      text += m.char;
    }
  }
  return { text, matches };
}

/**
 * Ink to Math: recognize each stroke as a digit or math operator and
 * join into an expression string. 'O' matches are mapped to '0' here;
 * digits use the same templates as text mode.
 */
export function recognizeInkMath(strokes: InkStroke[]): { expression: string; matches: CharMatch[] } {
  const ordered = [...strokes].sort((a, b) => strokeBoundingBox(a).x - strokeBoundingBox(b).x);
  const matches: CharMatch[] = [];
  let expression = '';
  for (const s of ordered) {
    // Digits first (text templates cover 0–9), then math operators.
    const digit = recognizeInkChar(s);
    const sym = recognizeInkMathSymbol(s);
    let pick: CharMatch | null = null;
    if (digit && /^[0-9O]$/.test(digit.char)) pick = { char: digit.char === 'O' ? '0' : digit.char, score: digit.score };
    if (sym && (!pick || sym.score < pick.score - 0.05)) pick = sym;
    else if (!pick && digit) pick = digit;
    if (pick) {
      matches.push(pick);
      expression += pick.char;
    }
  }
  return { expression, matches };
}
