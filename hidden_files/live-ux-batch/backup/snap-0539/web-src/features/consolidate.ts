/**
 * Consolidate (Data > Data Tools > Consolidate).
 *
 * Aggregates multiple ranges with SUM / COUNT / AVERAGE / MAX / MIN,
 * either by position (ranges must share the same shape; cells are
 * combined element-wise) or by labels (first row and first column are
 * category labels; ranges are aligned on the union of labels, Excel
 * "top row / left column" style).
 *
 * Pure logic over string matrices; the dialog reads ranges through the
 * host and writes the result to the destination cell.
 */

export type ConsolidateFn = 'sum' | 'count' | 'average' | 'max' | 'min';
export type ConsolidateMode = 'position' | 'labels';

export const CONSOLIDATE_FNS: { id: ConsolidateFn; label: string }[] = [
  { id: 'sum', label: 'Sum' },
  { id: 'count', label: 'Count' },
  { id: 'average', label: 'Average' },
  { id: 'max', label: 'Max' },
  { id: 'min', label: 'Min' },
];

function numericValues(cells: string[]): number[] {
  return cells
    .map((c) => (c.trim() === '' ? NaN : Number(c)))
    .filter((n) => !Number.isNaN(n));
}

export function aggregateCells(cells: string[], fn: ConsolidateFn): string {
  const nums = numericValues(cells);
  switch (fn) {
    case 'sum':
      return String(nums.reduce((a, b) => a + b, 0));
    case 'count':
      return String(nums.length);
    case 'average':
      return nums.length === 0 ? '' : String(nums.reduce((a, b) => a + b, 0) / nums.length);
    case 'max':
      return nums.length === 0 ? '' : String(Math.max(...nums));
    case 'min':
      return nums.length === 0 ? '' : String(Math.min(...nums));
  }
}

/** Element-wise aggregation; all ranges must share the first range's shape. */
function consolidateByPosition(ranges: string[][][], fn: ConsolidateFn): string[][] {
  const [first, ...rest] = ranges;
  const rows = first.length;
  const cols = Math.max(...ranges.map((r) => Math.max(...r.map((row) => row.length), 0)));
  for (const r of rest) {
    if (r.length !== rows) {
      throw new Error('Consolidate by position requires all ranges to have the same number of rows.');
    }
  }
  const out: string[][] = [];
  for (let i = 0; i < rows; i++) {
    const outRow: string[] = [];
    for (let j = 0; j < cols; j++) {
      const cells = ranges.map((r) => (r[i] ?? [])[j] ?? '');
      outRow.push(aggregateCells(cells, fn));
    }
    out.push(outRow);
  }
  return out;
}

/**
 * Label-based consolidation. Each range's first row holds column labels
 * and first column holds row labels; the top-left cell is ignored. The
 * result covers the union of all row/column labels.
 */
function consolidateByLabels(ranges: string[][][], fn: ConsolidateFn): string[][] {
  const rowLabels: string[] = [];
  const colLabels: string[] = [];
  const buckets = new Map<string, string[]>(); // "rowLabel\x00colLabel" -> cells
  for (const range of ranges) {
    if (range.length < 2 || (range[0] ?? []).length < 2) {
      throw new Error('Consolidate by labels needs at least a 2×2 range (labels + data).');
    }
    const rLabels = range.slice(1).map((r) => r[0] ?? '');
    const cLabels = (range[0] ?? []).slice(1);
    for (const l of rLabels) if (!rowLabels.includes(l)) rowLabels.push(l);
    for (const l of cLabels) if (!colLabels.includes(l)) colLabels.push(l);
    for (let i = 0; i < rLabels.length; i++) {
      for (let j = 0; j < cLabels.length; j++) {
        const key = `${rLabels[i]}\u0000${cLabels[j]}`;
        const cell = (range[i + 1] ?? [])[j + 1] ?? '';
        const arr = buckets.get(key) ?? [];
        arr.push(cell);
        buckets.set(key, arr);
      }
    }
  }
  const out: string[][] = [['', ...colLabels]];
  for (const rl of rowLabels) {
    const outRow = [rl];
    for (const cl of colLabels) {
      outRow.push(aggregateCells(buckets.get(`${rl}\u0000${cl}`) ?? [], fn));
    }
    out.push(outRow);
  }
  return out;
}

/** Consolidate ranges with the given function and mode. */
export function consolidate(
  ranges: string[][][],
  fn: ConsolidateFn,
  mode: ConsolidateMode,
): string[][] {
  if (ranges.length === 0) throw new Error('Consolidate needs at least one range.');
  return mode === 'position' ? consolidateByPosition(ranges, fn) : consolidateByLabels(ranges, fn);
}
