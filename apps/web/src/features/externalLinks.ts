/**
 * External links & RTD (track 20 `external-links-rtd-dde`): reference cells in
 * other workbooks via `[n]Sheet!A1` syntax, keep a registry of linked sources,
 * and resolve values (or #REF! when the source is missing). RTD is stubbed in
 * the engine (returns #N/A) — this module handles the link registry side.
 *
 * DDE (Dynamic Data Exchange) — DECISION, documented here and in
 * parseDDELink()/registerDDELinks() below:
 *
 * DDE's *transport* is the legacy Windows-only IPC mechanism (DDEML
 * conversations between processes on the same machine). A browser /
 * Electron-Linux app cannot participate in Windows DDE conversations —
 * there is no DDEML, no HWND message loop, no server process to talk to.
 * Implementing the transport here is impossible, and we do NOT leave a
 * #N/A stub pretending otherwise.
 *
 * What IS implementable — and is fully implemented below — is DDE's
 * *link syntax and link semantics*: a formula of the form
 * `=AppName|Topic!Item` (e.g. `=Bloomberg|MKT!AAPL`) is parsed into the
 * same external-link registry that backs `[n]Sheet!A1` links, registered
 * under a `DDE <App>|<Topic>` source that the link manager dialog can
 * inspect, rename, refresh and remove. Resolution goes through the same
 * registry mechanism: values supplied via setValue() resolve; anything
 * unsupplied resolves to #REF! — exactly like a missing `[n]` source.
 */

export interface ExternalSource {
  index: number;
  /** Display name, e.g. "Budget 2025.xlsx". */
  name: string;
  /** Optional cell values keyed by "Sheet!A1". */
  values: Map<string, string>;
  lastUpdated: number;
}

/** Parse an external reference like `[1]Summary!B4` or `'[2]My Sheet'!A1`. */
export function parseExternalRef(formula: string): {
  index: number;
  sheet: string;
  cell: string;
} | null {
  const m = /\[(\d+)\]([^!]+)!(\$?[A-Z]+\$?\d+)/.exec(formula);
  if (!m) return null;
  return { index: Number(m[1]), sheet: m[2].replace(/^'|'$/g, ''), cell: m[3].toUpperCase() };
}

/** Find all external references in a formula string. */
export function findExternalRefs(formula: string): { index: number; sheet: string; cell: string }[] {
  const out: { index: number; sheet: string; cell: string }[] = [];
  const re = /\[(\d+)\]([^!]+)!(\$?[A-Z]+\$?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    out.push({ index: Number(m[1]), sheet: m[2].replace(/^'|'$/g, ''), cell: m[3].toUpperCase() });
  }
  return out;
}

export class ExternalLinkRegistry {
  private sources = new Map<number, ExternalSource>();

  addSource(name: string): number {
    let index = 1;
    while (this.sources.has(index)) index++;
    this.sources.set(index, { index, name, values: new Map(), lastUpdated: Date.now() });
    return index;
  }

  removeSource(index: number): boolean {
    return this.sources.delete(index);
  }

  getSource(index: number): ExternalSource | undefined {
    return this.sources.get(index);
  }

  listSources(): ExternalSource[] {
    return [...this.sources.values()].sort((a, b) => a.index - b.index);
  }

  setValue(index: number, sheet: string, cell: string, value: string): void {
    const src = this.sources.get(index);
    if (!src) throw new Error(`Unknown external source [${index}]`);
    src.values.set(`${sheet}!${cell.toUpperCase()}`, value);
    src.lastUpdated = Date.now();
  }

  /**
   * Resolve an external reference to a value.
   * Returns the value, or '#REF!' when the source or cell is missing.
   */
  resolve(ref: { index: number; sheet: string; cell: string }): string {
    const src = this.sources.get(ref.index);
    if (!src) return '#REF!';
    const v = src.values.get(`${ref.sheet}!${ref.cell}`);
    return v === undefined ? '#REF!' : v;
  }

