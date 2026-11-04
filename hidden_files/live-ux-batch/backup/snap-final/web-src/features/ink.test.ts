import { describe, expect, it } from 'vitest';
import {
  inkMetadataKey,
  inkStrokesFromMetadata,
  inkStrokesToMetadata,
  pointInPolygon,
  pointToSegmentDistance,
  recognizeInkChar,
  recognizeInkMath,
  recognizeInkMathSymbol,
  recognizeInkShape,
  recognizeInkText,
  resample,
  simplifyStroke,
  strokeBoundingBox,
  strokeHitTest,
  strokesInLasso,
  type InkPoint,
  type InkStroke,
} from './ink';

let nextId = 1;
function mkStroke(points: InkPoint[], tool: InkStroke['tool'] = 'pen'): InkStroke {
  return { id: nextId++, tool, color: '#000', width: 2, points, createdAt: 0 };
}

function linePts(x1: number, y1: number, x2: number, y2: number, n = 20): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i < n; i++) out.push({ x: x1 + ((x2 - x1) * i) / (n - 1), y: y1 + ((y2 - y1) * i) / (n - 1) });
  return out;
}

function circlePts(cx: number, cy: number, r: number, n = 48): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

function rectPts(x: number, y: number, w: number, h: number): InkPoint[] {
  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ];
  const out: InkPoint[] = [];
  for (let i = 0; i < corners.length - 1; i++) out.push(...linePts(corners[i].x, corners[i].y, corners[i + 1].x, corners[i + 1].y, 12).slice(0, -1));
  out.push({ x, y });
  return out;
}

function trianglePts(): InkPoint[] {
  const corners = [
    { x: 50, y: 10 },
    { x: 90, y: 90 },
    { x: 10, y: 90 },
    { x: 50, y: 10 },
  ];
  const out: InkPoint[] = [];
  for (let i = 0; i < corners.length - 1; i++) out.push(...linePts(corners[i].x, corners[i].y, corners[i + 1].x, corners[i + 1].y, 12).slice(0, -1));
  out.push({ x: 50, y: 10 });
  return out;
}

// Character strokes drawn from the same 0..1 template space, scaled up.
function charStroke(spec: string, scale = 100): InkStroke {
  const pts = spec.split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { x: x * scale, y: y * scale };
  });
  return mkStroke(pts);
}

