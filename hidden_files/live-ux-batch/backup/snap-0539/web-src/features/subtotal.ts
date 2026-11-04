/**
 * Subtotal + outline levels (Data > Outline > Subtotal, Show Detail, Hide Detail).
 *
 * applySubtotal() groups sorted rows by the group column and emits the
 * original detail rows interleaved with "X Total" subtotal rows plus a
 * "Grand Total" row, each tagged with an Excel-style outline level:
 *   level 1 — grand total only
 *   level 2 — subtotal rows + grand total
 *   level 3 — everything (detail rows)
 * Show Detail / Hide Detail simply raise/lower the visible outline level;
 * rowVisible() decides per-row visibility so the grid can collapse groups
 * without deleting data. The input is sorted by the group column first
 * (Excel requires pre-sorted data; we do it so the feature just works).
 */

export type SubtotalFn = 'sum' | 'count' | 'average' | 'max' | 'min';

export const SUBTOTAL_FNS: { id: SubtotalFn; label: string }[] = [
  { id: 'sum', label: 'Sum' },
  { id: 'count', label: 'Count' },
  { id: 'average', label: 'Average' },
  { id: 'max', label: 'Max' },
  { id: 'min', label: 'Min' },
];

export interface SubtotalSpec {
  /** Zero-based index of the group-by column (within the data matrix). */
  groupCol: number;
  /** Zero-based indexes of the value columns to aggregate. */
  valueCols: number[];
  fn: SubtotalFn;
}

export interface SubtotalRow {
  values: string[];
  /** Excel outline level: 1 = grand total, 2 = subtotal, 3 = detail. */
  level: 1 | 2 | 3;
  isSubtotal: boolean;
  /** Group key for this row (detail rows) or the group it totals. */
  groupKey: string;
}

export type OutlineLevel = 1 | 2 | 3;

function toNumbers(cells: string[]): number[] {
  return cells
    .map((c) => (c.trim() === '' ? NaN : Number(c)))
    .filter((n) => !Number.isNaN(n));
}

function aggregate(values: string[], fn: SubtotalFn): string {
  const nums = toNumbers(values);
  switch (fn) {
    case 'sum': return String(nums.reduce((a, b) => a + b, 0));
    case 'count': return String(nums.length);
    case 'average': return nums.length ? String(nums.reduce((a, b) => a + b, 0) / nums.length) : '';
    case 'max': return nums.length ? String(Math.max(...nums)) : '';
    case 'min': return nums.length ? String(Math.min(...nums)) : '';
  }
}

/**
 * Build subtotal rows. data[0] is the header row (passed through at
 * level 3). Returns detail + subtotal + grand-total rows.
 */
export function applySubtotal(data: string[][], spec: SubtotalSpec): SubtotalRow[] {
  if (data.length === 0) return [];
  if (spec.valueCols.length === 0) throw new Error('Subtotal needs at least one value column.');
  const [header, ...body] = data;
  const sorted = [...body].sort((a, b) =>
    String(a[spec.groupCol] ?? '').localeCompare(String(b[spec.groupCol] ?? ''), undefined, { numeric: true }),
  );
  const width = header.length;
  const blank = (fill: (i: number) => string): string[] =>
    Array.from({ length: width }, (_, i) => fill(i));

  const out: SubtotalRow[] = [{ values: header, level: 3, isSubtotal: false, groupKey: '' }];
  let group: string[][] = [];
  let groupKey = '';
  const flushGroup = (): void => {
    if (group.length === 0) return;
    for (const r of group) out.push({ values: r, level: 3, isSubtotal: false, groupKey });
    const label = `${groupKey} Total`;
    out.push({
      values: blank((i) => {
        if (i === spec.groupCol) return label;
        const vi = spec.valueCols.indexOf(i);
        return vi === -1 ? '' : aggregate(group.map((r) => r[i] ?? ''), spec.fn);
      }),
      level: 2,
      isSubtotal: true,
      groupKey,
    });
    group = [];
  };
  for (const row of sorted) {
    const key = String(row[spec.groupCol] ?? '');
    if (group.length > 0 && key !== groupKey) flushGroup();
    groupKey = key;
    group.push(row);
  }
  flushGroup();
  const allValues = (i: number): string[] => out.filter((r) => !r.isSubtotal && r.values !== header).map((r) => r.values[i] ?? '');
  out.push({
    values: blank((i) => {
      if (i === spec.groupCol) return 'Grand Total';
      return spec.valueCols.includes(i) ? aggregate(allValues(i), spec.fn) : '';
    }),
    level: 1,
    isSubtotal: true,
    groupKey: '',
  });
  return out;
}

/** Whether a subtotal row is visible at the given outline level. */
export function rowVisible(row: SubtotalRow, level: OutlineLevel): boolean {
  return row.level <= level;
}

/** Filter rows to those visible at the given outline level. */
export function visibleRows(rows: SubtotalRow[], level: OutlineLevel): SubtotalRow[] {
  return rows.filter((r) => rowVisible(r, level));
}

/** Clamp an outline level step for Show Detail (+) / Hide Detail (−). */
export function stepOutlineLevel(current: OutlineLevel, direction: 1 | -1): OutlineLevel {
  return Math.min(3, Math.max(1, current + direction)) as OutlineLevel;
}
