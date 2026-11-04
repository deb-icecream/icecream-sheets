/**
 * Cell comments for the Review tab.
 *
 * The store is an immutable-friendly Map keyed by `${sheet}:${row}:${col}`.
 * setComment/deleteComment return new Maps so React state updates stay pure.
 */

export type CommentStore = Map<string, string>;

/** Storage key for a cell's comment. */
export function commentKey(sheet: string, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/** The comment text for a cell, or undefined when none exists. */
export function getComment(
  store: CommentStore,
  sheet: string,
  row: number,
  col: number,
): string | undefined {
  return store.get(commentKey(sheet, row, col));
}

/** Return a new store with the cell's comment set (empty text clears it). */
export function setComment(
  store: CommentStore,
  sheet: string,
  row: number,
  col: number,
  text: string,
): CommentStore {
  const next = new Map(store);
  if (text === '') {
    next.delete(commentKey(sheet, row, col));
  } else {
    next.set(commentKey(sheet, row, col), text);
  }
  return next;
}

/** Return a new store with the cell's comment removed. */
export function deleteComment(
  store: CommentStore,
  sheet: string,
  row: number,
  col: number,
): CommentStore {
  const next = new Map(store);
  next.delete(commentKey(sheet, row, col));
  return next;
}

/** A comment with its cell location. */
export interface CommentEntry {
  sheet: string;
  row: number;
  col: number;
  text: string;
}

/** All comments on a sheet, sorted in row-major order. */
export function listComments(store: CommentStore, sheet: string): CommentEntry[] {
  const out: CommentEntry[] = [];
  for (const [key, text] of store) {
    const [s, r, c] = key.split(':');
    if (s !== sheet) continue;
    out.push({ sheet: s, row: Number(r), col: Number(c), text });
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

/** The next comment after (row, col) in row-major order, wrapping around. */
export function nextComment(
  store: CommentStore,
  sheet: string,
  row: number,
  col: number,
): CommentEntry | undefined {
  const comments = listComments(store, sheet);
  if (comments.length === 0) return undefined;
  const after = comments.filter((c) => c.row > row || (c.row === row && c.col > col));
  return after[0] ?? comments[0];
}

/** The previous comment before (row, col) in row-major order, wrapping around. */
export function prevComment(
  store: CommentStore,
  sheet: string,
  row: number,
  col: number,
): CommentEntry | undefined {
  const comments = listComments(store, sheet);
  if (comments.length === 0) return undefined;
  const before = comments.filter((c) => c.row < row || (c.row === row && c.col < col));
  return before[before.length - 1] ?? comments[comments.length - 1];
}

/** Return a new store with every comment on the sheet removed. */
export function deleteAllComments(store: CommentStore, sheet: string): CommentStore {
  const next = new Map(store);
  for (const key of [...next.keys()]) {
    if (key.startsWith(`${sheet}:`)) next.delete(key);
  }
  return next;
}

/** Number of comments on a sheet. */
export function countComments(store: CommentStore, sheet: string): number {
  return listComments(store, sheet).length;
}
