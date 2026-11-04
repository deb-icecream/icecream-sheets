/**
 * Tests for timelines (track 14): date parsing, granularity bucketing,
 * range filtering, presets, and extent scanning.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketKey,
  parseDateCell,
  timelinePasses,
  setTimelineRange,
  setTimelineGranularity,
  applyTimelinePreset,
  timelineExtent,
  TIMELINE_PRESETS,
  type TimelineSpec,
} from './timelines';

function spec(over: Partial<TimelineSpec> = {}): TimelineSpec {
  return {
    id: 1,
    col: 0,
    field: 'Date',
    start: new Date(2026, 2, 1),
    end: new Date(2026, 2, 31),
    granularity: 'days',
    x: 0,
    y: 0,
    w: 320,
    ...over,
  };
}

describe('parseDateCell', () => {
  it('parses ISO dates', () => {
    const d = parseDateCell('2026-03-14');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(2);
    expect(d!.getDate()).toBe(14);
  });

  it('parses locale date strings', () => {
    expect(parseDateCell('3/14/2026')).not.toBeNull();
    expect(parseDateCell('March 14, 2026')).not.toBeNull();
  });

  it('parses Excel serial day numbers', () => {
    // 46000 ≈ 2025-12-05
    const d = parseDateCell('46000');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2025);
  });

  it('rejects non-dates', () => {
    expect(parseDateCell('')).toBeNull();
    expect(parseDateCell('hello')).toBeNull();
    expect(parseDateCell('12')).toBeNull(); // too small for a serial
  });
});

describe('bucketKey', () => {
  const d = new Date(2026, 2, 14); // March 14, 2026
  it('days: distinct days differ', () => {
    expect(bucketKey(d, 'days')).not.toBe(bucketKey(new Date(2026, 2, 15), 'days'));
  });
  it('months: same month buckets together', () => {
    expect(bucketKey(d, 'months')).toBe(bucketKey(new Date(2026, 2, 1), 'months'));
    expect(bucketKey(d, 'months')).not.toBe(bucketKey(new Date(2026, 3, 1), 'months'));
  });
  it('quarters: Jan/Feb/Mar share a bucket', () => {
    expect(bucketKey(d, 'quarters')).toBe(bucketKey(new Date(2026, 0, 5), 'quarters'));
    expect(bucketKey(d, 'quarters')).not.toBe(bucketKey(new Date(2026, 3, 1), 'quarters'));
  });
  it('years: same year buckets together', () => {
    expect(bucketKey(d, 'years')).toBe(bucketKey(new Date(2026, 11, 31), 'years'));
    expect(bucketKey(d, 'years')).not.toBe(bucketKey(new Date(2027, 0, 1), 'years'));
  });
});

describe('timelinePasses', () => {
  it('days: inclusive range', () => {
    const s = spec();
    expect(timelinePasses('2026-03-01', s)).toBe(true);
    expect(timelinePasses('2026-03-31', s)).toBe(true);
    expect(timelinePasses('2026-04-01', s)).toBe(false);
    expect(timelinePasses('2026-02-28', s)).toBe(false);
  });

  it('months: whole months kept by bucketing', () => {
    const s = spec({ granularity: 'months' });
    expect(timelinePasses('2026-03-14', s)).toBe(true);
    expect(timelinePasses('2026-03-31', s)).toBe(true);
    expect(timelinePasses('2026-04-02', s)).toBe(false);
  });

  it('quarters: range spanning Q1 keeps all of Q1', () => {
    const s = spec({
      start: new Date(2026, 0, 15),
      end: new Date(2026, 1, 10),
      granularity: 'quarters',
    });
    expect(timelinePasses('2026-03-30', s)).toBe(true); // still Q1
    expect(timelinePasses('2026-04-01', s)).toBe(false); // Q2
  });

  it('years: buckets by year', () => {
    const s = spec({ start: new Date(2026, 5, 1), end: new Date(2026, 5, 30), granularity: 'years' });
    expect(timelinePasses('2026-01-01', s)).toBe(true);
    expect(timelinePasses('2027-01-01', s)).toBe(false);
  });

  it('non-dates never pass', () => {
    expect(timelinePasses('n/a', spec())).toBe(false);
    expect(timelinePasses('', spec())).toBe(false);
  });
});

describe('setTimelineRange / setTimelineGranularity', () => {
  it('swaps inverted bounds', () => {
    const s = setTimelineRange(spec(), new Date(2026, 5, 1), new Date(2026, 0, 1));
    expect(s.start.getMonth()).toBe(0);
    expect(s.end.getMonth()).toBe(5);
  });

  it('setTimelineGranularity keeps the range', () => {
    const s = setTimelineGranularity(spec(), 'years');
    expect(s.granularity).toBe('years');
    expect(s.start.getMonth()).toBe(2);
  });
});

describe('presets', () => {
  const now = new Date(2026, 9, 18); // Oct 18, 2026

  it('Last 30 days spans 29 days back', () => {
    const s = applyTimelinePreset(spec(), 'last-30-days', now);
    expect(s.start).toEqual(new Date(2026, 8, 19));
    expect(s.end).toEqual(new Date(2026, 9, 18));
  });

  it('This quarter starts at the quarter boundary', () => {
    const s = applyTimelinePreset(spec(), 'this-quarter', now);
    expect(s.start).toEqual(new Date(2026, 9, 1)); // Q4 starts Oct 1
    expect(s.end).toEqual(new Date(2026, 9, 18));
  });

  it('YTD starts Jan 1', () => {
    const s = applyTimelinePreset(spec(), 'ytd', now);
    expect(s.start).toEqual(new Date(2026, 0, 1));
    expect(s.end).toEqual(new Date(2026, 9, 18));
  });

  it('unknown preset leaves the spec unchanged', () => {
    const s0 = spec();
    expect(applyTimelinePreset(s0, 'nope', now)).toBe(s0);
  });

  it('exports the expected preset labels', () => {
    expect(TIMELINE_PRESETS.map((p) => p.label)).toContain('Last 30 days');
    expect(TIMELINE_PRESETS.map((p) => p.label)).toContain('This quarter');
    expect(TIMELINE_PRESETS.map((p) => p.label)).toContain('YTD');
  });
});

describe('timelineExtent', () => {
  it('finds min/max dates, skipping non-dates', () => {
    const cells = ['2026-01-05', 'n/a', '2026-03-20', '', '2026-02-10'];
    const ext = timelineExtent(0, cells.length, (r) => cells[r]);
    expect(ext).not.toBeNull();
    expect(ext!.min.getDate()).toBe(5);
    expect(ext!.max.getMonth()).toBe(2);
  });

  it('returns null when no dates exist', () => {
    expect(timelineExtent(0, 3, () => 'x')).toBeNull();
  });
});
