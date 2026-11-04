/**
 * Tests for the service metadata store: generic MetadataStore, chart specs,
 * pivot specs, and persistence adapters.
 */
import { describe, expect, it } from 'vitest';
import {
  MetadataStore,
  memoryPersistence,
  createChartStore,
  createPivotStore,
  serializeCharts,
  deserializeCharts,
  migrateChart,
  serializePivots,
  deserializePivots,
  CHART_SPEC_VERSION,
} from '../src/index.js';
import type { ChartSpec } from '../src/index.js';
import type { PivotSpec } from '../src/index.js';

function chart(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    version: CHART_SPEC_VERSION,
    id: 1,
    kind: 'column-clustered',
    title: 'Sales',
    range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
    xAxisTitle: '',
    yAxisTitle: '',
    legend: 'bottom',
    dataLabels: false,
    x: 120,
    y: 120,
    w: 480,
    h: 320,
    ...over,
  };
}

function pivot(): PivotSpec {
  return { version: 1, rows: ['Region'], columns: [], values: [{ field: 'Sales', aggregation: 'sum' }] };
}

describe('MetadataStore', () => {
  it('starts empty', () => {
    const s = new MetadataStore<ChartSpec>('k', memoryPersistence(), serializeCharts, deserializeCharts);
    expect(s.all()).toEqual([]);
  });

  it('add + all round-trips', () => {
    const s = new MetadataStore<ChartSpec>('k', memoryPersistence(), serializeCharts, deserializeCharts);
    s.add(chart({ id: 7 }));
    expect(s.all()).toHaveLength(1);
    expect(s.all()[0].id).toBe(7);
  });

  it('saveAll replaces', () => {
    const s = new MetadataStore<ChartSpec>('k', memoryPersistence(), serializeCharts, deserializeCharts);
    s.add(chart({ id: 1 }));
    s.saveAll([chart({ id: 2 }), chart({ id: 3 })]);
    expect(s.all().map((c) => c.id)).toEqual([2, 3]);
  });

  it('remove by predicate', () => {
    const s = new MetadataStore<ChartSpec>('k', memoryPersistence(), serializeCharts, deserializeCharts);
    s.saveAll([chart({ id: 1 }), chart({ id: 2 })]);
    expect(s.remove((c) => c.id === 1)).toBe(1);
    expect(s.all()).toHaveLength(1);
  });

  it('clear empties', () => {
    const s = new MetadataStore<ChartSpec>('k', memoryPersistence(), serializeCharts, deserializeCharts);
    s.add(chart());
    s.clear();
    expect(s.all()).toEqual([]);
  });

  it('persists across instances sharing the adapter', () => {
    const p = memoryPersistence();
    const a = new MetadataStore<ChartSpec>('k', p, serializeCharts, deserializeCharts);
    a.add(chart({ id: 9 }));
    const b = new MetadataStore<ChartSpec>('k', p, serializeCharts, deserializeCharts);
    expect(b.all()).toHaveLength(1);
  });

  it('invalidate forces re-read', () => {
    const p = memoryPersistence();
    const a = new MetadataStore<ChartSpec>('k', p, serializeCharts, deserializeCharts);
    a.add(chart({ id: 1 }));
    p.save('k', serializeCharts([chart({ id: 2 })]));
    expect(a.all()[0].id).toBe(1); // cached
    a.invalidate();
    expect(a.all()[0].id).toBe(2); // re-read
  });
});

describe('chart store', () => {
  it('createChartStore round-trips', () => {
    const s = createChartStore(memoryPersistence());
    s.add(chart({ title: 'Q1' }));
    expect(s.all()[0].title).toBe('Q1');
  });

  it('migrateChart fills defaults', () => {
    const m = migrateChart({ kind: 'pie' } as Partial<ChartSpec>);
    expect(m.version).toBe(CHART_SPEC_VERSION);
    expect(m.legend).toBe('bottom');
    expect(m.range.sheet).toBe('Sheet1');
    expect(m.w).toBe(480);
  });

  it('deserializeCharts rejects corrupt input', () => {
    expect(deserializeCharts('not json')).toEqual([]);
    expect(deserializeCharts('{"charts": 42}')).toEqual([]);
  });
});

describe('pivot store', () => {
  it('createPivotStore round-trips', () => {
    const s = createPivotStore(memoryPersistence());
    s.add(pivot());
    expect(s.all()).toHaveLength(1);
    expect(s.all()[0].rows).toEqual(['Region']);
  });

  it('deserializePivots rejects corrupt input', () => {
    expect(deserializePivots('nope')).toEqual([]);
    expect(deserializePivots('{"pivots": "x"}')).toEqual([]);
  });

  it('serializePivots includes version', () => {
    const json = serializePivots([pivot()]);
    expect(JSON.parse(json).version).toBe(1);
  });
});
