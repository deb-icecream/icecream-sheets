/**
 * Heatmap matrix visual tests (RESOLVED 2026-10-18):
 * color-scaled matrix with row/col labels, sequential + diverging scales,
 * correlationHeatmap for the data-analysis use case, spec round-trip.
 */
import { describe, expect, it } from 'vitest';
import {
  HEATMAP_NO_DATA_COLOR,
  buildHeatmap,
  correlationHeatmap,
  heatmapFromRecords,
  makeHeatmapSpec,
  migrateVisual,
  type HeatmapSpec,
} from '../src/index.js';

const SIMPLE: HeatmapSpec = makeHeatmapSpec({
  rowLabels: ['a', 'b'],
  colLabels: ['x', 'y'],
  values: [
    [1, 2],
    [3, 4],
  ],
});

describe('buildHeatmap', () => {
  it('colors cells on a sequential scale', () => {
    const built = buildHeatmap(SIMPLE);
    expect(built.min).toBe(1);
    expect(built.max).toBe(4);
    expect(built.cells).toHaveLength(4);
    const byValue = new Map(built.cells.map((c) => [c.value, c.color]));
    // Min and max get the scale extremes.
    expect(byValue.get(1)).toBe('#dbeafe');
    expect(byValue.get(4)).toBe('#1e40af');
    for (const c of built.cells) {
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('renders nulls with the no-data color', () => {
    const built = buildHeatmap(
      makeHeatmapSpec({ rowLabels: ['a'], colLabels: ['x', 'y'], values: [[1, null]] }),
    );
    const nullCell = built.cells.find((c) => c.value === null);
    expect(nullCell?.color).toBe(HEATMAP_NO_DATA_COLOR);
  });

  it('supports diverging scales centered at 0', () => {
    const spec = makeHeatmapSpec({
      rowLabels: ['a', 'b'],
      colLabels: ['x', 'y'],
      values: [
        [-1, 0],
        [0.5, 1],
      ],
      lowColor: '#1e40af',
      midColor: '#ffffff',
      highColor: '#b91c1c',
      center: 0,
    });
    const built = buildHeatmap(spec);
    const byValue = new Map(built.cells.map((c) => [c.value, c.color]));
    expect(byValue.get(-1)).toBe('#1e40af');
    expect(byValue.get(1)).toBe('#b91c1c');
    expect(byValue.get(0)).toBe('#ffffff');
  });

  it('handles empty matrices without errors', () => {
    const built = buildHeatmap(makeHeatmapSpec({}));
    expect(built.cells).toHaveLength(0);
    expect(built.min).toBe(0);
    expect(built.max).toBe(0);
  });
});

describe('heatmapFromRecords', () => {
  it('pivots records into a labeled matrix', () => {
    const records = [
      { region: 'east', product: 'bikes', sales: 100 },
      { region: 'east', product: 'cars', sales: 200 },
      { region: 'west', product: 'bikes', sales: 150 },
    ];
    const spec = heatmapFromRecords(records, 'region', 'product', 'sales');
    expect(spec.rowLabels).toEqual(['east', 'west']);
    expect(spec.colLabels).toEqual(['bikes', 'cars']);
    expect(spec.values).toEqual([
      [100, 200],
      [150, null],
    ]);
    const built = buildHeatmap(spec);
    expect(built.cells).toHaveLength(4);
  });

  it('averages duplicate cells', () => {
    const records = [
      { r: 'a', c: 'x', v: 10 },
      { r: 'a', c: 'x', v: 20 },
    ];
    const spec = heatmapFromRecords(records, 'r', 'c', 'v');
    expect(spec.values).toEqual([[15]]);
  });
});

describe('correlationHeatmap', () => {
  it('produces a 1.0 diagonal and symmetric matrix', () => {
    const records = [
      { a: 1, b: 2, c: 5 },
      { a: 2, b: 4, c: 4 },
      { a: 3, b: 6, c: 3 },
      { a: 4, b: 8, c: 2 },
    ];
    const spec = correlationHeatmap(records, ['a', 'b', 'c']);
    expect(spec.rowLabels).toEqual(['a', 'b', 'c']);
    // Perfect correlations: a/b = 1, a/c = -1.
    expect(spec.values[0]?.[0]).toBeCloseTo(1, 5);
    expect(spec.values[0]?.[1]).toBeCloseTo(1, 5);
    expect(spec.values[0]?.[2]).toBeCloseTo(-1, 5);
    // Symmetric.
    expect(spec.values[1]?.[0]).toBeCloseTo(spec.values[0]?.[1] ?? 0, 5);
    // Diverging scale centered at 0.
    expect(spec.midColor).toBe('#ffffff');
    expect(spec.center).toBe(0);
    const built = buildHeatmap(spec);
    const diag = built.cells.find((c) => c.row === 0 && c.col === 0);
    expect(diag?.color).toBe('#b91c1c'); // +1 → high extreme
  });
});

describe('heatmap as a report visual', () => {
  it('migrates a heatmap visual with defaults', () => {
    const v = migrateVisual({ kind: 'heatmap', heatmap: { rowLabels: ['a'], colLabels: ['x'], values: [[5]] } });
    expect(v.kind).toBe('heatmap');
    if (v.kind === 'heatmap') {
      expect(v.heatmap.version).toBe(1);
      const built = buildHeatmap(v.heatmap);
      expect(built.cells).toHaveLength(1);
    }
  });
});
