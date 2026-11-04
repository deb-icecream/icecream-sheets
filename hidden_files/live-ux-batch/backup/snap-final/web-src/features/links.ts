/**
 * Cell hyperlinks for the Insert > Links group.
 *
 * UI-layer state (like comments and CF rules): a Map keyed by
 * `${sheet}:${row}:${col}`. Rendering (blue underline, click-to-follow)
 * and persistence happen in the app shell; this module owns the store
 * shape and range operations.
 */

export type LinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'email'; email: string; subject?: string }
  | { kind: 'place'; sheet: string; ref: string };

export interface Hyperlink {
  target: LinkTarget;
  /** Override text shown in the cell; defaults to the target. */
  display?: string;
  tooltip?: string;
}

export type HyperlinkStore = Map<string, Hyperlink>;

/** Storage key for a cell's hyperlink. */
export function hyperlinkKey(sheet: string, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/** The hyperlink on a cell, or undefined when none exists. */
export function getHyperlink(
  store: HyperlinkStore,
  sheet: string,
  row: number,
  col: number,
): Hyperlink | undefined {
  return store.get(hyperlinkKey(sheet, row, col));
}

/** Return a new store with the cell's hyperlink set. */
export function setHyperlink(
  store: HyperlinkStore,
  sheet: string,
  row: number,
  col: number,
  link: Hyperlink,
): HyperlinkStore {
  const next = new Map(store);
  next.set(hyperlinkKey(sheet, row, col), link);
  return next;
}

/** Return a new store with the cell's hyperlink removed. */
export function removeHyperlink(
  store: HyperlinkStore,
  sheet: string,
  row: number,
  col: number,
): HyperlinkStore {
  const next = new Map(store);
  next.delete(hyperlinkKey(sheet, row, col));
  return next;
}

export interface LinkRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** All hyperlinks inside a rectangular range. */
export function hyperlinksInRange(
  store: HyperlinkStore,
  sheet: string,
  range: LinkRange,
): { row: number; col: number; link: Hyperlink }[] {
  const out: { row: number; col: number; link: Hyperlink }[] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const link = store.get(hyperlinkKey(sheet, r, c));
      if (link) out.push({ row: r, col: c, link });
    }
  }
  return out;
}

/** Return a new store with every hyperlink in the range removed. */
export function clearHyperlinksInRange(
  store: HyperlinkStore,
  sheet: string,
  range: LinkRange,
): HyperlinkStore {
  const next = new Map(store);
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      next.delete(hyperlinkKey(sheet, r, c));
    }
  }
  return next;
}

/** Human-readable destination, e.g. for the Recent Items list. */
export function linkDestination(link: Hyperlink): string {
  switch (link.target.kind) {
    case 'url':
      return link.target.url;
    case 'email':
      return `mailto:${link.target.email}`;
    case 'place':
      return `${link.target.sheet}!${link.target.ref}`;
  }
}

/** Validate a target before insert; returns an error string or null. */
export function validateLinkTarget(target: LinkTarget): string | null {
  if (target.kind === 'url') {
    if (!/^https?:\/\//i.test(target.url.trim())) {
      return 'URL must start with http:// or https://';
    }
    return null;
  }
  if (target.kind === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email.trim())) {
      return 'Enter a valid email address.';
    }
    return null;
  }
  if (!target.ref.trim()) return 'Enter a cell reference (e.g. A1).';
  return null;
}
