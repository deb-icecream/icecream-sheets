/**
 * Time-to-first-page instrumentation (Cycle 10 Phase 4).
 *
 * DEFINITION (user's metric): time from FILE SELECTED → the first sheet's
 * visible window painted with REAL cell values, in gateway mode. It is a
 * different story from total wall time (a P95 open may take ~50s total
 * while first page lands in seconds) and perf-evaluation.md reports both
 * per fixture.
 *
 * Marks (Performance API, also mirrored on `window.__icecreamFirstPage`
 * so the Phase 4 harness / headless driver can read them without a
 * console round-trip):
 *   icecream:file-selected        — open flow starts (App open handlers)
 *   icecream:first-values-arrived — first viewport values for sheet 1
 *                                   land in the read-through cache
 *   icecream:first-page-painted  — that window has been painted (the
 *                                   host's repaint tick fired after the
 *                                   values arrived; Grid renders from
 *                                   the same tick)
 *   measure icecream:time-to-first-page = selected → painted.
 */
export const MARK_FILE_SELECTED = 'icecream:file-selected';
export const MARK_FIRST_VALUES = 'icecream:first-values-arrived';
export const MARK_FIRST_PAGE_PAINTED = 'icecream:first-page-painted';
export const MEASURE_TIME_TO_FIRST_PAGE = 'icecream:time-to-first-page';

export interface FirstPageReport {
  fileSelectedAt: number | null;
  firstValuesAt: number | null;
  firstPagePaintedAt: number | null;
  /** selected → painted, ms; null until painted. */
  timeToFirstPageMs: number | null;
  /** selected → first values, ms (paint-excluded lower bound). */
  timeToFirstValuesMs: number | null;
}

interface FirstPageWindow {
  __icecreamFirstPage?: FirstPageReport;
}

const state: FirstPageReport = {
  fileSelectedAt: null,
  firstValuesAt: null,
  firstPagePaintedAt: null,
  timeToFirstPageMs: null,
  timeToFirstValuesMs: null,
};

function now(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // Performance marks are best-effort instrumentation, never load-bearing.
  }
}

function publish(): void {
  state.timeToFirstValuesMs =
    state.fileSelectedAt !== null && state.firstValuesAt !== null
      ? state.firstValuesAt - state.fileSelectedAt
      : null;
  state.timeToFirstPageMs =
    state.fileSelectedAt !== null && state.firstPagePaintedAt !== null
      ? state.firstPagePaintedAt - state.fileSelectedAt
      : null;
  try {
    (window as unknown as FirstPageWindow).__icecreamFirstPage = { ...state };
  } catch {
    // Non-browser test environments: the marks above still apply.
  }
}

/** Open flow begins: reset the report and stamp file-selected. */
export function markFileSelected(): void {
  state.fileSelectedAt = now();
  state.firstValuesAt = null;
  state.firstPagePaintedAt = null;
  try {
    performance.clearMarks(MARK_FIRST_VALUES);
    performance.clearMarks(MARK_FIRST_PAGE_PAINTED);
    performance.clearMeasures(MEASURE_TIME_TO_FIRST_PAGE);
  } catch {
    // ignore
  }
  mark(MARK_FILE_SELECTED);
  publish();
}

/** First real viewport values for the first sheet reached the cache. */
export function markFirstValuesArrived(): void {
  if (state.fileSelectedAt === null || state.firstValuesAt !== null) return;
  state.firstValuesAt = now();
  mark(MARK_FIRST_VALUES);
  publish();
}

/**
 * The values-arrived window has been painted (host repaint tick). When
 * the Performance measure can be created it is, so devtools / the Phase 4
 * harness can read `performance.getEntriesByName('icecream:time-to-first-page')`.
 */
export function markFirstPagePainted(): void {
  if (state.fileSelectedAt === null || state.firstPagePaintedAt !== null) return;
  markFirstValuesArrived();
  state.firstPagePaintedAt = now();
  mark(MARK_FIRST_PAGE_PAINTED);
  try {
    performance.measure(MEASURE_TIME_TO_FIRST_PAGE, MARK_FILE_SELECTED, MARK_FIRST_PAGE_PAINTED);
  } catch {
    // Marks may have been cleared by a subsequent open; the numeric
    // report below remains authoritative.
  }
  publish();
}

/** The current time-to-first-page report (Phase 4 reads this). */
export function getFirstPageReport(): FirstPageReport {
  return { ...state };
}
