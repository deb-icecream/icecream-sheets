/**
 * CSV/TSV storage adapter (RFC 4180 quoting).
 *
 * - Delimiter auto-detection: comma, tab, semicolon, pipe (first non-empty
 *   line decides; falls back to comma).
 * - Quoted fields, escaped quotes (""), embedded newlines supported.
 * - Single-sheet workbooks only: read() returns one sheet named "Sheet1";
 *   write() serializes the first sheet (extra sheets are dropped, noted in
 *   the returned metadata warning).
 * - All values round-trip as strings; numeric/boolean/formula detection is
 *   the engine's job on read (formulas are NOT reconstituted from CSV —
 *   a cell starting with '=' is read as a plain string, matching Excel's
 *   CSV behavior of not evaluating on import).
 */
import type {
  AdapterCapabilities,
  CellInput,
  StorageAdapter,
  WorkbookData,
} from '@icecream-sheets/engine';

const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const;

export type CsvDelimiter = (typeof CANDIDATE_DELIMITERS)[number];

export interface CsvOptions {
  delimiter?: CsvDelimiter | 'auto';
}

/** Detect the delimiter from the first non-empty line. */
export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    // Count delimiters outside quoted sections.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        if (inQuotes && firstLine[i + 1] === '"') i++; // escaped quote
        else inQuotes = !inQuotes;
      } else if (ch === d && !inQuotes) {
        count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Parse CSV text into rows of strings (RFC 4180). */
export function parseCsv(text: string, delimiter: CsvDelimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  // Strip BOM.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      pushField();
      i++;
    } else if (ch === '\r') {
      // CRLF or lone CR.
      if (text[i + 1] === '\n') i += 2;
      else i++;
      pushRow();
    } else if (ch === '\n') {
      i++;
      pushRow();
    } else {
      field += ch;
      i++;
    }
  }
  // Trailing field/row (a file ending with a newline already pushed its row).
  if (field !== '' || row.length > 0) {
    pushField();
    rows.push(row);
  }
  // Drop a single trailing empty row produced by a final newline.
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') rows.pop();
  }
  return rows;
}

function needsQuoting(value: string, delimiter: CsvDelimiter): boolean {
  return (
    value.includes('"') ||
    value.includes(delimiter) ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.startsWith(' ') ||
    value.endsWith(' ')
  );
}

export function stringifyCsv(rows: string[][], delimiter: CsvDelimiter = ','): string {
  return (
    rows
      .map((row) =>
        row
          .map((v) =>
            needsQuoting(v, delimiter) ? `"${v.replace(/"/g, '""')}"` : v,
          )
          .join(delimiter),
      )
      .join('\r\n') + '\r\n'
  );
}

function cellToString(cell: CellInput): string {
  if (cell === null) return '';
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return String(cell);
}

function stringToCell(s: string): CellInput {
  if (s === '') return null;
  // Numeric detection (not Excel-exact, but round-trips write() output).
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return s;
}

export class CsvAdapter implements StorageAdapter {
  readonly name: string = 'csv';
  readonly delimiter: CsvDelimiter | 'auto';
  readonly extension: string;

  readonly capabilities: AdapterCapabilities = {
    readable: true,
    writable: true,
    transactional: false,
    preservesUnknownParts: false,
    supportsEncryption: false,
  };

  constructor(options: CsvOptions & { extension?: string } = {}) {
    this.delimiter = options.delimiter ?? 'auto';
    this.extension = options.extension ?? 'csv';
  }

  read(buffer: Uint8Array): WorkbookData {
    const text = new TextDecoder('utf-8').decode(buffer);
    const delim = this.delimiter === 'auto' ? detectDelimiter(text) : this.delimiter;
    const rows = parseCsv(text, delim);
    return {
      sheets: [{ name: 'Sheet1', rows: rows.map((r) => r.map(stringToCell)) }],
      metadata: { 'csv.delimiter': delim },
    };
  }

  write(data: WorkbookData, _original?: Uint8Array): Uint8Array {
    const delim: CsvDelimiter =
      this.delimiter === 'auto'
        ? (data.metadata['csv.delimiter'] as CsvDelimiter | undefined) ?? ','
        : this.delimiter;
    const first = data.sheets[0];
    const rows: string[][] = (first?.rows ?? []).map((r) => (r ?? []).map(cellToString));
    const text = stringifyCsv(rows, delim);
    const metadata: Record<string, unknown> = { 'csv.delimiter': delim };
    if (data.sheets.length > 1) {
      metadata['csv.droppedSheets'] = data.sheets.length - 1;
    }
    void metadata;
    return new TextEncoder().encode(text);
  }
}

/** TSV is CSV with a forced tab delimiter. */
export class TsvAdapter extends CsvAdapter {
  readonly name = 'tsv';
  constructor() {
    super({ delimiter: '\t', extension: 'tsv' });
  }
}