describe('geometry helpers', () => {
  it('strokeBoundingBox covers all points', () => {
    const s = mkStroke([{ x: 5, y: 10 }, { x: 20, y: 3 }]);
    expect(strokeBoundingBox(s)).toEqual({ x: 5, y: 3, w: 15, h: 7 });
  });

  it('pointToSegmentDistance measures perpendicular distance', () => {
    expect(pointToSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
    expect(pointToSegmentDistance({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
  });

  it('strokeHitTest hits near the stroke and misses far away', () => {
    const s = mkStroke(linePts(0, 0, 100, 0));
    expect(strokeHitTest(s, 50, 2)).toBe(true);
    expect(strokeHitTest(s, 50, 40)).toBe(false);
  });

  it('strokeHitTest accounts for stroke width', () => {
    const thin = mkStroke(linePts(0, 0, 100, 0));
    thin.width = 2;
    const thick = mkStroke(linePts(0, 0, 100, 0));
    thick.width = 30;
    expect(strokeHitTest(thin, 50, 12, 0)).toBe(false);
    expect(strokeHitTest(thick, 50, 12, 0)).toBe(true);
  });

  it('pointInPolygon and strokesInLasso select by centroid', () => {
    const inside = mkStroke(linePts(10, 10, 20, 20));
    const outside = mkStroke(linePts(200, 200, 210, 210));
    const poly = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(pointInPolygon({ x: 50, y: 50 }, poly)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, poly)).toBe(false);
    expect(strokesInLasso([inside, outside], poly)).toEqual([inside.id]);
  });

  it('simplifyStroke keeps endpoints and drops collinear points', () => {
    const pts = linePts(0, 0, 100, 0, 50);
    const simple = simplifyStroke(pts, 1.5);
    expect(simple[0]).toEqual(pts[0]);
    expect(simple[simple.length - 1]).toEqual(pts[pts.length - 1]);
    expect(simple.length).toBeLessThan(pts.length);
  });

  it('resample returns exactly n points', () => {
    expect(resample(linePts(0, 0, 10, 10, 5), 32)).toHaveLength(32);
    expect(resample([{ x: 1, y: 1 }], 8)).toHaveLength(8);
  });
});

describe('recognizeInkShape', () => {
  it('recognizes a straight line', () => {
    const r = recognizeInkShape(mkStroke(linePts(10, 10, 200, 60)));
    expect(r?.kind).toBe('line');
    expect(r!.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes a circle', () => {
    const r = recognizeInkShape(mkStroke(circlePts(100, 100, 60)));
    expect(r?.kind).toBe('circle');
  });

  it('recognizes a rectangle', () => {
    const r = recognizeInkShape(mkStroke(rectPts(10, 10, 120, 80)));
    expect(r?.kind).toBe('rectangle');
  });

  it('recognizes a triangle', () => {
    const r = recognizeInkShape(mkStroke(trianglePts()));
    expect(r?.kind).toBe('triangle');
  });

  it('returns null for a wiggly open scribble', () => {
    const pts: InkPoint[] = [];
    for (let i = 0; i < 40; i++) pts.push({ x: i * 5, y: 50 + (i % 2 === 0 ? 30 : -30) });
    expect(recognizeInkShape(mkStroke(pts))).toBeNull();
  });

  it('returns null for tiny strokes', () => {
    expect(recognizeInkShape(mkStroke(linePts(0, 0, 3, 3)))).toBeNull();
  });
});

describe('recognizeInkChar', () => {
  it('recognizes template-drawn characters', () => {
    expect(recognizeInkChar(charStroke('0,1 0.5,0 1,1'))?.char).toBe('A');
    expect(recognizeInkChar(charStroke('0.1,0 0.9,0 0.4,1'))?.char).toBe('7');
    expect(recognizeInkChar(charStroke('0,0 0,1 0.9,1'))?.char).toBe('L');
  });

  it('recognizes digits', () => {
    const five = charStroke('0.9,0 0.2,0 0.15,0.45 0.6,0.5 0.9,0.7 0.8,1 0.2,1 0.1,0.8');
    expect(recognizeInkChar(five)?.char).toBe('5');
  });

  it('rejects far-off doodles', () => {
    const pts: InkPoint[] = [];
    for (let i = 0; i < 30; i++) pts.push({ x: i * 4, y: (i * 37) % 90 });
    expect(recognizeInkChar(mkStroke(pts))).toBeNull();
  });
});

describe('recognizeInkText', () => {
  it('joins per-stroke characters left to right', () => {
    const h = charStroke('0,0 0,1 0,0.5 1,0.5 1,0 1,1', 100);
    const i = charStroke('0.2,0 0.8,0 0.5,0 0.5,1 0.2,1 0.8,1', 100);
    // Shift the I stroke right so ordering is deterministic.
    i.points = i.points.map((p) => ({ x: p.x + 150, y: p.y }));
    const { text } = recognizeInkText([i, h]);
    expect(text).toBe('HI');
  });
});

describe('recognizeInkMath', () => {
  it('recognizes operators', () => {
    expect(recognizeInkMathSymbol(charStroke('0.5,0.1 0.5,0.9 0.5,0.5 0.1,0.5 0.9,0.5'))?.char).toBe('+');
    expect(recognizeInkMathSymbol(charStroke('0.1,0.5 0.9,0.5'))?.char).toBe('-');
  });

  it('builds an expression from strokes', () => {
    const one = charStroke('0.3,0.15 0.5,0 0.5,1 0.3,1 0.7,1', 100);
    const plus = charStroke('0.5,0.1 0.5,0.9 0.5,0.5 0.1,0.5 0.9,0.5', 100);
    plus.points = plus.points.map((p) => ({ x: p.x + 150, y: p.y }));
    const two = charStroke('0.1,0.15 0.5,0 0.9,0.15 0.9,0.4 0.1,1 0.9,1', 100);
    two.points = two.points.map((p) => ({ x: p.x + 300, y: p.y }));
    const { expression } = recognizeInkMath([one, plus, two]);
    expect(expression).toBe('1+2');
  });
});

describe('ink metadata persistence', () => {
  it('round-trips strokes through metadata', () => {
    const strokes = [mkStroke(linePts(0, 0, 10, 10), 'highlighter'), mkStroke(circlePts(5, 5, 3))];
    strokes[0].color = '#ffff00';
    const meta = inkStrokesToMetadata(strokes);
    const back = inkStrokesFromMetadata(meta);
    expect(back).toHaveLength(2);
    expect(back[0].tool).toBe('highlighter');
    expect(back[0].color).toBe('#ffff00');
    expect(back[0].points).toHaveLength(strokes[0].points.length);
  });

  it('returns [] for invalid metadata', () => {
    expect(inkStrokesFromMetadata(null)).toEqual([]);
    expect(inkStrokesFromMetadata({})).toEqual([]);
    expect(inkStrokesFromMetadata([{ points: [] }])).toEqual([]);
  });

  it('builds a per-sheet metadata key', () => {
    expect(inkMetadataKey('Sheet1')).toBe('icecream.ink.Sheet1');
  });
});
