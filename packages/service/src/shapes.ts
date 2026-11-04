/**
 * Full Excel shape gallery (Insert > Shapes).
 *
 * 100+ autoshapes across Excel's 7 categories: Lines, Rectangles, Basic
 * Shapes, Block Arrows, Flowchart, Stars and Banners, Callouts. Each
 * definition carries inner SVG markup for a `0 0 100 100` viewBox; the
 * host renders it with its own fill/stroke (elements inherit from the
 * wrapping <g>, and may override with explicit attributes).
 *
 * SERVICE-LAYER, pure and headless: static data + deterministic geometry
 * helpers, no DOM.
 */

export type ShapeCategoryId =
  | 'lines'
  | 'rectangles'
  | 'basic'
  | 'arrows'
  | 'flowchart'
  | 'stars'
  | 'callouts';

export interface ShapeCategory {
  id: ShapeCategoryId;
  label: string;
}

export const SHAPE_CATEGORIES: ShapeCategory[] = [
  { id: 'lines', label: 'Lines' },
  { id: 'rectangles', label: 'Rectangles' },
  { id: 'basic', label: 'Basic Shapes' },
  { id: 'arrows', label: 'Block Arrows' },
  { id: 'flowchart', label: 'Flowchart' },
  { id: 'stars', label: 'Stars and Banners' },
  { id: 'callouts', label: 'Callouts' },
];

export interface ShapeDef {
  /** Stable id; the 20 legacy ids from the original gallery are kept verbatim. */
  id: string;
  name: string;
  category: ShapeCategoryId;
  /** Inner SVG markup for a `0 0 100 100` viewBox. */
  svg: string;
  /** Lines/curves render stroke-only (host sets fill="none"). */
  lineOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Deterministic geometry helpers (0–100 space)
// ---------------------------------------------------------------------------

const r1 = (n: number): string => String(Math.round(n * 10) / 10);

function polyPts(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
}

const poly = (pts: [number, number][]): string => `<polygon points="${polyPts(pts)}"/>`;

/** Regular n-gon, first vertex at the top. */
function ngon(n: number, cx = 50, cy = 50, r = 45): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Star polygon, outer/inner radii alternating, first point at the top. */
function starPts(spikes: number, outer = 46, inner: number = 19, cx = 50, cy = 50): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}

function rect(x: number, y: number, w: number, h: number, rx = 0): string {
  return `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}"${rx ? ` rx="${r1(rx)}"` : ''}/>`;
}

// ---------------------------------------------------------------------------
// Category: Lines
// ---------------------------------------------------------------------------

const LINES: ShapeDef[] = [
  {
    id: 'line',
    name: 'Line',
    category: 'lines',
    svg: '<line x1="8" y1="85" x2="92" y2="15" stroke-linecap="round"/>',
    lineOnly: true,
  },
  {
    id: 'arrow',
    name: 'Line Arrow',
    category: 'lines',
    svg:
      '<line x1="8" y1="85" x2="78" y2="28" stroke-linecap="round"/>' +
      '<polygon points="92,15 74,16 82,32"/>',
    lineOnly: true,
  },
  {
    id: 'doubleArrow',
    name: 'Line Arrow: Double',
    category: 'lines',
    svg:
      '<line x1="22" y1="71" x2="78" y2="29" stroke-linecap="round"/>' +
      '<polygon points="8,85 26,84 18,68"/><polygon points="92,15 74,16 82,32"/>',
    lineOnly: true,
  },
  {
    id: 'curve',
    name: 'Curve',
    category: 'lines',
    svg: '<path d="M10,80 C35,80 38,22 64,22 C80,22 84,52 92,50"/>',
    lineOnly: true,
  },
  {
    id: 'freeform',
    name: 'Freeform: Shape',
    category: 'lines',
    svg: '<path d="M10,85 L30,40 L46,60 L62,26 L80,54 L92,30" stroke-linejoin="round"/>',
    lineOnly: true,
  },
  {
    id: 'scribble',
    name: 'Scribble',
    category: 'lines',
    svg: '<path d="M12,80 C20,60 14,46 28,40 C42,35 36,56 52,50 C68,44 62,26 76,30 C86,33 82,50 92,48" stroke-linecap="round"/>',
    lineOnly: true,
  },
];

