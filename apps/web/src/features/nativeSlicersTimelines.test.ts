// @vitest-environment jsdom
/**
 * Tests for the native slicer/timeline import mapping (issue #69 item 1).
 * Fixtures mirror the adapter's synthetic package (slicers-timelines.test.ts):
 * a tabular cache, a table cache, an OLAP cache, and a timeline cache
 * with selection + bounds, each with a per-sheet view.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  applyTimelineSelectionsToModel,
  dateFromIsoDateTime,
  nativeSlicersTimelinesToSpecs,
  parseNativeSlicersTimelines,
  rangeRefStartCol,
  type NativeSlicersTimelinesModel,
} from './nativeSlicersTimelines';
import type { TimelineSpec } from './timelines';
import { SlicerPanel } from '../components/Slicer';
import { TimelinePanel } from '../components/Timeline';

const model = (): NativeSlicersTimelinesModel => ({
  slicerCaches: [
    {
      name: 'Slicer_Region',
      sourceName: 'Region',
      pivotTables: [{ tabId: 2, name: 'PivotTable1' }],
      data: {
        kind: 'tabular',
        pivotCacheId: 0,
        items: [{ index: 0 }, { index: 2, selected: true }],
      },
    },
    { name: 'Slicer_Type', sourceName: 'Type', data: { kind: 'table', tableId: 7, column: 2 } },
    { name: 'Slicer_Year', sourceName: '[tblCal].[Year]', data: { kind: 'olap' } },
    { name: 'Slicer_Orphan', sourceName: 'Nope', data: { kind: 'table', tableId: 99, column: 0 } },
  ],
  sheetSlicers: [
    {
      sheetName: 'Dashboard',
      slicers: [
        { name: 'slcRegion', cache: 'Slicer_Region', caption: 'Region Filter' },
        { name: 'slcType', cache: 'Slicer_Type', caption: 'Type' },
        { name: 'slcYear', cache: 'Slicer_Year', caption: 'Year' },
        { name: 'slcGhost', cache: 'Slicer_Missing', caption: 'Ghost' },
        { name: 'slcOrphan', cache: 'Slicer_Orphan', caption: 'Orphan' },
      ],
    },
  ],
  timelineCaches: [
    {
      name: 'Timeline_OrderDate',
      sourceName: 'OrderDate',
      state: {
        pivotCacheId: 1,
        selection: { startDate: '2023-03-01T00:00:00', endDate: '2023-06-30T00:00:00' },
        bounds: { startDate: '2023-01-01T00:00:00', endDate: '2023-12-31T00:00:00' },
      },
    },
  ],
  sheetTimelines: [
    {
      sheetName: 'Dashboard',
      timelines: [{ name: 'tlOrderDate', cache: 'Timeline_OrderDate', caption: 'Order Date', level: 'months', selectionLevel: 'months' }],
    },
  ],
});

const pivots = [
  { cacheId: 0, fieldNames: ['Region', 'Sales'], source: { kind: 'worksheet', sheet: 'Data', ref: 'A1:B100' } },
  { cacheId: 1, fieldNames: ['OrderDate', 'Amount'], source: { kind: 'worksheet', sheet: 'Data', ref: 'A1:B100' } },
];
const tables = [{ id: 7, sheet: 'Data', startCol: 1, columns: ['A', 'B', 'Type'] }];

describe('parseNativeSlicersTimelines', () => {
  it('parses a JSON string and an already-parsed object', () => {
    expect(parseNativeSlicersTimelines(JSON.stringify(model()))?.slicerCaches).toHaveLength(4);
    expect(parseNativeSlicersTimelines(model())?.timelineCaches).toHaveLength(1);
  });
  it('returns null for missing, malformed, or structurally unusable values', () => {
    expect(parseNativeSlicersTimelines(undefined)).toBeNull();
    expect(parseNativeSlicersTimelines('not json')).toBeNull();
    expect(parseNativeSlicersTimelines({ nope: true })).toBeNull();
    expect(parseNativeSlicersTimelines(42)).toBeNull();
  });
});

describe('nativeSlicersTimelinesToSpecs', () => {
  it('maps the table slicer through the TableDef (startCol + column)', () => {
    const r = nativeSlicersTimelinesToSpecs(model(), { pivots, tables, idBase: 100 });
    const t = r.slicers.find((s) => s.spec.nativeView === 'slcType');
    expect(t).toBeDefined();
    expect(t!.spec.col).toBe(3);
    expect(t!.spec.field).toBe('Type');
    expect(t!.spec.sheet).toBe('Dashboard');
    expect(t!.spec.nativeCache).toBe('Slicer_Type');
    expect(t!.spec.selected).toEqual([]);
    expect(t!.selectionRestored).toBe(false);
    expect(t!.spec.x).toBe(32 + 48); // second rendered slicer (tabular first)
  });

  it('maps the tabular slicer through the pivot source range + field name', () => {
    const r = nativeSlicersTimelinesToSpecs(model(), { pivots, tables, idBase: 100 });
    const s = r.slicers.find((x) => x.spec.nativeView === 'slcRegion');
    expect(s).toBeDefined();
    expect(s!.spec.col).toBe(0);
    expect(s!.spec.field).toBe('Region Filter'); // view caption wins over sourceName
    expect(s!.pivotNames).toEqual(['PivotTable1']);
    expect(s!.spec.pivotIds).toEqual([]); // caller resolves names -> app ids
    // Tabular cache indices are NOT mapped to value strings (no shared
    // items in the model): the panel starts at select-all, honestly.
    expect(s!.spec.selected).toEqual([]);
    expect(s!.selectionRestored).toBe(false);
  });

  it('reports OLAP slicers, ghost views, and viewless caches as unresolved (never dropped silently)', () => {
    const r = nativeSlicersTimelinesToSpecs(model(), { pivots, tables, idBase: 100 });
    const byView = new Map(r.unresolved.map((u) => [u.view || u.cache, u]));
    expect(byView.get('slcYear')?.reason).toMatch(/OLAP/);
    expect(byView.get('slcGhost')?.reason).toMatch(/no slicer cache/);
    expect(byView.get('slcOrphan')?.reason).toMatch(/tableId 99/);
    expect(r.slicers).toHaveLength(2);
  });

  it('maps the timeline from selection (not bounds) with view granularity', () => {
    const r = nativeSlicersTimelinesToSpecs(model(), { pivots, tables, idBase: 100 });
    expect(r.timelines).toHaveLength(1);
    const t = r.timelines[0]!.spec;
    expect(t.col).toBe(0);
    expect(t.field).toBe('Order Date');
    expect(t.start).toEqual(new Date(2023, 2, 1));
    expect(t.end).toEqual(new Date(2023, 5, 30));
    expect(t.granularity).toBe('months');
    expect(t.nativeCache).toBe('Timeline_OrderDate');
  });

  it('falls back to bounds when there is no selection, and to months granularity when no level is set', () => {
    const m = model();
    const cache = m.timelineCaches![0]!;
    cache.state = { pivotCacheId: 1, bounds: { startDate: '2023-01-01T00:00:00', endDate: '2023-12-31T00:00:00' } };
    m.sheetTimelines![0]!.timelines[0]!.level = undefined;
    m.sheetTimelines![0]!.timelines[0]!.selectionLevel = undefined;
    const r = nativeSlicersTimelinesToSpecs(m, { pivots, tables, idBase: 1 });
    expect(r.timelines[0]!.spec.start).toEqual(new Date(2023, 0, 1));
    expect(r.timelines[0]!.spec.end).toEqual(new Date(2023, 11, 31));
    expect(r.timelines[0]!.spec.granularity).toBe('months');
  });

  it('uses selectionLevel when level is absent', () => {
    const m = model();
    m.sheetTimelines![0]!.timelines[0]!.level = undefined;
    m.sheetTimelines![0]!.timelines[0]!.selectionLevel = 'quarters';
    const r = nativeSlicersTimelinesToSpecs(m, { pivots, tables, idBase: 1 });
    expect(r.timelines[0]!.spec.granularity).toBe('quarters');
  });

  it('reports a timeline whose pivot source is missing as unresolved', () => {
    const r = nativeSlicersTimelinesToSpecs(model(), { pivots: [], tables, idBase: 1 });
    expect(r.timelines).toHaveLength(0);
    expect(r.unresolved.some((u) => u.kind === 'timeline' && u.view === 'tlOrderDate')).toBe(true);
  });

  it('returns empty results for unparsable metadata', () => {
    expect(nativeSlicersTimelinesToSpecs('garbage', {})).toEqual({ slicers: [], timelines: [], unresolved: [] });
  });
});

describe('helpers', () => {
  it('rangeRefStartCol handles $ and bare refs', () => {
    expect(rangeRefStartCol('$B$2:$F$100')).toBe(1);
    expect(rangeRefStartCol('A1:B100')).toBe(0);
    expect(rangeRefStartCol('bogus')).toBeNull();
    expect(rangeRefStartCol(undefined)).toBeNull();
  });
  it('dateFromIsoDateTime reads the local calendar day and rejects overflow', () => {
    expect(dateFromIsoDateTime('2023-03-01T00:00:00')).toEqual(new Date(2023, 2, 1));
    expect(dateFromIsoDateTime('2023-02-30T00:00:00')).toBeNull();
    expect(dateFromIsoDateTime('junk')).toBeNull();
  });
});

describe('applyTimelineSelectionsToModel', () => {
  it('updates only the matched timeline cache selection, preserving everything else', () => {
    const spec: TimelineSpec = {
      id: 7, col: 0, field: 'Order Date',
      start: new Date(2024, 0, 15), end: new Date(2024, 2, 20),
      granularity: 'months', x: 0, y: 0, w: 300,
      nativeCache: 'Timeline_OrderDate',
    };
    const out = applyTimelineSelectionsToModel(JSON.stringify(model()), [spec]);
    expect(out).not.toBeNull();
    const back = parseNativeSlicersTimelines(out)!;
    const cache = back.timelineCaches![0]!;
    expect(cache.state!.selection).toEqual({ startDate: '2024-01-15T00:00:00', endDate: '2024-03-20T00:00:00' });
    expect(cache.state!.bounds).toEqual({ startDate: '2023-01-01T00:00:00', endDate: '2023-12-31T00:00:00' });
    expect(back.slicerCaches).toHaveLength(4); // slicer side untouched
  });
  it('ignores specs without a nativeCache and returns null for bad input', () => {
    const spec: TimelineSpec = {
      id: 1, col: 0, field: 'X', start: new Date(2024, 0, 1), end: new Date(2024, 0, 2),
      granularity: 'days', x: 0, y: 0, w: 300,
    };
    const out = applyTimelineSelectionsToModel(JSON.stringify(model()), [spec]);
    expect(JSON.parse(out!) as NativeSlicersTimelinesModel).toEqual(model());
    expect(applyTimelineSelectionsToModel('junk', [spec])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mapped specs feed the existing panels unchanged.
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe('mapped specs render in the existing panels', () => {
  it('renders the mapped table slicer in SlicerPanel', () => {
    const r = nativeSlicersTimelinesToSpecs(model(), { pivots, tables, idBase: 100 });
    const spec = r.slicers.find((s) => s.spec.nativeView === 'slcType')!.spec;
    const el = setup(h(SlicerPanel, {
      spec, values: ['A', 'B', 'Type'],
      pivots: [], onToggle: vi.fn(), onClear: vi.fn(), onRemove: vi.fn(), onTogglePivotBinding: vi.fn(),
    }));
    expect(el.textContent).toContain('Type');
  });

  it('renders the mapped timeline in TimelinePanel', () => {
    const r = nativeSlicersTimelinesToSpecs(model(), { pivots, tables, idBase: 100 });
    const spec = r.timelines[0]!.spec;
    const el = setup(h(TimelinePanel, {
      spec,
      extent: { min: new Date(2023, 0, 1), max: new Date(2023, 11, 31) },
      onChange: vi.fn(), onRemove: vi.fn(),
    }));
    expect(el.textContent).toContain('Order Date');
    expect(el.textContent).toContain('2023-03-01');
    expect(el.textContent).toContain('2023-06-30');
  });
});

describe('OLAP slicer mapping (#114)', () => {
  const olapModel = (): NativeSlicersTimelinesModel => ({
    slicerCaches: [
      {
        name: 'Slicer_Year',
        sourceName: '[tblCal].[Year]',
        pivotTables: [
          { tabId: 16, name: 'pvtEarnings' },
          { tabId: 16, name: 'pvtCF' },
          { tabId: 5, name: 'pvtCF' },
        ],
        data: {
          kind: 'olap',
          pivotCacheId: 219062112,
          levels: [
            { uniqueName: '[tblCal].[Year].[(All)]', sourceCaption: '(All)', ranges: [] },
            {
              uniqueName: '[tblCal].[Year].[Year]',
              sourceCaption: 'Year',
              ranges: [
                {
                  items: [
                    { name: '[tblCal].[Year].&[2012]', caption: '2012' },
                    { name: '[tblCal].[Year].&[2013]', caption: '2013' },
                    { name: '[tblCal].[Year].&[2021]' },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    sheetSlicers: [
      { sheetName: 'Dashboard', slicers: [{ name: 'slcYear', cache: 'Slicer_Year', caption: 'Year' }] },
    ],
  });

  it('maps an OLAP slicer to a col -1 spec with dimension binding, pivot refs, and members', () => {
    const r = nativeSlicersTimelinesToSpecs(olapModel(), { idBase: 500 });
    expect(r.unresolved).toEqual([]);
    expect(r.slicers).toHaveLength(1);
    const item = r.slicers[0]!;
    expect(item.spec.col).toBe(-1);
    expect(item.spec.field).toBe('Year');
    expect(item.spec.sheet).toBe('Dashboard');
    expect(item.spec.olap).toEqual({ table: 'tblCal', column: 'Year', cacheName: 'Slicer_Year' });
    // Pivot refs carry tabId + name (sheet-qualified; the two pvtCF
    // refs must NOT collapse into one name).
    expect(item.pivotRefs).toEqual([
      { tabId: 16, name: 'pvtEarnings' },
      { tabId: 16, name: 'pvtCF' },
      { tabId: 5, name: 'pvtCF' },
    ]);
    expect(item.pivotNames).toEqual(['pvtEarnings', 'pvtCF', 'pvtCF']);
    // Members: captions win; a caption-less item falls back to the
    // trailing member of its unique name; the (All) level is skipped.
    expect(item.members).toEqual(['2012', '2013', '2021']);
  });

  it('reports an OLAP slicer with an unparsable dimension as unresolved', () => {
    const m = olapModel();
    (m.slicerCaches![0] as { sourceName?: string }).sourceName = 'Year';
    const r = nativeSlicersTimelinesToSpecs(m, { idBase: 500 });
    expect(r.slicers).toHaveLength(0);
    expect(r.unresolved[0]?.reason).toMatch(/unparsable dimension/);
  });
});
