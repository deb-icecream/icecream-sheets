/**
 * OLAP data-model cubes rebuilt from worksheet ranges.
 *
 * Files whose data model was built from a worksheet range (ClosedXML
 * "CubeFromRange", Excel "Add this data to the Data Model") carry
 * CUBEVALUE/CUBEMEMBER formulas whose connection (e.g.
 * "ThisWorkbookDataModel") Excel resolves against the model — but the
 * model itself is not in the .xlsx (only xl/connections.xml names the
 * connection and the range connection feeding it). The xlsx-adapter
 * extracts those connections into `xlsx.connections` metadata; this
 * module rebuilds the cube from the source range via the service pivot
 * component and registers it with the engine (`cubeFromPivot` +
 * `registerCube`), so the CUBE* formulas resolve instead of #NAME?.
 *
 * Wiring rule (mirrors the imported-pivot cube registration in App.tsx):
 * for every distinct connection name referenced by a CUBE* formula that
 * is not already registered, build the cube from the connection's source
 * range. The dimension name and member column come from the MDX member
 * expressions in the formulas themselves (e.g.
 * "[Range].[Pastry].&[Baclava]" -> dimension "Range", member column
 * "Pastry"); measures are "Sum of <header>" over the numeric columns,
 * which the engine's measure resolver matches by label or stripped
 * aggregation name.
 *
 * Never throws: cube wiring must never break the open.
 */
import {
  cubeFromPivot,
  listCubes,
  registerCube,
  type OlapCube,
  type SheetData,
  type WorkbookData,
} from '@icecream-sheets/engine';
import {
  CONNECTIONS_METADATA_KEY,
  type ImportedConnection,
} from '@icecream-sheets/xlsx-adapter';
import {
  PIVOT_SPEC_VERSION,
  createPivot,
  recordsFromGrid,
} from '@icecream-sheets/service';

export type { ImportedConnection };

/**
 * Parse the `xlsx.connections` metadata value into ImportedConnection[].
 * Returns [] for missing/corrupt metadata (never throws).
 */
export function connectionsFromMetadata(value: unknown): ImportedConnection[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is ImportedConnection =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as ImportedConnection).name === 'string' &&
        typeof (c as ImportedConnection).isDataModel === 'boolean',
    );
  } catch {
    return [];
  }
}

const CUBE_FN_RE = /\bCUBE[A-Z]*\(\s*/gi;

/** First string-literal argument of every CUBE* call in a formula. */
function connectionNamesInFormula(formula: string): string[] {
  const out: string[] = [];
  CUBE_FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CUBE_FN_RE.exec(formula)) !== null) {
    let i = m.index + m[0].length;
    if (formula[i] !== '"') continue;
    let j = i + 1;
    let name = '';
    while (j < formula.length) {
      const ch = formula[j]!;
      if (ch === '"') {
        if (formula[j + 1] === '"') {
          name += '"';
          j += 2;
          continue;
        }
        break;
      }
      name += ch;
      j += 1;
    }
    out.push(name);
  }
  return out;
}

/**
 * Distinct connection names referenced by CUBE* formulas across the
 * workbook's sheets, in first-seen order.
 */
export function cubeConnectionNamesFromSheets(sheets: SheetData[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (typeof cell !== 'string' || cell.charCodeAt(0) !== 61 /* '=' */) continue;
        for (const name of connectionNamesInFormula(cell)) {
          const key = name.trim().toLowerCase();
          if (key && !seen.has(key)) {
            seen.add(key);
            names.push(name);
          }
        }
      }
    }
  }
  return names;
}

interface DimHint {
  dim: string;
  hier: string;
}

// "[Dim].[Hier].&[Key]" / "[Dim].[Hier].[Member]" / "[Dim].[Hier].[All]".
const MEMBER_EXPR_RE = /\[([^\]]+)\]\.\[([^\]]+)\]\.&?\[([^\]]+)\]/g;

/**
 * (dimension, hierarchy) pairs from the MDX member expressions inside the
 * workbook's CUBE* formulas. The [Measures] pseudo-dimension is excluded.
 */