// ---------------------------------------------------------------------------
// Category: Rectangles
// ---------------------------------------------------------------------------

const RECTANGLES: ShapeDef[] = [
  { id: 'rect', name: 'Rectangle', category: 'rectangles', svg: rect(8, 18, 84, 64) },
  { id: 'roundedRect', name: 'Rounded Rectangle', category: 'rectangles', svg: rect(8, 18, 84, 64, 14) },
];

// ---------------------------------------------------------------------------
// Category: Basic Shapes
// ---------------------------------------------------------------------------

const BASIC: ShapeDef[] = [
  { id: 'oval', name: 'Oval', category: 'basic', svg: '<ellipse cx="50" cy="50" rx="42" ry="32"/>' },

  { id: 'triangle', name: 'Isosceles Triangle', category: 'basic', svg: poly([[50, 6], [94, 90], [6, 90]]) },
  { id: 'rightTriangle', name: 'Right Triangle', category: 'basic', svg: poly([[10, 8], [90, 90], [10, 90]]) },
  {
    id: 'parallelogram',
    name: 'Parallelogram',
    category: 'basic',
    svg: poly([[32, 8], [92, 8], [68, 92], [8, 92]]),
  },
  {
    id: 'trapezoid',
    name: 'Trapezoid',
    category: 'basic',
    svg: poly([[28, 8], [72, 8], [92, 92], [8, 92]]),
  },
  { id: 'diamond', name: 'Diamond', category: 'basic', svg: poly([[50, 6], [94, 50], [50, 94], [6, 50]]) },
  { id: 'pentagon', name: 'Pentagon', category: 'basic', svg: poly(ngon(5)) },
  { id: 'hexagon', name: 'Hexagon', category: 'basic', svg: poly(ngon(6)) },
  { id: 'heptagon', name: 'Heptagon', category: 'basic', svg: poly(ngon(7)) },
  { id: 'octagon', name: 'Octagon', category: 'basic', svg: poly(ngon(8)) },
  { id: 'decagon', name: 'Decagon', category: 'basic', svg: poly(ngon(10)) },
  { id: 'dodecagon', name: 'Dodecagon', category: 'basic', svg: poly(ngon(12)) },
  {
    id: 'pie',
    name: 'Pie',
    category: 'basic',
    svg: '<path d="M50,50 L92,50 A42,42 0 0,0 50,8 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'chord',
    name: 'Chord',
    category: 'basic',
    svg: '<path d="M14,72 A42,42 0 0,1 86,72 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'teardrop',
    name: 'Teardrop',
    category: 'basic',
    svg: '<path d="M50,6 C50,6 86,44 86,66 A36,36 0 0,1 14,66 C14,44 50,6 50,6 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'frame',
    name: 'Frame',
    category: 'basic',
    svg: '<path fill-rule="evenodd" d="M8,8 H92 V92 H8 Z M24,24 H76 V76 H24 Z"/>',
  },
  {
    id: 'halfFrame',
    name: 'Half Frame',
    category: 'basic',
    svg: '<path fill-rule="evenodd" d="M8,8 H92 V92 H8 Z M24,24 H92 V92 H24 Z"/>',
  },
  {
    id: 'corner',
    name: 'Corner',
    category: 'basic',
    svg: poly([[8, 8], [40, 8], [40, 40], [92, 40], [92, 92], [60, 92], [60, 60], [8, 60]]),
  },
  {
    id: 'diagonalStripe',
    name: 'Diagonal Stripe',
    category: 'basic',
    svg: poly([[30, 8], [44, 8], [74, 92], [60, 92]]),
  },
  {
    id: 'plus',
    name: 'Cross',
    category: 'basic',
    svg: poly([
      [35, 4], [65, 4], [65, 35], [96, 35], [96, 65], [65, 65],
      [65, 96], [35, 96], [35, 65], [4, 65], [4, 35], [35, 35],
    ]),
  },
  {
    id: 'plaque',
    name: 'Plaque',
    category: 'basic',
    svg: '<path d="M8,8 H92 V38 C80,44 80,56 92,62 V92 H8 V62 C20,56 20,44 8,38 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'can',
    name: 'Can',
    category: 'basic',
    svg:
      '<ellipse cx="50" cy="22" rx="34" ry="12"/>' +
      '<path d="M16,22 V74 A34,12 0 0,0 84,74 V22" stroke-linejoin="round"/>',
  },
  {
    id: 'cube',
    name: 'Cube',
    category: 'basic',
    svg:
      poly([[50, 6], [88, 28], [88, 72], [50, 94], [12, 72], [12, 28]]) +
      '<path d="M12,28 L50,50 L88,28 M50,50 V94" fill="none"/>',
  },
  {
    id: 'bevel',
    name: 'Bevel',
    category: 'basic',
    svg: poly([[20, 8], [80, 8], [92, 20], [92, 80], [80, 92], [20, 92], [8, 80], [8, 20]]),
  },
  {
    id: 'donut',
    name: 'Donut',
    category: 'basic',
    svg: '<path fill-rule="evenodd" d="M50,50 m-42,0 a42,42 0 1,0 84,0 a42,42 0 1,0 -84,0 M50,50 m-22,0 a22,22 0 1,0 44,0 a22,22 0 1,0 -44,0"/>',
  },
  {
    id: 'noSymbol',
    name: 'No Symbol',
    category: 'basic',
    svg: '<circle cx="50" cy="50" r="40"/><line x1="22" y1="78" x2="78" y2="22" stroke-width="10" stroke-linecap="round"/>',
  },
  {
    id: 'blockArc',
    name: 'Block Arc',
    category: 'basic',
    svg: '<path d="M50,8 A42,42 0 0,1 92,50 L72,50 A22,22 0 0,0 50,28 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'foldedCorner',
    name: 'Folded Corner',
    category: 'basic',
    svg:
      poly([[12, 6], [64, 6], [92, 34], [92, 94], [12, 94]]) +
      '<path d="M64,8 V32 H90" fill="none" stroke-linejoin="round"/>',
  },
  {
    id: 'smileyFace',
    name: 'Smiley Face',
    category: 'basic',
    svg:
      '<circle cx="50" cy="50" r="42"/>' +
      '<circle cx="36" cy="40" r="5"/><circle cx="64" cy="40" r="5"/>' +
      '<path d="M30,62 Q50,78 70,62" fill="none" stroke-linecap="round"/>',
  },
  {
    id: 'heart',
    name: 'Heart',
    category: 'basic',
    svg: '<path d="M50,88 C20,62 8,44 8,30 C8,16 18,8 30,8 C40,8 47,14 50,22 C53,14 60,8 70,8 C82,8 92,16 92,30 C92,44 80,62 50,88 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'lightningBolt',
    name: 'Lightning Bolt',
    category: 'basic',
    svg: poly([[56, 4], [24, 56], [46, 56], [40, 96], [76, 42], [54, 42]]),
  },
  {
    id: 'sun',
    name: 'Sun',
    category: 'basic',
    svg:
      '<circle cx="50" cy="50" r="20"/>' +
      '<path d="M50,8 V20 M50,80 V92 M8,50 H20 M80,50 H92 M20,20 L28,28 M72,72 L80,80 M80,20 L72,28 M28,72 L20,80" fill="none" stroke-linecap="round"/>',
  },
  {
    id: 'moon',
    name: 'Moon',
    category: 'basic',
    svg: '<path fill-rule="evenodd" d="M64,8 A40,40 0 1,0 64,92 A32,32 0 1,1 64,8 Z"/>',
  },
  {
    id: 'arc',
    name: 'Arc',
    category: 'basic',
    svg: '<path d="M12,78 A44,44 0 0,1 88,78" fill="none" stroke-linecap="round"/>',
  },
  {
    id: 'leftBracket',
    name: 'Left Bracket',
    category: 'basic',
    svg: '<path d="M72,10 H32 V90 H72" fill="none" stroke-width="10" stroke-linejoin="round"/>',
  },
  {
    id: 'rightBracket',
    name: 'Right Bracket',
    category: 'basic',
    svg: '<path d="M28,10 H68 V90 H28" fill="none" stroke-width="10" stroke-linejoin="round"/>',
  },
  {
    id: 'leftBrace',
    name: 'Left Brace',
    category: 'basic',
    svg: '<path d="M68,8 C48,8 52,32 32,42 C52,52 48,76 68,92" fill="none" stroke-width="8" stroke-linecap="round"/>',
  },
  {
    id: 'rightBrace',
    name: 'Right Brace',
    category: 'basic',
    svg: '<path d="M32,8 C52,8 48,32 68,42 C48,52 52,76 32,92" fill="none" stroke-width="8" stroke-linecap="round"/>',
  },
  {
    id: 'cloud',
    name: 'Cloud',
    category: 'basic',
    svg: '<path d="M30,62 a12,12 0 0,1 4,-23 a14,14 0 0,1 24,-8 a13,13 0 0,1 22,6 a11,11 0 0,1 6,21 a10,10 0 0,1 -14,10 l-32,0 a10,10 0 0,1 -10,-6 Z" stroke-linejoin="round"/>',
  },
];

