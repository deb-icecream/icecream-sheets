/**
 * Render manual page breaks as dashed blue lines over the grid.
 *
 * The parent supplies pixel geometry (column x-offsets and row y-offsets
 * from the grid) so this stays decoupled from the grid implementation.
 */
import { type PageBreaks } from '../features/pageBreaks';

export interface PageBreakLinesProps {
  breaks: PageBreaks;
  /** Pixel x of the LEFT edge of column `col` (i.e. break after col-1). */
  colX: (col: number) => number;
  /** Pixel y of the TOP edge of row `row`. */
  rowY: (row: number) => number;
  width: number;
  height: number;
  maxRow: number;
  maxCol: number;
}

export default function PageBreakLines({ breaks, colX, rowY, width, height, maxRow, maxCol }: PageBreakLinesProps) {
  const lines: { key: string; style: React.CSSProperties }[] = [];
  const lineStyle: React.CSSProperties = {
    position: 'absolute',
    background: 'transparent',
    pointerEvents: 'none',
    zIndex: 15,
  };
  for (const r of breaks.rows) {
    if (r < 0 || r >= maxRow) continue;
    const y = rowY(r + 1);
    lines.push({
      key: `r${r}`,
      style: { ...lineStyle, left: 0, top: y - 1, width, height: 0, borderTop: '2px dashed #1a73e8' },
    });
  }
  for (const c of breaks.cols) {
    if (c < 0 || c >= maxCol) continue;
    const x = colX(c + 1);
    lines.push({
      key: `c${c}`,
      style: { ...lineStyle, left: x - 1, top: 0, width: 0, height, borderLeft: '2px dashed #1a73e8' },
    });
  }
  return (
    <>
      {lines.map((l) => (
        <div key={l.key} style={l.style} />
      ))}
    </>
  );
}