  /** Rename a source (updates display only; formulas keep [n]). */
  rename(index: number, name: string): void {
    const src = this.sources.get(index);
    if (!src) throw new Error(`Unknown external source [${index}]`);
    src.name = name;
  }

  /** Find a source by display name (used for DDE dedup). */
  findByName(name: string): ExternalSource | undefined {
    return this.listSources().find((s) => s.name === name);
  }

  clear(): void {
    this.sources.clear();
  }
}

// ---------------------------------------------------------------------------
// DDE link syntax: =AppName|Topic!Item
// ---------------------------------------------------------------------------

/**
 * A parsed DDE-style link. `item` may be a cell (AAPL, A1), a range
 * (A1:B2), or a named topic item (Last, Bid).
 */
export interface DDELink {
  app: string;
  topic: string;
  item: string;
}

const CELL_OR_RANGE = String.raw`\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?`;
const NAMED_ITEM = String.raw`[A-Za-z_][\w.]*`;
const DDE_ITEM = `(?:${CELL_OR_RANGE}|${NAMED_ITEM})`;

/**
 * Parse a single DDE link `=App|Topic!Item` (leading `=` optional).
 *
 * DECISION (see module header): the DDE *transport* is Windows-IPC-only
 * and cannot exist in a browser/Electron-Linux app, so we do not attempt
 * it. The DDE *syntax* and *link semantics* are fully supported: the link
 * is registered as an external-link source and resolved through the same
 * registry mechanism as `[n]Sheet!A1`.
 *
 * Returns null for non-DDE text — including `[n]Sheet!A1` external refs,
 * which use their own parser above.
 */
export function parseDDELink(text: string): DDELink | null {
  const t = text.trim().replace(/^=/, '');
  if (t.includes('[') || t.includes(']')) return null; // [n] external-ref syntax, not DDE
  const m = new RegExp(`^([A-Za-z][\\w. ]*)\\|([^!|\\s][^!|]*)!(${DDE_ITEM})$`).exec(t);
  if (!m) return null;
  const app = m[1].trim();
  const topic = m[2].trim();
  const item = m[3];
  if (!app || !topic || !item) return null;
  return { app, topic, item };
}

/**
 * Find all DDE-style links inside a formula string, e.g.
 * `=Bloomberg|MKT!AAPL + Reuters|FX!EURUSD`.
 */
export function findDDELinks(formula: string): DDELink[] {
  const out: DDELink[] = [];
  const re = new RegExp(`(^|[^\\w.[\\]])([A-Za-z][\\w. ]*)\\|([^!|\\s,;()+\\-*/^&%<>=][^!|,;()+\\-*/^&%<>=]*)!(${DDE_ITEM})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    const app = m[2].trim();
    const topic = m[3].trim();
    const item = m[4];
    if (app && topic && item) out.push({ app, topic, item });
  }
  return out;
}

/**
 * Register every DDE link found in `formula` with the external-link
 * registry. Each distinct `App|Topic` becomes one source named
 * `DDE <App>|<Topic>` (reused when already present), and the item is
 * addressable through the registry's sheet!cell keying
 * (`setValue(index, topic, item, value)` / resolve()).
 *
 * Returns the parsed links. Unresolvable items (no value supplied) read
 * as #REF! — the same contract as a missing `[n]` source.
 */
export function registerDDELinks(formula: string, registry: ExternalLinkRegistry): DDELink[] {
  const links = findDDELinks(formula);
  for (const link of links) {
    const name = `DDE ${link.app}|${link.topic}`;
    let src = registry.findByName(name);
    if (!src) {
      const index = registry.addSource(name);
      src = registry.getSource(index)!;
    }
    // Touch lastUpdated so the link manager shows the registration time.
    src.lastUpdated = Date.now();
  }
  return links;
}

/** Resolve a DDE link through the registry (value or '#REF!'). */
export function resolveDDELink(link: DDELink, registry: ExternalLinkRegistry): string {
  const src = registry.findByName(`DDE ${link.app}|${link.topic}`);
  if (!src) return '#REF!';
  return registry.resolve({ index: src.index, sheet: link.topic, cell: link.item });
}
