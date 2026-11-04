/**
 * Whole-workbook state checksum over the engine's bulk readback
 * (W21 save-worker verification).
 *
 * The live engine computes this over its OWN state at save handoff;
 * the save worker computes the identical checksum over its REBUILT
 * state (source bytes + replayed op journal) and must match before a
 * single output byte is produced.
 *
 * The serialization is the engine's ack-checksum contract
 * (ack-checksum.ts) — sorted refs, one typed-value line per cell,
 * lines joined by U+0003 — but the DIGEST is SHA-256, streamed
 * line-by-line through node's native hash. Two reasons, both
 * measured at P95 scale (1.8M cells, ~70 MB of line text):
 *  - computeAckChecksum materializes every line plus their join
 *    (~150 MB of strings) — itself a save-class transient;
 *  - its FNV-1a loop is one BigInt multiply per byte (~70 s here),
 *    which alone would dominate the save wall.
 * The ack path's per-edit sets are small and keep FNV (theirs is a
 * different comparison); for this whole-workbook gate both sides use
 * THIS function, so the comparison is exact — and SHA-256 is the
 * stronger divergence detector. The bulk readback arrives grouped
 * by sheet in workbook order with cells row-major; the ack contract
 * sorts by (sheet, row, col), so each sheet's cells are hashed in
 * row/col order and the SHEETS are visited in name order.
 */
import { createHash } from 'node:crypto';
import { serializeAckValue } from '@icecream-sheets/engine';
/** The checksum over an already-materialized bulk readback. */
export function checksumFromBulk(bulk) {
    // Group cell indices by sheet (bulk order is workbook sheet order,
    // row-major within a sheet — the sort below makes that an
    // implementation detail rather than a precondition).
    const bySheet = new Map();
    for (const cell of bulk) {
        let arr = bySheet.get(cell.ref.sheet);
        if (!arr) {
            arr = [];
            bySheet.set(cell.ref.sheet, arr);
        }
        arr.push({ row: cell.ref.row, col: cell.ref.col, value: cell.value });
    }
    const hash = createHash('sha256');
    let first = true;
    for (const sheet of [...bySheet.keys()].sort()) {
        const cells = bySheet.get(sheet);
        cells.sort((a, b) => a.row - b.row || a.col - b.col);
        for (const cell of cells) {
            if (!first)
                hash.update('\u0003');
            first = false;
            hash.update(`${sheet}\u0001${cell.row}\u0001${cell.col}\u0002${serializeAckValue(cell.value)}`);
        }
    }
    return hash.digest('hex');
}
export function bulkStateChecksum(host, principal) {
    return checksumFromBulk(host.bulkReadback({ principal }));
}
