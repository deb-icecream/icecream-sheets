/**
 * Bulk viewport reads — Cycle 10 Phase 3/4 (first-paint fan-out fix).
 *
 * Phase 2 measured P95 first paint at ~548 range reads + ~566 usedRange
 * reads (≈1,100 small requests, ≈5.7s max task): the render ecosystem
 * asked for many small overlapping ranges and the same sheet's used range
 * hundreds of times before any cache could warm. This module collapses
 * that fan-out at the TRANSPORT layer, regardless of caller:
 *
 *  - `mergeRangesForBulkRead` unions overlapping/adjacent ranges, then
 *    greedily merges range pairs whose bounding union is not much larger
 *    than the sum of their areas — a viewport tiled by dozens of small
 *    reads becomes ONE bulk read.
 *  - `RangeReadBatcher` queues range reads issued in the same tick and
 *    flushes them as the merged bulk set (one transport call per merged
 *    range), seeding every result into the caller's cache sink.
 *  - `UsedRangeDeduper` shares ONE in-flight used-range request per sheet
 *    across all concurrent callers and caches the settled result.
 *
 * Read-count accounting lives here (`stats`) so tests — and Phase 4 perf
 * measurement — can count requests at the transport layer even when a
 * headless browser run is unavailable.
 */
import type { RangeRef, TypedCell, TypedValue } from '@icecream-sheets/engine';

export interface RangeReadResult {
  values: TypedValue[][];
  formulas: (string | null)[][];
}

function area(r: RangeRef): number {
  return (r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1);
}

function union(a: RangeRef, b: RangeRef): RangeRef {
  return {
    sheet: a.sheet,
    startRow: Math.min(a.startRow, b.startRow),
    startCol: Math.min(a.startCol, b.startCol),
    endRow: Math.max(a.endRow, b.endRow),
    endCol: Math.max(a.endCol, b.endCol),
  };
}

function overlapsOrAdjacent(a: RangeRef, b: RangeRef): boolean {
  return (
    a.startRow <= b.endRow + 1 && b.startRow <= a.endRow + 1 &&
    a.startCol <= b.endCol + 1 && b.startCol <= a.endCol + 1
  );
}

/**
 * Merge ranges (grouped per sheet) into a minimal bulk set. Exact merges
 * (overlap/adjacency) always apply; wasteful bounding unions are bounded
 * (union area ≤ 2× summed area + 512 cells of slack) so genuinely
 * scattered reads stay separate instead of pulling a whole sheet.
 */
export function mergeRangesForBulkRead(ranges: RangeRef[]): RangeRef[] {
  const bySheet = new Map<string, RangeRef[]>();
  for (const r of ranges) {
    const list = bySheet.get(r.sheet) ?? [];
    list.push({ ...r });
    bySheet.set(r.sheet, list);
  }
  const out: RangeRef[] = [];
  for (const list of bySheet.values()) {
    let merged = list;
    let changed = true;
    while (changed) {
      changed = false;
      const next: RangeRef[] = [];
      for (const r of merged) {
        const idx = next.findIndex(
          (n) => overlapsOrAdjacent(n, r) || area(union(n, r)) <= (area(n) + area(r)) * 2 + 512,
        );
        if (idx >= 0) {
          next[idx] = union(next[idx]!, r);
          changed = true;
        } else {
          next.push(r);
        }
      }
      merged = next;
    }
    out.push(...merged);
  }
  return out;
}

/** Slice one cell out of a bulk range result (bounds-checked). */
export function cellFromBulk(
  bulkRange: RangeRef,
  bulk: RangeReadResult,
  row: number,
  col: number,
): TypedCell | undefined {
  const ri = row - bulkRange.startRow;
  const ci = col - bulkRange.startCol;
  if (ri < 0 || ci < 0 || ri >= bulk.values.length) return undefined;
  const rowValues = bulk.values[ri];
  if (!rowValues || ci >= rowValues.length) return undefined;
  const formula = bulk.formulas[ri]?.[ci];
  return {
    ref: { sheet: bulkRange.sheet, row, col },
    value: rowValues[ci]!,
    ...(formula ? { formula } : {}),
  };
}

export interface BatcherStats {
  /** Individual range reads requested by callers. */
  requestedReads: number;
  /** Bulk transport calls actually issued. */
  transportCalls: number;
  /** Used-range transport calls actually issued. */
  usedRangeTransportCalls: number;
}

/**
 * Coalesces range reads issued within one tick into merged bulk reads.
 * `fetchRange` performs ONE transport range read; `sink` receives every
 * cell of every bulk result (the read-through cache). Individual callers
 * don't await the batch — the view's cache + repaint notification is the
 * delivery mechanism (render-path reads stay synchronous and fail-soft).
 * Await-capable callers use `readRangeNow`, which rides the same merge
 * when a flush is pending and otherwise fetches directly.
 */