export function dimensionHintsFromSheets(sheets: SheetData[]): DimHint[] {
  const out: DimHint[] = [];
  const seen = new Set<string>();
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (typeof cell !== 'string' || cell.charCodeAt(0) !== 61) continue;
        MEMBER_EXPR_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = MEMBER_EXPR_RE.exec(cell)) !== null) {
          const dim = m[1]!.trim();
          const hier = m[2]!.trim();
          if (dim.toLowerCase() === 'measures') continue;
          const key = `${dim.toLowerCase()}\u0000${hier.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ dim, hier });
          }
        }
      }
    }
  }
  return out;
}

export interface ParsedRangeRef {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parse an A1 range ref such as "Data!$A$1:$C$4" or
 * "'My Sheet'!$A$1:$C$4" into 0-based indices. Returns null when the ref
 * does not parse.
 */
export function parseRangeRef(ref: string): ParsedRangeRef | null {
  const m =
    /^(?:'((?:[^']|'')+)'|([^'!]+))!(\$?[A-Za-z]{1,3}\$?\d+):(\$?[A-Za-z]{1,3}\$?\d+)$/.exec(
      ref.trim(),
    );
  if (!m) return null;
  const sheet = (m[1] ?? m[2] ?? '').replace(/''/g, "'");
  const cell = (t: string): [number, number] | null => {
    const cm = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(t);
    if (!cm) return null;
    const row = parseInt(cm[4]!, 10) - 1;
    const col = colLettersToIndex(cm[2]!);
    if (row < 0 || col < 0) return null;
    return [row, col];
  };
  const a = cell(m[3]!);
  const b = cell(m[4]!);
  if (!a || !b || sheet === '') return null;
  return {
    sheet,
    startRow: Math.min(a[0], b[0]),
    startCol: Math.min(a[1], b[1]),
    endRow: Math.max(a[0], b[0]),
    endCol: Math.max(a[1], b[1]),
  };
}

/**
 * Build an OLAP cube for a data-model connection from a worksheet range:
 * first row = headers, remaining rows = records, aggregated with the
 * service pivot component (rows=[dimension], no columns, Sum over the
 * numeric columns) and adapted with cubeFromPivot().
 *
 * Returns null when the range cannot be turned into a cube (missing
 * sheet, no header/body, no numeric measure columns, pivot build
 * failure) — the caller then leaves the formulas unresolved rather than
 * registering a wrong cube.
 */
export function buildCubeFromRange(
  sheets: SheetData[],
  rangeRef: string,
  connectionName: string,
): OlapCube | null {
  try {
    const range = parseRangeRef(rangeRef);
    if (!range) return null;
    const sheet = sheets.find(
      (s) => s.name.trim().toLowerCase() === range.sheet.trim().toLowerCase(),
    );
    if (!sheet) return null;
    const grid: unknown[][] = [];
    for (let r = range.startRow; r <= range.endRow; r += 1) {
      const row = sheet.rows[r];
      if (!row) continue;
      grid.push(row.slice(range.startCol, range.endCol + 1));
    }
    // Header row + at least one body row.
    if (grid.length < 2) return null;
    const headers = grid[0]!.map((h) => String(h ?? '').trim());
    if (headers.some((h) => h === '')) return null;
    if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length) {
      return null;
    }
    // Dimension name + member column from the MDX in the CUBE* formulas;
    // fall back to the first column when the formulas say nothing usable.
    let dimName = headers[0]!;
    let memberCol = 0;
    const hints = dimensionHintsFromSheets(sheets);
    const distinctDims = [...new Set(hints.map((h) => h.dim.toLowerCase()))];
    if (distinctDims.length === 1 && hints.length > 0) {
      dimName = hints[0]!.dim;
      const hi = headers.findIndex(
        (h) => h.toLowerCase() === hints[0]!.hier.toLowerCase(),
      );
      if (hi >= 0) memberCol = hi;
    }
    // The dimension must not collide with another header (records are
    // keyed by header; the dimension aliases the member column).
    const dimKey = dimName.toLowerCase();
    if (
      headers.some((h, i) => i !== memberCol && h.toLowerCase() === dimKey)
    ) {
      return null;
    }
    const body = grid
      .slice(1)
      .filter((r) => r.some((v) => v !== null && v !== undefined && v !== ''));
    if (body.length === 0) return null;
    const measureCols: number[] = [];
    headers.forEach((h, i) => {
      if (i === memberCol) return;
      if (body.some((r) => typeof r[i] === 'number')) measureCols.push(i);
    });
    if (measureCols.length === 0) return null;
    const records = recordsFromGrid(headers, body);
    if (dimKey !== headers[memberCol]!.toLowerCase()) {
      for (const rec of records) rec[dimName] = rec[headers[memberCol]!];
    }
    const result = createPivot(records, {
      version: PIVOT_SPEC_VERSION,
      rows: [dimName],
      columns: [],
      values: measureCols.map((i) => ({
        field: headers[i]!,
        aggregation: 'sum' as const,
      })),
    });
    return cubeFromPivot(result, connectionName);
  } catch {
    return null;
  }
}

/**
 * Register OLAP cubes for every CUBE* connection referenced by the
 * workbook's formulas that is not already registered (imported-pivot
 * cubes register first in the open flow and win). Each cube is built
 * from its connection's source range; a data-model connection with no
 * direct range falls back to the file's range connection when there is
 * exactly one. Returns the registered connection names so the host can
 * unregister them when the next file opens. Never throws.
 */
export function registerDataModelCubes(data: WorkbookData): string[] {
  try {
    const conns = connectionsFromMetadata(data.metadata?.[CONNECTIONS_METADATA_KEY]);
    if (conns.length === 0) return [];
    const wanted = cubeConnectionNamesFromSheets(data.sheets);
    if (wanted.length === 0) return [];
    const already = new Set(listCubes().map((n) => n.trim().toLowerCase()));
    const rangeConns = conns.filter((c) => !c.isDataModel && c.rangeRef);
    const registered: string[] = [];
    for (const name of wanted) {
      const key = name.trim().toLowerCase();
      if (already.has(key)) continue;
      const conn = conns.find((c) => c.name.trim().toLowerCase() === key);
      // Only connection-backed names are rebuilt from ranges here. Other
      // CUBE* names (e.g. imported pivot tables, which register their own
      // cubes later in the open flow) are left alone — never shadow them
      // with a range-built cube.
      if (!conn || (!conn.isDataModel && !conn.rangeRef)) continue;
      let rangeRef = conn.rangeRef;
      if (!rangeRef && rangeConns.length === 1) rangeRef = rangeConns[0]!.rangeRef;
      if (!rangeRef) continue;
      const cube = buildCubeFromRange(data.sheets, rangeRef, name);
      if (!cube) continue;
      registerCube(cube);
      registered.push(cube.name);
      already.add(key);
    }
    return registered;
  } catch {
    return [];
  }
}