// ---------------------------------------------------------------------------
// Category: Block Arrows
// ---------------------------------------------------------------------------

const ARROWS: ShapeDef[] = [
  {
    id: 'blockArrow',
    name: 'Right Arrow',
    category: 'arrows',
    svg: poly([[4, 32], [56, 32], [56, 14], [96, 50], [56, 86], [56, 68], [4, 68]]),
  },
  {
    id: 'leftArrow',
    name: 'Left Arrow',
    category: 'arrows',
    svg: poly([[96, 32], [44, 32], [44, 14], [4, 50], [44, 86], [44, 68], [96, 68]]),
  },
  {
    id: 'upArrow',
    name: 'Up Arrow',
    category: 'arrows',
    svg: poly([[32, 96], [32, 44], [14, 44], [50, 4], [86, 44], [68, 44], [68, 96]]),
  },
  {
    id: 'downArrow',
    name: 'Down Arrow',
    category: 'arrows',
    svg: poly([[32, 4], [32, 56], [14, 56], [50, 96], [86, 56], [68, 56], [68, 4]]),
  },
  {
    id: 'leftRightArrow',
    name: 'Left-Right Arrow',
    category: 'arrows',
    svg: poly([[6, 50], [30, 34], [30, 40], [70, 40], [70, 34], [94, 50], [70, 66], [70, 60], [30, 60], [30, 66]]),
  },
  {
    id: 'upDownArrow',
    name: 'Up-Down Arrow',
    category: 'arrows',
    svg: poly([[50, 6], [66, 30], [60, 30], [60, 70], [66, 70], [50, 94], [34, 70], [40, 70], [40, 30], [34, 30]]),
  },
  {
    id: 'quadArrow',
    name: 'Quad Arrow',
    category: 'arrows',
    svg: '<path d="M50,6 L58,20 H54 V42 H76 V38 L90,50 L76,62 V58 H54 V80 H58 L50,94 L42,80 H46 V58 H24 V62 L10,50 L24,38 V42 H46 V20 H42 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'bentArrow',
    name: 'Bent Arrow',
    category: 'arrows',
    svg: poly([[10, 92], [34, 92], [34, 64], [58, 64], [58, 80], [94, 50], [58, 20], [58, 36], [10, 36]]),
  },
  {
    id: 'bentUpArrow',
    name: 'Bent-Up Arrow',
    category: 'arrows',
    svg: poly([[10, 92], [34, 92], [34, 58], [62, 58], [62, 42], [46, 42], [66, 14], [86, 42], [70, 42], [70, 58], [10, 58]]),
  },
  {
    id: 'uTurnArrow',
    name: 'U-Turn Arrow',
    category: 'arrows',
    svg:
      '<path d="M28,10 V62 H60 V42" fill="none" stroke-width="14" stroke-linejoin="round"/>' +
      '<polygon points="60,20 46,42 74,42"/>',
  },
  {
    id: 'curvedRightArrow',
    name: 'Curved Right Arrow',
    category: 'arrows',
    svg:
      '<path d="M14,78 C40,78 55,60 62,38" fill="none" stroke-width="12" stroke-linecap="round"/>' +
      '<polygon points="66,22 48,42 74,48"/>',
  },
  {
    id: 'curvedLeftArrow',
    name: 'Curved Left Arrow',
    category: 'arrows',
    svg:
      '<path d="M86,78 C60,78 45,60 38,38" fill="none" stroke-width="12" stroke-linecap="round"/>' +
      '<polygon points="34,22 52,42 26,48"/>',
  },
  {
    id: 'curvedUpArrow',
    name: 'Curved Up Arrow',
    category: 'arrows',
    svg:
      '<path d="M22,86 C22,60 40,46 62,40" fill="none" stroke-width="12" stroke-linecap="round"/>' +
      '<polygon points="82,38 60,28 62,54"/>',
  },
  {
    id: 'curvedDownArrow',
    name: 'Curved Down Arrow',
    category: 'arrows',
    svg:
      '<path d="M22,14 C22,40 40,54 62,60" fill="none" stroke-width="12" stroke-linecap="round"/>' +
      '<polygon points="82,62 60,72 62,46"/>',
  },
  {
    id: 'circularArrow',
    name: 'Circular Arrow',
    category: 'arrows',
    svg:
      '<path d="M78,50 A28,28 0 1,1 62,26" fill="none" stroke-width="10" stroke-linecap="round"/>' +
      '<polygon points="62,10 48,32 74,36"/>',
  },
  {
    id: 'stripedRightArrow',
    name: 'Striped Right Arrow',
    category: 'arrows',
    svg:
      poly([[30, 32], [58, 32], [58, 14], [96, 50], [58, 86], [58, 68], [30, 68]]) +
      '<path d="M8,32 V68 M18,32 V68" fill="none" stroke-width="6" stroke-linecap="round"/>',
  },
  {
    id: 'notchedRightArrow',
    name: 'Notched Right Arrow',
    category: 'arrows',
    svg: poly([[28, 32], [56, 32], [56, 14], [96, 50], [56, 86], [56, 68], [28, 68], [40, 50]]),
  },
  {
    id: 'chevron',
    name: 'Chevron',
    category: 'arrows',
    svg: poly([[5, 20], [60, 20], [95, 50], [60, 80], [5, 80], [40, 50]]),
  },
  {
    id: 'pentagonArrow',
    name: 'Pentagon (Home Plate)',
    category: 'arrows',
    svg: poly([[8, 20], [60, 20], [92, 50], [60, 80], [8, 80]]),
  },
  {
    id: 'leftUpArrow',
    name: 'Left-Up Diagonal Arrow',
    category: 'arrows',
    svg:
      '<path d="M24,76 L62,38" fill="none" stroke-width="16" stroke-linejoin="round"/>' +
      '<polygon points="92,20 60,24 68,56"/>',
  },
];

