/**
 * Extended Clear commands (Home > Editing > Clear): Clear Comments and
 * Notes, Clear Hyperlinks.
 *
 * Comments and hyperlinks are UI-layer stores (features/comments.ts,
 * features/links.ts); clearing them is a pure store operation. The app has
 * no separate notes model — legacy Excel "notes" are represented by the
 * same comment store, so clearing comments clears both.
 */
import {
  deleteComment,
  type CommentStore,
} from './comments';
import {
  clearHyperlinksInRange,
  type HyperlinkStore,
} from './links';

export interface ClearRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Clear Comments and Notes in a rectangular range. Returns a new store
 * (the input is unchanged) and the number of comments removed.
 */
export function clearCommentsInRange(
  store: CommentStore,
  sheet: string,
  range: ClearRange,
): { store: CommentStore; cleared: number } {
  let next = store;
  let cleared = 0;
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const key = `${sheet}:${r}:${c}`;
      if (next.has(key)) {
        next = deleteComment(next, sheet, r, c);
        cleared++;
      }
    }
  }
  return { store: next, cleared };
}

/**
 * Clear Hyperlinks in a rectangular range. Returns a new store (the input
 * is unchanged) and the number of hyperlinks removed.
 */
export function clearHyperlinks(
  store: HyperlinkStore,
  sheet: string,
  range: ClearRange,
): { store: HyperlinkStore; cleared: number } {
  let cleared = 0;
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      if (store.has(`${sheet}:${r}:${c}`)) cleared++;
    }
  }
  return { store: clearHyperlinksInRange(store, sheet, range), cleared };
}
