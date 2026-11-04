/**
 * Ack checksum for routed edits — Cycle 10 closure pass (edit-path
 * optimization (b): CHEAPER ACK).
 *
 * HYBRID-CONSISTENCY.md §2 step 3 originally had the client fetch the
 * server's ack VALUES for [edited ref + all dependents] after a
 * local-route calc and compare them against its provisional values. This
 * module replaces the value COMPARISON with a checksum comparison over
 * the SAME values: the server ack for a routed edit carries
 * `{ revision, changedCellCount, checksum }`, the client computes the
 * same checksum over its local results, and only a MISMATCH falls back
 * to the full value fetch with server-wins resolution — exactly the old
 * divergence behavior. The divergence guarantee is IDENTICAL: any real
 * divergence is still detected and resolved server-wins; only the
 * comparison encoding changed (see HYBRID-CONSISTENCY.md §2 amendment).
 *
 * ## The affected set (identical on both sides, by construction)
 *
 * The set is [edited ref, ...dependents] where dependents are the CELLS
 * of `measureCalcChain(editedRef)` measured on the PRE-edit graph (named
 * expressions excluded — they are not cells and carry no value of their
 * own; any value change they mediate appears in a dependent cell). The
 * client derives it from its mirror's measurement; the server derives it
 * from its own measurement of the same graph. Identical graphs →
 * identical sets. Both sides then SORT the set by (sheet, row, col)
 * before hashing, so BFS discovery order can never cause a false
 * mismatch.
 *
 * ## Value serialization (the contract both sides implement)
 *
 * One line per cell, cells in sorted order, lines joined by U+0003:
 *
 *   line  = sheet U+0001 row U+0001 col U+0002 value
 *   value = "n:" <number>          number via JS String(n) (shortest
 *                                  round-trip; -0 → "0", NaN → "NaN",
 *                                  Infinity → "Infinity" — identical in
 *                                  every JS runtime)
 *         | "s:" <len> ":" <raw>   string, length-prefixed (UTF-16 code
 *                                  units) so separator bytes inside the
 *                                  string can never alias another cell
 *         | "b:1" | "b:0"          boolean
 *         | "z:"                   null / empty cell
 *         | "e:" <code>            error, by code (message excluded: it
 *                                  is presentation, not value identity)
 *         | "i:" <len> ":" <src>   image, by source (alt/sizing are
 *                                  presentation, not value identity)
 *
 * A cell missing from a side's value map serializes as "z:" (empty) —
 * the same value an authoritative read of an empty cell returns.
 *
 * ## Hash
 *
 * FNV-1a 64-bit over the UTF-8 encoding of the joined string, rendered
 * as 16 lowercase hex digits. Deterministic across processes and
 * platforms (BigInt arithmetic, no platform float involved). This is a
 * divergence DETECTOR over values two identical engines computed, not a
 * security primitive: a collision would need the two engines to disagree
 * on values whose serializations collide, and the fallback story is
 * unchanged (the value comparison it replaces had the same trust model).
 */
import type { CellRef, TypedValue } from './types.js';

/** The server ack payload for a routed edit (HYBRID-CONSISTENCY.md §2). */
export interface EditAck {
  /** Server revision: one integer per accepted edit op, per workbook. */
  revision: number;
  /** Size of the affected set the checksum covers (edited + dependents). */
  changedCellCount: number;
  /** FNV-1a 64 checksum of the affected cells' post-edit values. */
  checksum: string;
}

/** Serialize one TypedValue per the contract above. */
export function serializeAckValue(v: TypedValue | undefined): string {
  if (v === undefined || v === null) return 'z:';
  switch (v.kind) {
    case 'number':
      return `n:${String(v.value as number)}`;
    case 'string': {
      const s = v.value as string;
      return `s:${s.length}:${s}`;
    }
    case 'boolean':
      return v.value ? 'b:1' : 'b:0';
    case 'null':
      return 'z:';
    case 'error':
      return `e:${v.code}`;
    case 'image':
      return `i:${v.src.length}:${v.src}`;
    default:
      // Unknown future kind: fall back to its JSON form, length-prefixed.
      return `u:${JSON.stringify(v)}`;
  }
}

/**
 * Serialize a cell INPUT (formula text or literal — the `CellInput`
 * contract: string | number | boolean | null) for checksum purposes.
 *
 * Used by the gateway's full-state checkpoint/rehydrate checksum for
 * VOLATILE-TAINTED cells (issue #67): their computed values are a
 * function of wall-clock time / randomness and can never match across
 * a rebuild, so the checksum covers the cell's input — deterministic,
 * and round-tripped verbatim through the snapshot bytes — in place of
 * its value. The `IN:` tag is deliberately outside every tag
 * serializeAckValue can emit (n:/s:/b:/z:/e:/i:/u:), so an input line
 * can never alias a value line.
 */
export function serializeAckInput(input: string | number | boolean | null | undefined): string {
  if (input === undefined || input === null) return 'IN:z:';
  switch (typeof input) {
    case 'string':
      return `IN:s:${input.length}:${input}`;
    case 'number':
      return `IN:n:${String(input)}`;
    case 'boolean':
      return input ? 'IN:b:1' : 'IN:b:0';
    default:
      return `IN:u:${JSON.stringify(input)}`;
  }
}

/** Canonical sort for affected-set refs: sheet, then row, then col. */
export function sortAckRefs(refs: CellRef[]): CellRef[] {
  return [...refs].sort((a, b) =>
    a.sheet < b.sheet ? -1
    : a.sheet > b.sheet ? 1
    : a.row !== b.row ? a.row - b.row
    : a.col - b.col,
  );
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

/** FNV-1a 64-bit of a string's UTF-8 bytes, as 16 lowercase hex digits. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of utf8.encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Checksum of an affected set's values. `values` maps refKey
 * (`${sheet}:${row}:${col}`, the routedEdit refKey format) → TypedValue;
 * refs absent from the map serialize as empty. Both sides MUST pass the
 * same affected set (see header); the set is sorted internally.
 */
export function computeAckChecksum(
  affected: CellRef[],
  values: ReadonlyMap<string, TypedValue>,
): string {
  const lines: string[] = [];
  for (const ref of sortAckRefs(affected)) {
    const key = `${ref.sheet}:${ref.row}:${ref.col}`;
    lines.push(`${ref.sheet}\u0001${ref.row}\u0001${ref.col}\u0002${serializeAckValue(values.get(key))}`);
  }
  return fnv1a64(lines.join('\u0003'));
}