// ---------------------------------------------------------------------------
// Category: Flowchart
// ---------------------------------------------------------------------------

const FLOWCHART: ShapeDef[] = [
  { id: 'flowProcess', name: 'Process', category: 'flowchart', svg: rect(10, 28, 80, 44) },
  { id: 'flowAltProcess', name: 'Alternate Process', category: 'flowchart', svg: rect(10, 28, 80, 44, 12) },
  {
    id: 'flowDecision',
    name: 'Decision',
    category: 'flowchart',
    svg: poly([[50, 8], [90, 50], [50, 92], [10, 50]]),
  },
  {
    id: 'flowInputOutput',
    name: 'Data (Input/Output)',
    category: 'flowchart',
    svg: poly([[30, 24], [90, 24], [70, 76], [10, 76]]),
  },
  {
    id: 'flowPredefinedProcess',
    name: 'Predefined Process',
    category: 'flowchart',
    svg: rect(10, 28, 80, 44) + '<path d="M24,28 V72 M76,28 V72" fill="none"/>',
  },
  {
    id: 'flowInternalStorage',
    name: 'Internal Storage',
    category: 'flowchart',
    svg: rect(10, 24, 80, 52) + '<path d="M10,38 H90 M24,24 V76" fill="none"/>',
  },
  {
    id: 'flowDocument',
    name: 'Document',
    category: 'flowchart',
    svg: '<path d="M12,12 H88 V76 C76,68 64,68 52,76 C40,84 28,84 12,76 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'flowMultiDocument',
    name: 'Multi-Document',
    category: 'flowchart',
    svg:
      '<path d="M20,20 H88 V74 C78,68 68,68 58,74" fill="none" stroke-linejoin="round"/>' +
      '<path d="M14,12 H82" fill="none"/>' +
      '<path d="M12,28 H80 V82 C70,76 60,76 50,82 C40,88 30,88 12,82 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'flowTerminator',
    name: 'Terminator',
    category: 'flowchart',
    svg: rect(10, 28, 80, 44, 22),
  },
  {
    id: 'flowPreparation',
    name: 'Preparation',
    category: 'flowchart',
    svg: poly([[24, 26], [76, 26], [90, 50], [76, 74], [24, 74], [10, 50]]),
  },
  {
    id: 'flowManualInput',
    name: 'Manual Input',
    category: 'flowchart',
    svg: poly([[12, 32], [88, 12], [88, 88], [12, 88]]),
  },
  {
    id: 'flowManualOperation',
    name: 'Manual Operation',
    category: 'flowchart',
    svg: poly([[28, 20], [72, 20], [90, 80], [10, 80]]),
  },
  {
    id: 'flowConnector',
    name: 'Connector',
    category: 'flowchart',
    svg: '<circle cx="50" cy="50" r="30"/>',
  },
  {
    id: 'flowOffpageConnector',
    name: 'Off-Page Connector',
    category: 'flowchart',
    svg: poly([[20, 12], [80, 12], [80, 58], [50, 90], [20, 58]]),
  },
  {
    id: 'flowPunchedCard',
    name: 'Card',
    category: 'flowchart',
    svg: poly([[28, 10], [88, 10], [88, 90], [12, 90], [12, 26]]),
  },
  {
    id: 'flowSummingJunction',
    name: 'Summing Junction',
    category: 'flowchart',
    svg: '<circle cx="50" cy="50" r="34"/><path d="M32,32 L68,68 M68,32 L32,68" fill="none"/>',
  },
  {
    id: 'flowOr',
    name: 'Or',
    category: 'flowchart',
    svg: '<circle cx="50" cy="50" r="34"/><path d="M50,32 V68 M32,50 H68" fill="none"/>',
  },
  {
    id: 'flowCollate',
    name: 'Collate',
    category: 'flowchart',
    svg: poly([[20, 12], [80, 12], [50, 48]]) + poly([[20, 88], [80, 88], [50, 52]]),
  },
  {
    id: 'flowSort',
    name: 'Sort',
    category: 'flowchart',
    svg: poly([[50, 10], [88, 50], [50, 90], [12, 50]]) + '<path d="M12,50 H88" fill="none"/>',
  },
  {
    id: 'flowExtract',
    name: 'Extract',
    category: 'flowchart',
    svg:
      poly([[50, 90], [14, 32], [86, 32]]) +
      '<path d="M14,20 H86" fill="none" stroke-width="8" stroke-linecap="round"/>',
  },
  {
    id: 'flowMerge',
    name: 'Merge',
    category: 'flowchart',
    svg:
      poly([[50, 10], [86, 68], [14, 68]]) +
      '<path d="M14,80 H86" fill="none" stroke-width="8" stroke-linecap="round"/>',
  },
  {
    id: 'flowDelay',
    name: 'Delay',
    category: 'flowchart',
    svg: '<path d="M14,20 H56 A30,30 0 0,1 56,80 H14 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'flowDisplay',
    name: 'Display',
    category: 'flowchart',
    svg: '<path d="M14,16 H68 C86,32 86,68 68,84 H14 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'flowMagneticDisk',
    name: 'Direct Access Storage',
    category: 'flowchart',
    svg:
      '<ellipse cx="50" cy="26" rx="32" ry="10"/>' +
      '<path d="M18,26 V72 A32,10 0 0,0 82,72 V26" stroke-linejoin="round"/>',
  },
];

