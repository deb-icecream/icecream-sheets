/**
 * Timelines (track 14: sparklines-slicers-timelines).
 *
 * A timeline is a visual DATE filter for tables/pivots — the companion to
 * slicers (which filter on categorical values). It binds to a date column
 * and keeps only rows whose date bucket falls inside [start, end].
 *
 * Granularity buckets dates before comparing, so a 'months' timeline keeps
 * whole months: a row on 2026-03-14 passes a timeline of 2026-03-01..2026-03-31
 * because both bucket to 2026-03.
 */

export type TimelineGranularity = 'days' | 'months' | 'quarters' | 'years';

export interface TimelineSpec {
  id: number;
  /** Column index the timeline filters. */
  col: number;
  /** Header label shown on the timeline. */
  field: string;
  /** Inclusive range bounds (dates; time-of-day ignored). */
  start: Date;
  end: Date;
  granularity: TimelineGranularity;
  x: number;
  y: number;
  w: number;
}

export const TIMELINE_GRANULARITIES: TimelineGranularity[] = ['days', 'months', 'quarters', 'years'];

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * Parse a cell text into a Date. Handles ISO/local date strings and Excel
 * serial day numbers (a bare number in the plausible 20000–80000 range).
 * Returns null when the text is not a date.
 */
export function parseDateCell(text: string): Date | null {
  const t = text.trim();
  if (t === '') return null;
  // A bare integer is only a date when it is an Excel serial day number;
  // e.g. "12" must not parse as December 2001.
  if (/^\d+$/.test(t)) {
    const serial = Number(t);
    if (Number.isInteger(serial) && serial >= 20000 && serial <= 80000) {
      // A serial names a calendar day; return it as that LOCAL calendar
      // day (a raw UTC-midnight instant is the previous local day west
      // of UTC, and every consumer here reads local calendar fields).
      const utc = new Date(EXCEL_EPOCH_MS + serial * 86_400_000);
      return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }
    return null;
  }
  // A date-only ISO string also names a calendar day, not an instant:
  // Date.parse would read '2026-03-14' as UTC midnight — March 13 local
  // in Los Angeles. Parse it as the local calendar day it names.
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (isoDay) {
    const y = Number(isoDay[1]);
    const m = Number(isoDay[2]);
    const d = Number(isoDay[3]);
    const local = new Date(y, m - 1, d);
    // Reject overflow dates (e.g. 2026-02-30) instead of rolling over.
    if (local.getFullYear() !== y || local.getMonth() !== m - 1 || local.getDate() !== d) return null;
    return local;
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/** Monotonic bucket key: days → day count, months → y*12+m, quarters → y*4+q, years → y. */
export function bucketKey(date: Date, granularity: TimelineGranularity): number {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  switch (granularity) {
    case 'days':
      return Math.floor(Date.UTC(y, m, d) / 86_400_000);
    case 'months':
      return y * 12 + m;
    case 'quarters':
      return y * 4 + Math.floor(m / 3);
    case 'years':
      return y;
  }
}

/** True when the cell text parses as a date whose bucket lies inside the timeline range. */
export function timelinePasses(cellText: string, spec: TimelineSpec): boolean {
  const date = parseDateCell(cellText);
  if (!date) return false;
  const b = bucketKey(date, spec.granularity);
  return b >= bucketKey(spec.start, spec.granularity) && b <= bucketKey(spec.end, spec.granularity);
}

/** Set the range; swaps when start > end so the invariant start <= end holds. */
export function setTimelineRange(spec: TimelineSpec, start: Date, end: Date): TimelineSpec {
  const s = new Date(start);
  const e = new Date(end);
  return { ...spec, start: s <= e ? s : e, end: s <= e ? e : s };
}

/** Set granularity (range bounds are unchanged; bucketing adapts). */
export function setTimelineGranularity(spec: TimelineSpec, granularity: TimelineGranularity): TimelineSpec {
  return { ...spec, granularity };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface TimelinePreset {
  id: string;
  label: string;
  range: (now: Date) => { start: Date; end: Date };
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export const TIMELINE_PRESETS: TimelinePreset[] = [
  {
    id: 'last-30-days',
    label: 'Last 30 days',
    range: (now) => {
      const end = startOfDay(now);
      const start = new Date(end);
      start.setDate(start.getDate() - 29);
      return { start, end };
    },
  },
  {
    id: 'this-quarter',
    label: 'This quarter',
    range: (now) => {
      const q = Math.floor(now.getMonth() / 3);
      return { start: new Date(now.getFullYear(), q * 3, 1), end: startOfDay(now) };
    },
  },
  {
    id: 'ytd',
    label: 'YTD',
    range: (now) => ({ start: new Date(now.getFullYear(), 0, 1), end: startOfDay(now) }),
  },
  {
    id: 'last-12-months',
    label: 'Last 12 months',
    range: (now) => {
      const end = startOfDay(now);
      const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
      return { start, end };
    },
  },
];

/** Apply a preset to a spec (returns a new spec). */
export function applyTimelinePreset(spec: TimelineSpec, presetId: string, now = new Date()): TimelineSpec {
  const preset = TIMELINE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return spec;
  const { start, end } = preset.range(now);
  return setTimelineRange(spec, start, end);
}

// ---------------------------------------------------------------------------
// Extent scanning (for the brush UI)
// ---------------------------------------------------------------------------

/** Min/max dates found in a date column; null when the column has no dates. */
export function timelineExtent(
  col: number,
  rowCount: number,
  readCell: (row: number, col: number) => string,
): { min: Date; max: Date } | null {
  let min: number | null = null;
  let max: number | null = null;
  for (let r = 0; r < rowCount; r++) {
    const d = parseDateCell(readCell(r, col));
    if (!d) continue;
    const t = d.getTime();
    if (min === null || t < min) min = t;
    if (max === null || t > max) max = t;
  }
  if (min === null || max === null) return null;
  return { min: new Date(min), max: new Date(max) };
}

/** Format a date for the timeline UI (YYYY-MM-DD). */
export function formatTimelineDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
