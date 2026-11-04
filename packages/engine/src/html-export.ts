/**
 * HTML download adapter (track 9).
 *
 * A write-only StorageAdapter: renders a workbook as a standalone,
 * self-contained HTML document — one styled table per sheet — so users
 * can download a readable web version of the workbook. Like the PDF
 * renderer it is pure TypeScript with zero dependencies and runs
 * identically in the browser bundle, Node, and the service boundary.
 *
 * Read is unsupported (HTML is a lossy export): read() throws a clear
 * error and capabilities.readable is false. Registered by the host
 * (apps/web/src/adapters.ts) for the .html/.htm extensions.
 */
import type {
  AdapterCapabilities,
  StorageAdapter,
  WorkbookData,
} from './storage.js';
import type { CellInput } from './workbook.js';

/** Safety cap so a pathological sheet can't OOM the tab. */
export const HTML_MAX_ROWS = 10000;
export const HTML_MAX_COLS = 200;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellText(v: CellInput): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function colLabel(index: number): string {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export interface HtmlSheetTable {
  name: string;
  header: string[];
  rows: string[][];
  capped: boolean;
}

/**
 * Build the per-sheet tables for a workbook: trims trailing blank rows /
 * columns, caps dimensions, and converts cells to display text.
 */
export function workbookToHtmlTables(data: WorkbookData): HtmlSheetTable[] {
  return data.sheets.map((sheet) => {
    const grid = sheet.rows;
    // Find the used extent (trailing blanks trimmed).
    let lastRow = -1;
    let lastCol = -1;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r]!;
      for (let c = 0; c < row.length; c++) {
        const t = cellText(row[c] as CellInput);
        if (t !== '') {
          if (r > lastRow) lastRow = r;
          if (c > lastCol) lastCol = c;
        }
      }
    }
    const capped = lastRow >= HTML_MAX_ROWS || lastCol >= HTML_MAX_COLS;
    const endRow = Math.min(lastRow, HTML_MAX_ROWS - 1);
    const endCol = Math.min(lastCol, HTML_MAX_COLS - 1);
    const header: string[] = [''];
    for (let c = 0; c <= endCol; c++) header.push(colLabel(c));
    const rows: string[][] = [];
    for (let r = 0; r <= endRow; r++) {
      const out: string[] = [String(r + 1)];
      const row = grid[r] ?? [];
      for (let c = 0; c <= endCol; c++) {
        out.push(cellText((row[c] ?? null) as CellInput));
      }
      rows.push(out);
    }
    return { name: sheet.name, header, rows, capped };
  });
}

/** Render the workbook as a standalone HTML document. */
export function renderWorkbookHtml(data: WorkbookData, title?: string): string {
  const tables = workbookToHtmlTables(data);
  const docTitle = title ?? 'Workbook';
  const parts: string[] = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  parts.push(`<title>${escapeHtml(docTitle)}</title>`);
  parts.push(`<style>
body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;margin:24px;color:#111}
h1{font-size:20px}h2{font-size:16px;margin:28px 0 8px}
table{border-collapse:collapse;font-size:13px}
th,td{border:1px solid #c8c8c8;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f2f2f2;color:#555;font-weight:600;white-space:nowrap}
td.rowhead{background:#f7f7f7;color:#777;text-align:right;white-space:nowrap}
tr:first-child td{font-weight:600;background:#fafafa}
.note{color:#777;font-size:12px}
.toc{margin:0 0 16px;padding:0;list-style:none}
.toc li{display:inline;margin-right:12px}
</style></head><body>`);
  parts.push(`<h1>${escapeHtml(docTitle)}</h1>`);
  if (tables.length > 1) {
    parts.push('<ul class="toc">');
    tables.forEach((t, i) => {
      parts.push(`<li><a href="#sheet-${i}">${escapeHtml(t.name)}</a></li>`);
    });
    parts.push('</ul>');
  }
  tables.forEach((t, i) => {
    parts.push(`<h2 id="sheet-${i}">${escapeHtml(t.name)}</h2>`);
    if (t.capped) {
      parts.push(
        `<p class="note">Table capped at ${HTML_MAX_ROWS} rows × ${HTML_MAX_COLS} columns.</p>`,
      );
    }
    if (t.rows.length === 0) {
      parts.push('<p class="note">(empty sheet)</p>');
      return;
    }
    parts.push('<table>');
    parts.push('<tr>' + t.header.map((h) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>');
    for (const row of t.rows) {
      parts.push(
        '<tr>' +
          row
            .map((cell, ci) =>
              ci === 0
                ? `<td class="rowhead">${escapeHtml(cell)}</td>`
                : `<td>${escapeHtml(cell)}</td>`,
            )
            .join('') +
          '</tr>',
      );
    }
    parts.push('</table>');
  });
  parts.push('</body></html>');
  return parts.join('\n');
}

export class HtmlAdapter implements StorageAdapter {
  readonly name = 'html';
  readonly capabilities: AdapterCapabilities = {
    readable: false,
    writable: true,
    transactional: false,
    preservesUnknownParts: false,
    supportsEncryption: false,
  };

  /** HTML is a lossy export — reading it back is unsupported. */
  read(): WorkbookData {
    throw new Error(
      'The HTML adapter is write-only: an exported .html file cannot be opened as a workbook.',
    );
  }

  /** Serialize the workbook to a standalone HTML document (UTF-8). */
  write(data: WorkbookData): Uint8Array {
    const title =
      typeof data.metadata['title'] === 'string'
        ? (data.metadata['title'] as string)
        : 'Workbook';
    const html = renderWorkbookHtml(data, title);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(html);
    return Buffer.from(html, 'utf8');
  }
}