// ---------------------------------------------------------------------------
// Category: Stars and Banners
// ---------------------------------------------------------------------------

const STARS: ShapeDef[] = [
  { id: 'star4', name: '4-Point Star', category: 'stars', svg: poly(starPts(4, 46, 15)) },
  { id: 'star5', name: '5-Point Star', category: 'stars', svg: poly(starPts(5, 46, 19)) },
  { id: 'star6', name: '6-Point Star', category: 'stars', svg: poly(starPts(6, 46, 22)) },
  { id: 'star8', name: '8-Point Star', category: 'stars', svg: poly(starPts(8, 46, 26)) },
  { id: 'star10', name: '10-Point Star', category: 'stars', svg: poly(starPts(10, 46, 30)) },
  { id: 'star12', name: '12-Point Star', category: 'stars', svg: poly(starPts(12, 46, 32)) },
  { id: 'star16', name: '16-Point Star', category: 'stars', svg: poly(starPts(16, 46, 35)) },
  { id: 'star24', name: '24-Point Star', category: 'stars', svg: poly(starPts(24, 46, 38)) },
  { id: 'star32', name: '32-Point Star', category: 'stars', svg: poly(starPts(32, 46, 40)) },
  { id: 'explosion1', name: 'Explosion: 8 Points', category: 'stars', svg: poly(starPts(8, 48, 24)) },
  { id: 'explosion2', name: 'Explosion: 14 Points', category: 'stars', svg: poly(starPts(14, 48, 28)) },
  {
    id: 'ribbonDown',
    name: 'Down Ribbon',
    category: 'stars',
    svg:
      poly([[26, 8], [74, 8], [74, 54], [50, 68], [26, 54]]) +
      poly([[26, 54], [26, 70], [14, 82], [26, 76], [34, 86], [38, 60]]),
  },
  {
    id: 'ribbonUp',
    name: 'Up Ribbon',
    category: 'stars',
    svg:
      poly([[26, 92], [74, 92], [74, 46], [50, 32], [26, 46]]) +
      poly([[26, 46], [26, 30], [14, 18], [26, 24], [34, 14], [38, 40]]),
  },
  {
    id: 'verticalScroll',
    name: 'Vertical Scroll',
    category: 'stars',
    svg:
      rect(26, 16, 48, 68) +
      '<path d="M26,16 C26,8 40,8 40,16 M74,16 C74,8 60,8 60,16 M26,84 C26,92 40,92 40,84 M74,84 C74,92 60,92 60,84" fill="none"/>',
  },
  {
    id: 'horizontalScroll',
    name: 'Horizontal Scroll',
    category: 'stars',
    svg:
      rect(16, 26, 68, 48) +
      '<path d="M16,26 C8,26 8,40 16,40 M16,74 C8,74 8,60 16,60 M84,26 C92,26 92,40 84,40 M84,74 C92,74 92,60 84,60" fill="none"/>',
  },
  {
    id: 'wave',
    name: 'Wave',
    category: 'stars',
    svg: '<path d="M8,34 C28,18 40,18 56,34 C72,50 84,50 92,38 L92,66 C84,78 72,78 56,62 C40,46 28,46 8,62 Z" stroke-linejoin="round"/>',
  },
  {
    id: 'doubleWave',
    name: 'Double Wave',
    category: 'stars',
    svg:
      '<path d="M8,24 C28,10 40,10 56,24 C72,38 84,38 92,28 L92,46 C84,56 72,56 56,42 C40,28 28,28 8,42 Z" stroke-linejoin="round"/>' +
      '<path d="M8,58 C28,44 40,44 56,58 C72,72 84,72 92,62 L92,80 C84,90 72,90 56,76 C40,62 28,62 8,76 Z" stroke-linejoin="round"/>',
  },
];

