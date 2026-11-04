/**
 * Cell notes (Review > Notes) — distinct from threaded comments.
 *
 * Excel keeps notes (legacy cell annotations: author + text + timestamp)
 * separate from threaded comments. This module is the notes model: an
 * immutable-friendly Map keyed by `${sheet}:${row}:${col}`, mirroring
 * features/comments.ts, with Previous/Next navigation in row-major order.
 */

export interface CellNote {
  text: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export type NoteStore = Map<string, CellNote>;

export interface NoteEntry extends CellNote {
  sheet: string;
  row: number;
  col: number;
}

/** Storage key for a cell's note. */
export function noteKey(sheet: string, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/** The note for a cell, or undefined when none exists. */
export function getNote(store: NoteStore, sheet: string, row: number, col: number): CellNote | undefined {
  return store.get(noteKey(sheet, row, col));
}

/** Return a new store with the cell's note set (empty text clears it). */
export function setNote(
  store: NoteStore,
  sheet: string,
  row: number,
  col: number,
  text: string,
  author = 'user',
): NoteStore {
  const next = new Map(store);
  const key = noteKey(sheet, row, col);
  if (text === '') {
    next.delete(key);
    return next;
  }
  const now = new Date().toISOString();
  const prev = next.get(key);
  next.set(key, {
    text,
    author: prev?.author ?? author,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  });
  return next;
}

/** Return a new store with the cell's note removed. */
export function deleteNote(store: NoteStore, sheet: string, row: number, col: number): NoteStore {
  const next = new Map(store);
  next.delete(noteKey(sheet, row, col));
  return next;
}

/** All notes on a sheet, sorted in row-major order. */
export function listNotes(store: NoteStore, sheet: string): NoteEntry[] {
  const out: NoteEntry[] = [];
  for (const [key, note] of store) {
    const [s, r, c] = key.split(':');
    if (s !== sheet) continue;
    out.push({ ...note, sheet: s, row: Number(r), col: Number(c) });
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

/** The next note after (row, col) in row-major order, wrapping around. */
export function nextNote(store: NoteStore, sheet: string, row: number, col: number): NoteEntry | undefined {
  const notes = listNotes(store, sheet);
  if (notes.length === 0) return undefined;
  const after = notes.filter((n) => n.row > row || (n.row === row && n.col > col));
  return after[0] ?? notes[0];
}

/** The previous note before (row, col) in row-major order, wrapping around. */
export function prevNote(store: NoteStore, sheet: string, row: number, col: number): NoteEntry | undefined {
  const notes = listNotes(store, sheet);
  if (notes.length === 0) return undefined;
  const before = notes.filter((n) => n.row < row || (n.row === row && n.col < col));
  return before[before.length - 1] ?? notes[notes.length - 1];
}
