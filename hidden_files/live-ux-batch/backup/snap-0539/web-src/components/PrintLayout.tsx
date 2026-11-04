/**
 * Print layout: page setup + print preview.
 *
 * Follows design-docs/print-and-page-layout.md:
 * - Download-as-PDF is the single print path (§3). There is no OS print
 *   dialog integration in v1: the preview offers "Download PDF" only, which
 *   renders real PDF bytes through the service renderer (renderSheetPdf).
 * - Pagination is computed with the deterministic service engine
 *   (paginateSheet, packages/service/src/pagination.ts) from the same
 *   snapshot the grid renders — the preview shows exactly what
 *   Download-as-PDF produces. There is no separate layout implementation
 *   to drift (§4).
 * - Page setup (orientation, paper size, margins, scale, fit-to-page,
 *   print area, header/footer) persists as adapter metadata
 *   (`icecream.pagesetup.<sheet>`), never in cell data (§2).
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';
import { expandHFCodes, type HFRenderContext, type PaginatedPage } from '@icecream-sheets/service';

/** Page setup for one sheet. All lengths in inches except scale (percent). */
export interface PageSetup {
  orientation: 'portrait' | 'landscape';
  paperSize: 'letter' | 'a4' | 'legal' | 'a3';
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    /**
     * Header/footer margin distances (GAP-9): carried through the model so
     * native `<pageMargins header/footer>` round-trip through XLSX. The
     * dialog has no controls for these yet — they ride along untouched
     * from the opened file. Absent = Excel default (0.3).
     */
    header?: number;
    footer?: number;
  };
  /** Print scaling percent (10–400). */
  scale: number;
  /** A1-style print area ("A1:D20") or null for the whole used range. */
  printArea: string | null;
  header: string;
  footer: string;
  /**
   * Fit-to-page (GAP-9): carried through the model so native
   * `<pageSetup fitToPage/fitToWidth/fitToHeight>` settings round-trip
   * through XLSX. The dialog has no controls for these yet — they ride
   * along untouched from the opened file.
   */
  fitToPage: boolean;
  /** Fit-to width in pages (0 = as many as needed). */
  fitToWidth: number;
  /** Fit-to height in pages (0 = as many as needed). */
  fitToHeight: number;
}

export const PAGE_SETUP_METADATA_PREFIX = 'icecream.pagesetup.';

export const DEFAULT_PAGE_SETUP: PageSetup = {
  orientation: 'portrait',
  paperSize: 'letter',
  margins: { top: 0.75, right: 0.7, bottom: 0.75, left: 0.7 },
  scale: 100,
  printArea: null,
  header: '',
  footer: '',
  fitToPage: false,
  fitToWidth: 0,
  fitToHeight: 0,
};

/** Paper dimensions in inches (width × height, portrait), with UI labels. */
export const PAPER_SIZES: Record<PageSetup['paperSize'], { w: number; h: number; label: string }> = {
  letter: { w: 8.5, h: 11, label: 'Letter (8.5" × 11")' },
  a4: { w: 8.27, h: 11.69, label: 'A4 (210 × 297 mm)' },
  legal: { w: 8.5, h: 14, label: 'Legal (8.5" × 14")' },
  a3: { w: 11.69, h: 16.54, label: 'A3 (297 × 420 mm)' },
};

export function pageSetupToMetadata(setup: PageSetup): unknown {
  return JSON.parse(JSON.stringify(setup)) as unknown;
}

export function pageSetupFromMetadata(meta: unknown): PageSetup | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const r = meta as Record<string, unknown>;
  if (r.orientation !== 'portrait' && r.orientation !== 'landscape') return null;
  return { ...DEFAULT_PAGE_SETUP, ...(r as Partial<PageSetup>) };
}

// ---------------------------------------------------------------------------
// Print preview dialog
// ---------------------------------------------------------------------------

export interface PrintCellReader {
  (row: number, col: number): string;
}

interface PrintPreviewDialogProps {
  sheet: string;
  setup: PageSetup;
  onSetupChange: (setup: PageSetup) => void;
  readCell: PrintCellReader;
  /**
   * Pages paginated with the service engine (paginateSheet) from the same
   * snapshot Download-as-PDF uses — computed by the parent so the preview
   * and the downloaded PDF can never diverge.
   */
  pages: PaginatedPage[];
  /** Workbook file name for &F expansion. Defaults to 'Workbook'. */
  fileName?: string;
  /** Download-as-PDF: the single print path (design §3). */
  onDownloadPdf: () => void;
  onClose: () => void;
}

