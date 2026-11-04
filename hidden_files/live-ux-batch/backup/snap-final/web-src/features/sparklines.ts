/**
 * Sparklines (track 14: sparklines-slicers-timelines).
 *
 * Tiny in-cell charts: line, column, and win/loss. Rendered as SVG inside
 * grid cells. Pure functions for testability; the React component wraps them.
 */

export type SparklineType = 'line' | 'column' | 'winloss';

export interface SparklineSpec {
  type: SparklineType;
  /** Cell range address, e.g. "B2:F2". */
  range: string;
  /** Line/column color. */
  color?: string;
  /** Highlight min/max points. */
  showMinMax?: boolean;
}

/**
 * A sparkline placed in a grid cell (track 14). The sparkline renders
 * inside the cell at (sheet, row, col) and visualizes the data in `range`.
 */
export interface SparklinePlacement extends SparklineSpec {
  id: number;
  sheet: string;
  row: number;
  col: number;
}

/** Key for looking up the sparkline in a cell. */
export function sparklineKey(sheet: string, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/**
 * Render a sparkline as SVG markup.
 * values: numeric data points. w/h: pixel dimensions.
 */
export function renderSparkline(
  type: SparklineType,
  values: number[],
  w: number,
  h: number,
  color = '#2563eb',
): string {
  if (values.length === 0) return `<svg width="${w}" height="${h}"></svg>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const iw = w - pad * 2;
  const ih = h - pad * 2;

  const x = (i: number) =>
    values.length === 1 ? pad + iw / 2 : pad + (i / (values.length - 1)) * iw;
  const y = (v: number) => pad + ih - ((v - min) / span) * ih;

  if (type === 'line') {
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    let dots = '';
    if (values.length > 0) {
      const minI = values.indexOf(min);
      const maxI = values.indexOf(max);
      dots =
        `<circle cx="${x(minI)}" cy="${y(min)}" r="2" fill="#dc2626"/>` +
        `<circle cx="${x(maxI)}" cy="${y(max)}" r="2" fill="#16a34a"/>`;
    }
    return (
      `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/>${dots}</svg>`
    );
  }

  if (type === 'column') {
    const bw = iw / values.length;
    const bars = values
      .map((v, i) => {
        const bh = Math.max(1, ((v - min) / span) * ih);
        const bx = pad + i * bw + bw * 0.15;
        return `<rect x="${bx.toFixed(1)}" y="${(pad + ih - bh).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}"/>`;
      })
      .join('');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bars}</svg>`;
  }

  // winloss: bars above/below a center axis based on sign.
  const midY = pad + ih / 2;
  const bw = iw / values.length;
  const bars = values
    .map((v, i) => {
      const bh = Math.max(2, ih / 2 - 2);
      const bx = pad + i * bw + bw * 0.15;
      const by = v >= 0 ? midY - bh : midY;
      const fill = v > 0 ? '#16a34a' : v < 0 ? '#dc2626' : '#9ca3af';
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" fill="${fill}"/>`;
    })
    .join('');
  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<line x1="${pad}" y1="${midY}" x2="${w - pad}" y2="${midY}" stroke="#d1d5db" stroke-width="1"/>${bars}</svg>`
  );
}

/** Parse a simple range like "B2:F2" into values from a cell reader. */
export function sparklineValues(
  range: string,
  readCell: (row: number, col: number) => number | null,
): number[] {
  const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return [];
  const colToIdx = (s: string): number => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const c1 = colToIdx(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = colToIdx(m[3]);
  const r2 = parseInt(m[4], 10) - 1;
  const out: number[] = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      const v = readCell(r, c);
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}
