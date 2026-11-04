/**
 * Table relationships / lightweight data model (Data > Relationships,
 * Manage Data Model).
 *
 * Honest assessment: the engine has no multi-table data model — tables
 * are independent sheets and joins happen through formulas (XLOOKUP etc.)
 * or the pivot layer. Rather than leave Relationships "out of scope",
 * this module implements a real lightweight relationship registry:
 * named table pairs joined on key columns, with a related-column lookup
 * (the moral equivalent of Excel's RELATED()) that the UI and generated
 * formulas can use. The registry persists to the service metadata store
 * (localStorage-backed) following the chartStore.ts pattern.
 */

export interface TableDef {
  /** Table (sheet) name. */
  name: string;
  headers: string[];
  rows: string[][];
}

export interface Relationship {
  id: string;
  /** "Many" side table, e.g. Orders. */
  fromTable: string;
  fromColumn: string;
  /** "One" side table, e.g. Customers. */
  toTable: string;
  toColumn: string;
  createdAt: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'icecream.relationships.v1';

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    return null;
  }
}

function tableByName(tables: TableDef[], name: string): TableDef | undefined {
  return tables.find((t) => t.name === name);
}

function colIndex(table: TableDef, column: string): number {
  return table.headers.findIndex((h) => h === column);
}

/** Validate a candidate relationship against known tables; returns error strings. */
export function validateRelationship(
  rel: Omit<Relationship, 'id' | 'createdAt'>,
  tables: TableDef[],
): string[] {
  const errors: string[] = [];
  const from = tableByName(tables, rel.fromTable);
  const to = tableByName(tables, rel.toTable);
  if (!from) errors.push(`Table "${rel.fromTable}" not found.`);
  if (!to) errors.push(`Table "${rel.toTable}" not found.`);
  if (from && colIndex(from, rel.fromColumn) === -1) {
    errors.push(`Column "${rel.fromColumn}" not found in "${rel.fromTable}".`);
  }
  if (to && colIndex(to, rel.toColumn) === -1) {
    errors.push(`Column "${rel.toColumn}" not found in "${rel.toTable}".`);
  }
  if (rel.fromTable === rel.toTable && rel.fromColumn === rel.toColumn) {
    errors.push('A relationship cannot join a column to itself.');
  }
  return errors;
}

/** Create a relationship after validation; throws with a joined message on failure. */
export function createRelationship(
  spec: Omit<Relationship, 'id' | 'createdAt'>,
  tables: TableDef[],
): Relationship {
  const errors = validateRelationship(spec, tables);
  if (errors.length > 0) throw new Error(errors.join(' '));
  return {
    ...spec,
    id: `rel_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * RELATED()-style lookup: for a key value on the "many" side, return the
 * values of `returnColumn` from matching rows on the "one" side.
 * Returns an empty array when nothing matches.
 */
export function relatedLookup(
  rel: Relationship,
  tables: TableDef[],
  fromKey: string,
  returnColumn: string,
): string[] {
  const to = tableByName(tables, rel.toTable);
  if (!to) throw new Error(`Table "${rel.toTable}" not found.`);
  const keyIdx = colIndex(to, rel.toColumn);
  const retIdx = colIndex(to, returnColumn);
  if (keyIdx === -1) throw new Error(`Key column "${rel.toColumn}" not found in "${rel.toTable}".`);
  if (retIdx === -1) throw new Error(`Column "${returnColumn}" not found in "${rel.toTable}".`);
  return to.rows.filter((r) => r[keyIdx] === fromKey).map((r) => r[retIdx] ?? '');
}

/**
 * Build an XLOOKUP formula that realizes the relationship for one cell:
 * =XLOOKUP(fromCell, ToTable!keyCol, ToTable!returnCol).
 * Column letters are computed from 0-based indexes.
 */
export function relationshipFormula(
  rel: Relationship,
  tables: TableDef[],
  fromCellA1: string,
  returnColumn: string,
): string {
  const to = tableByName(tables, rel.toTable);
  if (!to) throw new Error(`Table "${rel.toTable}" not found.`);
  const keyIdx = colIndex(to, rel.toColumn);
  const retIdx = colIndex(to, returnColumn);
  if (keyIdx === -1 || retIdx === -1) throw new Error('Relationship columns not found.');
  const colLetter = (i: number): string => {
    let n = i;
    let s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };
  const n = to.rows.length + 1; // + header
  return `=XLOOKUP(${fromCellA1},${rel.toTable}!${colLetter(keyIdx)}2:${colLetter(keyIdx)}${n},${rel.toTable}!${colLetter(retIdx)}2:${colLetter(retIdx)}${n})`;
}

// -- Persistence ------------------------------------------------------------

export function loadRelationships(store?: StorageLike): Relationship[] {
  const s = store ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Relationship[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRelationships(rels: Relationship[], store?: StorageLike): void {
  const s = store ?? defaultStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(rels)); } catch { /* storage full */ }
}
