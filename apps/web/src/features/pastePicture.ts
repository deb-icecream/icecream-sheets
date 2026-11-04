/**
 * Paste as Picture / Paste as Linked Picture (Home > Clipboard > Paste).
 *
 * - Paste as Picture: reads an image from the clipboard (navigator.clipboard.read)
 *   and returns a data URL the parent adds as a Picture overlay.
 * - Paste as Linked Picture: renders the selected cell range as an SVG
 *   snapshot ("camera" picture). The parent keeps a LinkedPictureBinding so
 *   the picture can be refreshed from the live range later.
 */

export interface PastedImage {
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read clipboard image.'));
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not decode clipboard image.'));
    img.src = dataUrl;
  });
}

/**
 * Read the first image on the clipboard (Paste as Picture). Returns null
 * when the clipboard holds no image. Throws when clipboard access is
 * denied — the caller surfaces the message.
 */
export async function readImageFromClipboard(): Promise<PastedImage | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
    throw new Error('Clipboard image read is not supported in this browser.');
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const mime = item.types.find((t) => t.startsWith('image/'));
    if (!mime) continue;
    const blob = await item.getType(mime);
    const dataUrl = await blobToDataUrl(blob);
    const { width, height } = await imageSize(dataUrl);
    return { dataUrl, width, height, name: 'Pasted picture' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Linked picture: render a cell range as SVG
// ---------------------------------------------------------------------------

export interface RangeSnapshot {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Binding between a picture overlay and its live source range. */
export interface LinkedPictureBinding {
  pictureId: number;
  source: RangeSnapshot;
}

export interface RangeRenderOptions {
  /** Column widths in px (default 80). */
  colWidths?: number[];
  rowHeight?: number;
  fontSize?: number;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render display strings of a cell range as a spreadsheet-like SVG
 * (Paste as Linked Picture). Deterministic and DOM-free, so it can be
 * re-rendered any time the source range changes.
 */
export function renderRangeAsSvg(
  cells: string[][],
  opts: RangeRenderOptions = {},
): { svg: string; width: number; height: number } {
  const rows = cells.length;
  const cols = Math.max(0, ...cells.map((r) => r.length));
  const colWidths = Array.from({ length: cols }, (_, i) => opts.colWidths?.[i] ?? 80);
  const rowHeight = opts.rowHeight ?? 22;
  const fontSize = opts.fontSize ?? 12;
  const width = colWidths.reduce((a, b) => a + b, 0) + 1;
  const height = rows * rowHeight + 1;

  let body = `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff"/>`;
  let y = 0;
  for (let r = 0; r < rows; r++) {
    let x = 0;
    for (let c = 0; c < cols; c++) {
      const w = colWidths[c];
      const text = cells[r]?.[c] ?? '';
      // Clip text to the cell with an SVG clipPath-free trick: short text.
      const maxChars = Math.max(1, Math.floor(w / (fontSize * 0.55)));
      const shown = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
      body +=
        `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w}" height="${rowHeight}" fill="none" stroke="#c0c0c0" stroke-width="1"/>` +
        `<text x="${x + 4}" y="${y + rowHeight / 2 + fontSize * 0.35}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#111">${escapeXml(shown)}</text>`;
      x += w;
    }
    y += rowHeight;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    body +
    `</svg>`;
  return { svg, width, height };
}

/** Encode an SVG string as a data URL for the Picture overlay. */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
