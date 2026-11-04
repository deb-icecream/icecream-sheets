/**
 * Production document binding: an add-on DocumentBinding over a live
 * EngineHost (design-docs/add-on-model.md §5).
 *
 * This is the binding hosts use when the engine runs in the same process
 * as the add-on service (desktop main process, Node-hosted web). Every
 * read goes through host.readCell()/readRange() — the typed computational
 * view through authorize(), so per-cell permission checks, hidden-cell
 * filtering and #PERM! semantics are exactly the same code path the UI
 * uses. Every write goes through host.execute() with the granting user's
 * auth, so cell.write authorization applies. The granting user's principal
 * (plus the add-on identity as `addon:<id>` in the grants field) travels in
 * the auth context on every call — the add-on never elevates.
 *
 * Value coercion is fail-safe: error values (including #PERM! from a denied
 * read) and images never cross the add-on boundary — they read as null.
 *
 * Engine core is unchanged: this module consumes only the engine's public
 * API (EngineHost, TypedValue).
 */

import {
  AddonAuthError,
  type CellAddress,
  type CellValue,
  type DocumentBinding,
  type RangeAddress,
} from './bindings.js';
import type {
  AuthContext,
  EngineHost,
  TypedValue,
} from '@icecream-sheets/engine';

export interface EngineDocumentBindingOptions {
  /** The granting user's principal — carried through every authorize(). */
  principal: string;
  /** The add-on's id — travels as `addon:<id>` in the auth context grants. */
  addonId: string;
}

/** Coerce a TypedValue to a CellValue. Errors and images never cross. */
function toCellValue(v: TypedValue): CellValue {
  if (v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean' || v.kind === 'null') {
    return v.value;
  }
  // 'error' (incl. #PERM! from authorize()/hidden checks) and 'image':
  // unreadable to the add-on — null, never a leak and never a fake value
  // the add-on could mistake for real data in a way that matters... note
  // the add-on can distinguish "empty" from "denied" only via the op
  // succeeding with null, which is the documented safe projection.
  return null;
}

/**
 * Build a DocumentBinding over a live EngineHost.
 *
 * @param documentId the bound document's id (matches the grant's documentId)
 * @param host the open workbook's EngineHost
 * @param opts principal + add-on identity for the auth context
 */
export function createEngineDocumentBinding(
  documentId: string,
  host: EngineHost,
  opts: EngineDocumentBindingOptions,
): DocumentBinding {
  if (!opts || typeof opts.principal !== 'string' || opts.principal.length === 0) {
    throw new AddonAuthError('invalid-args', 'engine binding requires a non-empty principal (fail closed)');
  }
  const auth: AuthContext = {
    principal: opts.principal,
    grants: [`addon:${opts.addonId}`],
  };
  const refOf = (a: CellAddress) => ({ sheet: a.sheet, row: a.row, col: a.col });

  return {
    documentId,
    listSheets: () => host.snapshot().sheets.map((s) => s.name),
    readCell: (a: CellAddress) => toCellValue(host.readCell(refOf(a), auth)),
    readRange: (r: RangeAddress) =>
      host
        .readRange(
          {
            sheet: r.sheet,
            startRow: r.startRow,
            startCol: r.startCol,
            endRow: r.endRow,
            endCol: r.endCol,
          },
          auth,
        )
        .map((row) => row.map(toCellValue)),
    writeCell: (a: CellAddress, value: CellValue) => {
      const result = host.execute({ cmd: 'setCell', ref: refOf(a), value, auth });
      if (!result.ok) {
        throw new AddonAuthError('denied', `engine refused write: ${result.error}`);
      }
    },
    writeRange: (r: RangeAddress, values: CellValue[][]) => {
      values.forEach((rowVals, i) => {
        rowVals.forEach((v, j) => {
          const result = host.execute({
            cmd: 'setCell',
            ref: { sheet: r.sheet, row: r.startRow + i, col: r.startCol + j },
            value: v,
            auth,
          });
          if (!result.ok) {
            throw new AddonAuthError('denied', `engine refused write: ${result.error}`);
          }
        });
      });
    },
  };
}
