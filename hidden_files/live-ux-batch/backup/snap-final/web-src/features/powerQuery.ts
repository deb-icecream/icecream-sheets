/**
 * Power Query basics (track 6 `power-query`): import data from CSV/JSON/URL,
 * apply shaping steps (filter, select, rename, type, dedupe, sort), and load
 * the result into the sheet. Pure logic — no DOM.
 */

export type PQStep =
  | { kind: 'filter'; column: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt'; value: string }
  | { kind: 'select'; columns: string[] }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'setType'; column: string; type: 'text' | 'number' | 'date' | 'boolean' }
  | { kind: 'removeDuplicates'; columns: string[] }
  | { kind: 'sort'; column: string; dir: 'asc' | 'desc' };

export interface PQTable {
  headers: string[];
  rows: string[][];
}

export const EMPTY_TABLE: PQTable = { headers: [], rows: [] };

/** Parse CSV text (handles quoted fields with commas and escaped quotes). */
export function parseCSV(text: string): PQTable {
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
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\r') {
      // skip, \n handles it
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return EMPTY_TABLE;
  const headers = nonEmpty[0].map((h, i) => (h.trim() === '' ? `Column${i + 1}` : h.trim()));
  return { headers, rows: nonEmpty.slice(1) };
}

/** Parse a JSON array of objects into a table. Also accepts {data:[...]} wrappers. */
export function parseJSONRecords(text: string): PQTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }
  let arr: unknown = parsed;
  if (!Array.isArray(arr) && typeof arr === 'object' && arr !== null) {
    const obj = arr as Record<string, unknown>;
    const firstArray = Object.values(obj).find((v) => Array.isArray(v));
    if (firstArray) arr = firstArray;
  }
  if (!Array.isArray(arr) || arr.length === 0) return EMPTY_TABLE;
  const headers: string[] = [];
  for (const item of arr) {
    if (typeof item === 'object' && item !== null) {
      for (const k of Object.keys(item as Record<string, unknown>)) {
        if (!headers.includes(k)) headers.push(k);
      }
    }
  }
  if (headers.length === 0) {
    return { headers: ['Value'], rows: (arr as unknown[]).map((v) => [String(v ?? '')]) };
  }
  const rows = (arr as Record<string, unknown>[]).map((item) =>
    headers.map((h) => {
      const v = (item as Record<string, unknown>)[h];
      return v === null || v === undefined ? '' : String(v);
    }),
  );
  return { headers, rows };
}

function colIndex(table: PQTable, name: string): number {
  const i = table.headers.indexOf(name);
  if (i < 0) throw new Error(`Unknown column: ${name}`);
  return i;
}

function compareValues(a: string, b: string): number {
  const na = Number(a); const nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Apply one shaping step to a table. */
export function applyStep(table: PQTable, step: PQStep): PQTable {
  switch (step.kind) {
    case 'filter': {
      const i = colIndex(table, step.column);
      const rows = table.rows.filter((r) => {
        const v = r[i] ?? '';
        switch (step.op) {
          case 'eq': return v === step.value;
          case 'neq': return v !== step.value;
          case 'contains': return v.toLowerCase().includes(step.value.toLowerCase());
          case 'gt': return compareValues(v, step.value) > 0;
          case 'lt': return compareValues(v, step.value) < 0;
        }
      });
      return { headers: table.headers, rows };
    }
    case 'select': {
      const idx = step.columns.map((c) => colIndex(table, c));
      return {
        headers: idx.map((i) => table.headers[i]),
        rows: table.rows.map((r) => idx.map((i) => r[i] ?? '')),
      };
    }
    case 'rename': {
      return {
        headers: table.headers.map((h) => (h === step.from ? step.to : h)),
        rows: table.rows,
      };
    }
    case 'setType': {
      const i = colIndex(table, step.column);
      const rows = table.rows.map((r) => {
        const v = r[i] ?? '';
        let nv = v;
        if (step.type === 'number') {
          const n = Number(v.replace(/[$,]/g, ''));
          nv = v.trim() === '' || Number.isNaN(n) ? v : String(n);
        } else if (step.type === 'boolean') {
          const l = v.trim().toLowerCase();
          nv = ['true', 'yes', '1'].includes(l) ? 'TRUE' : ['false', 'no', '0'].includes(l) ? 'FALSE' : v;
        } else if (step.type === 'date') {
          const d = new Date(v);
          nv = Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
        }
        const nr = [...r]; nr[i] = nv; return nr;
      });
      return { headers: table.headers, rows };
    }
    case 'removeDuplicates': {
      const idx = step.columns.length > 0 ? step.columns.map((c) => colIndex(table, c))
        : table.headers.map((_, i) => i);
      const seen = new Set<string>();
      const rows = table.rows.filter((r) => {
        const key = idx.map((i) => r[i] ?? '').join('\u0001');
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      return { headers: table.headers, rows };
    }
    case 'sort': {
      const i = colIndex(table, step.column);
      const rows = [...table.rows].sort((a, b) => {
        const c = compareValues(a[i] ?? '', b[i] ?? '');
        return step.dir === 'asc' ? c : -c;
      });
      return { headers: table.headers, rows };
    }
  }
}

/** Apply a sequence of steps. */
export function applySteps(table: PQTable, steps: PQStep[]): PQTable {
  return steps.reduce((t, s) => applyStep(t, s), table);
}

/** Human-readable label for a step (for the step editor list). */
export function stepLabel(step: PQStep): string {
  switch (step.kind) {
    case 'filter': return `Filter ${step.column} ${step.op} "${step.value}"`;
    case 'select': return `Keep columns: ${step.columns.join(', ')}`;
    case 'rename': return `Rename ${step.from} → ${step.to}`;
    case 'setType': return `Set ${step.column} to ${step.type}`;
    case 'removeDuplicates': return `Remove duplicates${step.columns.length ? ` on ${step.columns.join(', ')}` : ''}`;
    case 'sort': return `Sort ${step.column} ${step.dir === 'asc' ? '↑' : '↓'}`;
  }
}

/** Convert a table to a 2D array including the header row (for loading into the sheet). */
export function tableToGrid(table: PQTable): string[][] {
  return [table.headers, ...table.rows];
}