function colLabel(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Row/column indices to render for a page: print titles first, then content. */
export function pageGrid(p: PaginatedPage): { rows: number[]; cols: number[]; isTitle: (row: number, col: number) => boolean } {
  const rows: number[] = [];
  if (p.titleRows) for (let r = p.titleRows.startRow; r <= p.titleRows.endRow; r++) rows.push(r);
  for (let r = p.startRow; r <= p.endRow; r++) rows.push(r);
  const cols: number[] = [];
  if (p.titleCols) for (let c = p.titleCols.startCol; c <= p.titleCols.endCol; c++) cols.push(c);
  for (let c = p.startCol; c <= p.endCol; c++) cols.push(c);
  const isTitle = (row: number, col: number): boolean =>
    (p.titleRows !== null && row >= p.titleRows.startRow && row <= p.titleRows.endRow) ||
    (p.titleCols !== null && col >= p.titleCols.startCol && col <= p.titleCols.endCol);
  return { rows, cols, isTitle };
}

export function PrintPreviewDialog({ sheet, setup, onSetupChange, readCell, pages, fileName, onDownloadPdf, onClose }: PrintPreviewDialogProps) {
  const [zoom, setZoom] = useState(0.55);
  const set = (patch: Partial<PageSetup>) => onSetupChange({ ...setup, ...patch });
  const setMargin = (k: keyof PageSetup['margins'], v: number) =>
    onSetupChange({ ...setup, margins: { ...setup.margins, [k]: Math.max(0, Math.min(3, v)) } });

  /** Header/footer render context for one page (Excel &P/&N/&D/&T/&F/&A codes). */
  const hfCtx = (pageNumber: number): HFRenderContext => ({
    page: pageNumber,
    pages: pages.length,
    date: new Date(),
    fileName: fileName ?? 'Workbook',
    sheetName: sheet,
  });

  return (
    <A11yDialog title={<>Print preview — {sheet}</>} width={1060} onClose={onClose}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={onDownloadPdf}
            disabled={pages.length === 0}
            title="Download as PDF — the single print path"
          >
            ⤓ Download PDF
          </button>
        </div>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 230, borderRight: '1px solid #ddd', padding: 12, overflowY: 'auto', fontSize: 13 }}>
            <h4 style={{ margin: '0 0 8px' }}>Page setup</h4>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Orientation{' '}
              <select value={setup.orientation} onChange={(e) => set({ orientation: e.target.value as PageSetup['orientation'] })}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Paper size{' '}
              <select value={setup.paperSize} onChange={(e) => set({ paperSize: e.target.value as PageSetup['paperSize'] })}>
                {(Object.keys(PAPER_SIZES) as PageSetup['paperSize'][]).map((k) => (
                  <option key={k} value={k}>{PAPER_SIZES[k].label}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Scale (%){' '}
              <input
                type="number"
                min={10}
                max={400}
                value={setup.scale}
                onChange={(e) => set({ scale: Number(e.target.value) || 100 })}
                style={{ width: 64 }}
              />
            </label>
            <fieldset style={{ margin: '0 0 8px', padding: 8 }}>
              <legend>Margins (in)</legend>
              {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                <label key={k} style={{ display: 'block', marginBottom: 4 }}>
                  {k[0].toUpperCase() + k.slice(1)}{' '}
                  <input
                    type="number"
                    step={0.25}
                    min={0}
                    max={3}
                    value={setup.margins[k]}
                    onChange={(e) => setMargin(k, Number(e.target.value))}
                    style={{ width: 56 }}
                  />
                </label>
              ))}
            </fieldset>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Print area{' '}
              <input
                value={setup.printArea ?? ''}
                placeholder="e.g. A1:D20 (blank = all)"
                onChange={(e) => set({ printArea: e.target.value.trim() || null })}
                style={{ width: 120 }}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Header{' '}
              <input value={setup.header} onChange={(e) => set({ header: e.target.value })} style={{ width: 150 }} />
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Footer{' '}
              <input value={setup.footer} onChange={(e) => set({ footer: e.target.value })} style={{ width: 150 }} />
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Preview zoom{' '}
              <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                <option value={0.35}>35%</option>
                <option value={0.55}>55%</option>
                <option value={0.8}>80%</option>
                <option value={1}>100%</option>
              </select>
            </label>
            <p style={{ color: '#666' }}>{pages.length} page{pages.length === 1 ? '' : 's'}</p>
          </div>
          <div style={{ flex: 1, overflow: 'auto', background: '#525659', padding: 16 }}>
            {pages.length === 0 && <p style={{ color: '#fff' }}>Nothing to print.</p>}
            {pages.map((p) => {
              const grid = pageGrid(p);
              return (
                <div
                  key={p.pageNumber}
                  style={{
                    background: '#fff',
                    margin: '0 auto 16px',
                    padding: 12,
                    width: 640 * zoom + 24,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    fontSize: 12,
                  }}
                >
                  <div style={{ color: '#666', marginBottom: 6 }}>
                    Page {p.pageNumber} — {colLabel(p.startCol)}{p.startRow + 1}:{colLabel(p.endCol)}{p.endRow + 1}
                    {(p.titleRows || p.titleCols) && ' (with print titles)'}
                  </div>
                  {setup.header && (
                    <div style={{ textAlign: 'center', marginBottom: 6 }}>
                      {expandHFCodes(setup.header, hfCtx(p.pageNumber))}
                    </div>
                  )}
                  <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
                    <tbody>
                      {grid.rows.map((r) => (
                        <tr key={r}>
                          {grid.cols.map((c) => (
                            <td
                              key={c}
                              style={{
                                border: '1px solid #bbb',
                                padding: '2px 4px',
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                                background: grid.isTitle(r, c) ? '#eee' : undefined,
                              }}
                            >
                              {readCell(r, c)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {setup.footer && (
                    <div style={{ textAlign: 'center', marginTop: 6 }}>
                      {expandHFCodes(setup.footer, hfCtx(p.pageNumber))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
    </A11yDialog>
  );
}
