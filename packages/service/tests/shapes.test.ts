import { describe, expect, it } from 'vitest';
import {
  SHAPE_CATEGORIES,
  SHAPE_COUNT,
  SHAPE_DEFS,
  isKnownShapeId,
  shapeDefById,
  shapesByCategory,
} from '../src/index.js';

describe('shape gallery', () => {
  it('has 100+ shapes across all 7 Excel categories', () => {
    expect(SHAPE_COUNT).toBeGreaterThanOrEqual(100);
    expect(SHAPE_DEFS.length).toBe(SHAPE_COUNT);
    expect(SHAPE_CATEGORIES.map((c) => c.id)).toEqual([
      'lines',
      'rectangles',
      'basic',
      'arrows',
      'flowchart',
      'stars',
      'callouts',
    ]);
    for (const c of SHAPE_CATEGORIES) {
      expect(shapesByCategory(c.id).length, `category ${c.id} is empty`).toBeGreaterThan(0);
    }
  });

  it('has unique ids and non-empty svg for every shape', () => {
    const ids = new Set(SHAPE_DEFS.map((d) => d.id));
    expect(ids.size).toBe(SHAPE_DEFS.length);
    for (const d of SHAPE_DEFS) {
      expect(d.name.trim().length, d.id).toBeGreaterThan(0);
      expect(d.svg.trim().length, d.id).toBeGreaterThan(0);
      expect(d.svg, `${d.id} must not contain scripts`).not.toMatch(/<script/i);
    }
  });

  it('keeps the 20 legacy gallery ids', () => {
    const legacy = [
      'rect', 'roundedRect', 'oval', 'line', 'arrow', 'doubleArrow', 'triangle',
      'rightTriangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star5',
      'heart', 'plus', 'chevron', 'trapezoid', 'parallelogram', 'blockArrow',
      'speechBubble',
    ];
    for (const id of legacy) {
      expect(isKnownShapeId(id), `legacy id ${id} missing`).toBe(true);
    }
  });

  it('shapeDefById round-trips and reports unknown ids', () => {
    expect(shapeDefById('flowDecision')?.name).toBe('Decision');
    expect(shapeDefById('nope')).toBeUndefined();
    expect(isKnownShapeId('nope')).toBe(false);
  });

  it('line-only shapes are marked and geometry stays in the 0–100 viewBox', () => {
    const lineOnly = SHAPE_DEFS.filter((d) => d.lineOnly);
    expect(lineOnly.length).toBeGreaterThan(0);
    const numRe = /-?\d+(\.\d+)?/g;
    for (const d of SHAPE_DEFS) {
      // Attribute coordinates (points, x/y/cx/cy/..., sizes) must sit in the viewBox.
      for (const m of d.svg.matchAll(/(?:points|x1|y1|x2|y2|x|y|cx|cy|r|rx|ry|width|height)="([^"]*)"/g)) {
        for (const n of m[1].match(numRe) ?? []) {
          const v = Number(n);
          expect(v, `${d.id}: ${v} out of range`).toBeGreaterThanOrEqual(-2);
          expect(v, `${d.id}: ${v} out of range`).toBeLessThanOrEqual(102);
        }
      }
      // Path data may use relative deltas; absolute coordinates stay in range.
      for (const m of d.svg.matchAll(/d="([^"]*)"/g)) {
        for (const n of m[1].match(numRe) ?? []) {
          const v = Number(n);
          expect(v, `${d.id}: path ${v} out of range`).toBeGreaterThanOrEqual(-105);
          expect(v, `${d.id}: path ${v} out of range`).toBeLessThanOrEqual(105);
        }
      }
    }
  });

  it('covers Excel headline shapes per category', () => {
    const byCat = (c: string) => new Set(shapesByCategory(c as never).map((d) => d.id));
    expect(byCat('flowchart')).toContain('flowDecision');
    expect(byCat('flowchart')).toContain('flowTerminator');
    expect(byCat('arrows')).toContain('circularArrow');
    expect(byCat('stars')).toContain('star24');
    expect(byCat('callouts')).toContain('cloudCallout');
    expect(byCat('basic')).toContain('smileyFace');
  });
});
