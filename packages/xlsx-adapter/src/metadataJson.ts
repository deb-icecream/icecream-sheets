/**
 * JSON wire encoding for adapter output (Cycle 10, Phase 2).
 *
 * The engine service returns a parsed workbook's non-row payload (adapter
 * metadata, per-cell format codes) to the web client as JSON so a
 * gateway-mode open can hydrate the same UI stores a local open does.
 * Two problems with a naive `JSON.stringify`:
 *
 * 1. `WorkbookData.metadata` carries raw part bytes as `Uint8Array`
 *    (`xlsx.pivotParts`, `xlsx.smartartParts`, the VBA project). JSON
 *    would silently mangle them into `{"0":…}` objects. The encoder below
 *    rewrites every binary value as `{ $binary: <base64> }` (single-key
 *    marker object); the decoder restores real `Uint8Array`s.
 *
 * 2. `SheetData.formats` is a `"row:col" → code` record that can hold
 *    hundreds of thousands of entries on large files (420k on the P95
 *    fixture — 8.8 MB as plain JSON). Real files format whole columns, so
 *    the record is run-length encoded per column: contiguous same-code
 *    row runs collapse to one tuple. Worst case (checkerboard formats)
 *    degrades to one tuple per cell — never worse than the raw record.
 */

const BINARY_MARKER = '$binary';

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function u8ToBase64(bytes: Uint8Array): string {
  // Chunked String.fromCharCode: safe for multi-MB parts without blowing
  // the call stack; btoa exists in browsers, Buffer in Node.
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToU8(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Recursively encode a value so `JSON.stringify` round-trips it exactly:
 * `Uint8Array` (incl. Buffer) → `{ $binary: base64 }`; arrays and plain
 * objects are walked; everything else passes through unchanged.
 */
export function encodeForJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BINARY_MARKER]: u8ToBase64(value) };
  if (Array.isArray(value)) return value.map(encodeForJson);
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeForJson(v);
    return out;
  }
  return value;
}

/** Inverse of {@link encodeForJson}: restores `Uint8Array` values. */
export function decodeFromJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeFromJson);
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === BINARY_MARKER && typeof value[BINARY_MARKER] === 'string') {
      return base64ToU8(value[BINARY_MARKER]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeFromJson(v);
    return out;
  }
  return value;
}

/** Encode a whole `WorkbookData.metadata` record for the wire. */
export function encodeMetadataForJson(metadata: Record<string, unknown>): Record<string, unknown> {
  return encodeForJson(metadata) as Record<string, unknown>;
}

/** Decode a wire metadata record back to adapter shape. */
export function decodeMetadataFromJson(metadata: Record<string, unknown>): Record<string, unknown> {
  return decodeFromJson(metadata) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-cell format codes: run-length wire encoding
// ---------------------------------------------------------------------------

/**
 * Wire shape for `SheetData.formats`: a code table plus, per column,
 * `[startRow, endRow, codeIndex]` runs (rows inclusive, ascending).
 */
export interface FormatsWire {
  codes: string[];
  /** Column index → runs of [startRow, endRow, codeIndex]. */
  columns: Record<string, Array<[number, number, number]>>;
}

/** Encode a `SheetData.formats` record (`"row:col" → code`) for the wire. */
export function encodeFormatsRecord(formats: Record<string, string> | undefined): FormatsWire {
  const codes: string[] = [];
  const codeIndex = new Map<string, number>();
  const idxOf = (code: string): number => {
    let i = codeIndex.get(code);
    if (i === undefined) {
      i = codes.length;
      codes.push(code);
      codeIndex.set(code, i);
    }
    return i;
  };
  const byCol = new Map<number, Array<{ row: number; code: number }>>();
  if (formats) {
    for (const [key, code] of Object.entries(formats)) {
      if (typeof code !== 'string' || code === '') continue;
      const sep = key.indexOf(':');
      if (sep <= 0) continue;
      const row = Number(key.slice(0, sep));
      const col = Number(key.slice(sep + 1));
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
      const list = byCol.get(col) ?? [];
      list.push({ row, code: idxOf(code) });
      byCol.set(col, list);
    }
  }
  const columns: FormatsWire['columns'] = {};
  for (const [col, cells] of byCol) {
    cells.sort((a, b) => a.row - b.row);
    const runs: Array<[number, number, number]> = [];
    for (const cell of cells) {
      const last = runs[runs.length - 1];
      if (last && last[2] === cell.code && last[1] === cell.row - 1) {
        last[1] = cell.row;
      } else {
        runs.push([cell.row, cell.row, cell.code]);
      }
    }
    columns[String(col)] = runs;
  }
  return { codes, columns };
}

/** Decode a {@link FormatsWire} back to the `"row:col" → code` record. */
export function decodeFormatsWire(wire: FormatsWire | undefined): Record<string, string> | undefined {
  if (!wire || !Array.isArray(wire.codes) || typeof wire.columns !== 'object' || wire.columns === null) {
    return undefined;
  }
  const out: Record<string, string> = {};
  let any = false;
  for (const [colKey, runs] of Object.entries(wire.columns)) {
    const col = Number(colKey);
    if (!Number.isInteger(col) || col < 0 || !Array.isArray(runs)) continue;
    for (const run of runs) {
      if (!Array.isArray(run) || run.length !== 3) continue;
      const [start, end, ci] = run as [number, number, number];
      const code = wire.codes[ci];
      if (typeof code !== 'string') continue;
      for (let r = start; r <= end; r++) {
        out[`${r}:${col}`] = code;
        any = true;
      }
    }
  }
  return any ? out : undefined;
}