export class RangeReadBatcher {
  readonly stats: BatcherStats = { requestedReads: 0, transportCalls: 0, usedRangeTransportCalls: 0 };
  private queue: RangeRef[] = [];
  private flushScheduled = false;
  private idleWaiters: Array<() => void> = [];
  private inFlight = 0;

  constructor(
    private readonly fetchRange: (range: RangeRef) => Promise<RangeReadResult>,
    private readonly sink: (range: RangeRef, result: RangeReadResult) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {}

  /** Queue a range for the next merged flush (fire-and-forget). */
  queueRange(range: RangeRef): void {
    this.stats.requestedReads++;
    this.queue.push(range);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => void this.flush());
    }
  }

  /** Awaitable bulk read: merges with anything already queued this tick. */
  async readRangeNow(range: RangeRef): Promise<RangeReadResult> {
    this.stats.requestedReads++;
    const merged = mergeRangesForBulkRead([...this.queue, range]);
    this.queue = [];
    let mine: RangeReadResult | undefined;
    await Promise.all(
      merged.map(async (m) => {
        const res = await this.fetchCounted(m);
        this.sink(m, res);
        if (
          m.sheet === range.sheet && range.startRow >= m.startRow && range.endRow <= m.endRow &&
          range.startCol >= m.startCol && range.endCol <= m.endCol
        ) {
          // Re-slice the caller's exact range out of the bulk result.
          const values: TypedValue[][] = [];
          const formulas: (string | null)[][] = [];
          for (let r = range.startRow; r <= range.endRow; r++) {
            const vRow: TypedValue[] = [];
            const fRow: (string | null)[] = [];
            for (let c = range.startCol; c <= range.endCol; c++) {
              const cell = cellFromBulk(m, res, r, c);
              vRow.push(cell?.value ?? { kind: 'null', value: null });
              fRow.push(cell?.formula ?? null);
            }
            values.push(vRow);
            formulas.push(fRow);
          }
          mine = { values, formulas };
        }
      }),
    );
    this.onSettled();
    this.checkIdle();
    return mine ?? this.fetchCounted(range).then((res) => { this.sink(range, res); this.checkIdle(); return res; });
  }

  private async fetchCounted(range: RangeRef): Promise<RangeReadResult> {
    this.stats.transportCalls++;
    this.inFlight++;
    try {
      return await this.fetchRange(range);
    } finally {
      // NOTE: no checkIdle here — the caller's continuation (sink
      // seeding) runs AFTER this finally, so an idle check here would
      // resolve whenIdle() waiters before results reach the cache.
      // flush()/readRangeNow() check idle at their own end instead.
      this.inFlight--;
    }
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const queued = this.queue;
    this.queue = [];
    if (queued.length === 0) { this.checkIdle(); return; }
    const merged = mergeRangesForBulkRead(queued);
    await Promise.all(
      merged.map(async (m) => {
        try {
          const res = await this.fetchCounted(m);
          this.sink(m, res);
        } catch {
          // Render-path fetches fail soft: the region stays unloaded and
          // a later read re-queues it (with the view's failure backoff).
        }
      }),
    );
    this.onSettled();
    this.checkIdle();
  }

  /** Resolves when no flush is scheduled and no fetch is in flight. */
  whenIdle(): Promise<void> {
    if (!this.flushScheduled && this.queue.length === 0 && this.inFlight === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private checkIdle(): void {
    if (this.flushScheduled || this.queue.length > 0 || this.inFlight > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}

/**
 * One in-flight used-range request per sheet, shared by every concurrent
 * caller; the settled result is cached until explicitly invalidated.
 * This alone turns Phase 2's ~566 usedRange reads into 1 per sheet.
 */
export class UsedRangeDeduper {
  private readonly cache = new Map<string, RangeRef | null>();
  private readonly inFlight = new Map<string, Promise<RangeRef | null>>();
  transportCalls = 0;

  constructor(private readonly fetchUsedRange: (sheet: string) => Promise<RangeRef | null>) {}

  cached(sheet: string): RangeRef | null | undefined {
    return this.cache.get(sheet);
  }

  get(sheet: string): Promise<RangeRef | null> {
    if (this.cache.has(sheet)) return Promise.resolve(this.cache.get(sheet) ?? null);
    const existing = this.inFlight.get(sheet);
    if (existing) return existing;
    this.transportCalls++;
    const p = this.fetchUsedRange(sheet)
      .then((r) => {
        this.cache.set(sheet, r);
        return r;
      })
      .finally(() => this.inFlight.delete(sheet));
    this.inFlight.set(sheet, p);
    return p;
  }

  /** Fire-and-forget warm (render path): result lands in the cache. */
  warm(sheet: string): void {
    if (!this.cache.has(sheet) && !this.inFlight.has(sheet)) {
      void this.get(sheet).catch(() => undefined);
    }
  }

  invalidate(sheet?: string): void {
    if (sheet === undefined) {
      this.cache.clear();
      this.inFlight.clear();
    } else {
      this.cache.delete(sheet);
      this.inFlight.delete(sheet);
    }
  }
}
