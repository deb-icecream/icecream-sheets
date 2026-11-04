/**
 * Delimiter-aware text parsing for QuickImport (Data > From Text/CSV).
 *
 * Extends the Power Query CSV parser with selectable delimiters
 * (comma, tab, semicolon, pipe, custom) so the import dialog can show a
 * live preview while the user picks the right separator. Quote handling
 * matches features/powerQuery.ts: quoted fields may contain the delimiter
 * and escaped quotes ("").
 */

export interface DelimitedTable {
  headers: string[];
  rows: string[][];
}

export const DELIMITER_PRESETS = [
  { id: 'comma', label: 'Comma (,)', char: ',' },
  { id: 'tab', label: 'Tab', char: '\t' },
  { id: 'semicolon', label: 'Semicolon (;)', char: ';' },
  { id: 'pipe', label: 'Pipe (|)', char: '|' },
  { id: 'space', label: 'Space', char: ' ' },
] as const;

export type DelimiterPresetId = (typeof DELIMITER_PRESETS)[number]['id'];

/** Parse text with an explicit single-character delimiter. */
export function parseDelimited(text: string, delimiter: string): DelimitedTable {
  const delim = delimiter.length > 0 ? delimiter[0] : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\r') {
      // skip; \n terminates the row
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h, i) => (h.trim() === '' ? `Column${i + 1}` : h.trim()));
  const width = headers.length;
  const body = nonEmpty.slice(1).map((r) => {
    const padded = r.slice(0, width);
    while (padded.length < width) padded.push('');
    return padded;
  });
  return { headers, rows: body };
}

/** Guess the most likely delimiter by counting consistent field counts. */
export function detectDelimiter(text: string): string {
  const sample = text.split('\n').slice(0, 5).filter((l) => l.trim() !== '');
  if (sample.length === 0) return ',';
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = sample.map((l) => l.split(d).length);
    const consistent = counts.every((c) => c === counts[0]) ? 1 : 0;
    const score = counts[0] * 2 + consistent;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Convert a parsed table to a plain grid (header row + data rows). */
export function delimitedToGrid(table: DelimitedTable, firstRowIsHeader: boolean): string[][] {
  if (table.headers.length === 0) return [];
  if (firstRowIsHeader) return [table.headers, ...table.rows];
  const headers = table.headers.map((_, i) => `Column${i + 1}`);
  return [headers, table.headers, ...table.rows];
}