// ---------------------------------------------------------------------------
// Category: Callouts
// ---------------------------------------------------------------------------

const CALLOUTS: ShapeDef[] = [
  {
    id: 'speechBubble',
    name: 'Rectangular Callout',
    category: 'callouts',
    svg: rect(14, 8, 72, 52, 2) + poly([[40, 60], [54, 60], [34, 92]]),
  },
  {
    id: 'calloutRoundedRect',
    name: 'Rounded Rectangular Callout',
    category: 'callouts',
    svg: rect(14, 8, 72, 52, 12) + poly([[40, 60], [54, 60], [34, 92]]),
  },
  {
    id: 'calloutOval',
    name: 'Oval Callout',
    category: 'callouts',
    svg: '<ellipse cx="50" cy="34" rx="36" ry="26"/>' + poly([[42, 56], [56, 56], [36, 90]]),
  },
  {
    id: 'cloudCallout',
    name: 'Cloud Callout',
    category: 'callouts',
    svg:
      '<path d="M32,50 a11,11 0 0,1 4,-21 a13,13 0 0,1 22,-8 a12,12 0 0,1 20,6 a10,10 0 0,1 6,19 a9,9 0 0,1 -12,10 l-30,0 a9,9 0 0,1 -10,-6 Z" stroke-linejoin="round"/>' +
      '<circle cx="40" cy="72" r="6"/><circle cx="30" cy="84" r="4"/>',
  },
  {
    id: 'lineCallout1',
    name: 'Line Callout 1',
    category: 'callouts',
    svg:
      rect(8, 8, 58, 36, 2) +
      '<path d="M66,44 L86,84" fill="none"/>' +
      '<circle cx="86" cy="84" r="3"/>',
  },
  {
    id: 'lineCallout2',
    name: 'Line Callout 1 (Border)',
    category: 'callouts',
    svg:
      rect(8, 8, 58, 36, 2) +
      '<path d="M37,44 V66 H84" fill="none"/>' +
      '<circle cx="84" cy="66" r="3"/>',
  },
  {
    id: 'lineCallout3',
    name: 'Line Callout 2',
    category: 'callouts',
    svg:
      '<ellipse cx="37" cy="26" rx="29" ry="18"/>' +
      '<path d="M66,44 L86,84" fill="none"/>' +
      '<circle cx="86" cy="84" r="3"/>',
  },
  {
    id: 'accentCallout1',
    name: 'Line Callout 1 (Accent Bar)',
    category: 'callouts',
    svg:
      rect(8, 8, 58, 36, 2) +
      rect(8, 8, 10, 36) +
      '<path d="M66,44 L86,84" fill="none"/>' +
      '<circle cx="86" cy="84" r="3"/>',
  },
  {
    id: 'accentCallout2',
    name: 'Line Callout 2 (Accent Bar)',
    category: 'callouts',
    svg:
      rect(8, 8, 58, 36, 2) +
      rect(8, 8, 10, 36) +
      '<path d="M37,44 V66 H84" fill="none"/>' +
      '<circle cx="84" cy="66" r="3"/>',
  },
  {
    id: 'accentCallout3',
    name: 'Line Callout 3 (Accent Bar)',
    category: 'callouts',
    svg:
      '<ellipse cx="37" cy="26" rx="29" ry="18"/>' +
      '<path d="M66,44 L86,84" fill="none"/>' +
      '<circle cx="86" cy="84" r="3"/>',
  },
  {
    id: 'borderCallout1',
    name: 'Line Callout 3 (Border)',
    category: 'callouts',
    svg:
      '<ellipse cx="37" cy="26" rx="29" ry="18"/>' +
      '<path d="M37,44 V66 H84" fill="none"/>' +
      '<circle cx="84" cy="66" r="3"/>',
  },
  {
    id: 'borderCallout2',
    name: 'Line Callout 4 (Border)',
    category: 'callouts',
    svg:
      rect(8, 8, 58, 36, 12) +
      '<path d="M66,44 L86,84" fill="none"/>' +
      '<circle cx="86" cy="84" r="3"/>',
  },
];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Every shape definition, in gallery order (category by category). */
export const SHAPE_DEFS: ShapeDef[] = [
  ...LINES,
  ...RECTANGLES,
  ...BASIC,
  ...ARROWS,
  ...FLOWCHART,
  ...STARS,
  ...CALLOUTS,
];

/** Total shapes in the gallery. */
export const SHAPE_COUNT: number = SHAPE_DEFS.length;

const byId = new Map<string, ShapeDef>(SHAPE_DEFS.map((d) => [d.id, d]));

/** Look up a shape definition by id; undefined for unknown ids. */
export function shapeDefById(id: string): ShapeDef | undefined {
  return byId.get(id);
}

/** All definitions in one category, in gallery order. */
export function shapesByCategory(category: ShapeCategoryId): ShapeDef[] {
  return SHAPE_DEFS.filter((d) => d.category === category);
}

/** True when the id is a known shape in the gallery. */
export function isKnownShapeId(id: string): boolean {
  return byId.has(id);
}
