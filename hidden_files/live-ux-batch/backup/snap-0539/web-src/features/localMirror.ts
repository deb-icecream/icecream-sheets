/**
 * Gateway-mode open payload → local structures (Cycle 10, Phase 2).
 *
 * Two reconstructions from the engine service's /load response:
 *
 * 1. `workbookDataFromLoadResult` rebuilds the adapter `WorkbookData`
 *    (rows empty — cell data stays server-side) so the App's hydration
 *    runs the SAME code for gateway and local opens: formats decoded
 *    from the run-length wire form, metadata decoded from its
 *    binary-safe JSON form, defined names carried over.
 *
 * 2. `buildLocalMirror` builds the LOCAL MIRROR engine. ONE FLAG, TWO
 *    CONSEQUENCES (user's final rule, canonical wording in
 *    packages/engine/src/parallel/types.ts): the /load response carries
 *    a complete mirror — every cell's formula + cached value + data
 *    type — ONLY when the auto-flag is OFF (workbook at/below the cell
 *    threshold); the client builds a local engine from it and the local
 *    recalc-routing rules apply. Flag ON: NO mirror ships (values only),
 *    the client cannot recalc anything, and every edit routes to the
 *    server — local routing rules are never even evaluated. The mirror
 *    payload is distinct from the progressive display stream: the view
 *    renders viewport-first from server reads; the mirror is a
 *    complete engine-build payload, present or absent by the one flag.
 */
import {
  EngineHost,
  EngineWorkbook,
  type CellInput,
  type EngineLoadResult as DesktopEngineLoadResult,
  type WorkbookData,
} from '@icecream-sheets/engine';
import { decodeFormatsWire, decodeMetadataFromJson } from '@icecream-sheets/xlsx-adapter';
import type { EngineLoadResult } from '../services/engineTransport';
import { externalLinksFromWorkbookData, importedPivotsFromWorkbookData } from '../io';

/** Rebuild the hydration-facing WorkbookData from a /load response. */
export function workbookDataFromLoadResult(result: EngineLoadResult): WorkbookData {
  return {
    sheets: result.file.sheets.map((s) => ({
      name: s.name,
      rows: [],
      formats: decodeFormatsWire(s.formats),
      ...(s.styles ? { styles: s.styles } : {}),
      ...(s.colWidths ? { colWidths: s.colWidths } : {}),
      ...(s.rowHeights ? { rowHeights: s.rowHeights } : {}),
      ...(s.hiddenCols ? { hiddenCols: s.hiddenCols } : {}),
      ...(s.hiddenRows ? { hiddenRows: s.hiddenRows } : {}),
    })),
    metadata: decodeMetadataFromJson(result.file.metadata),
    ...(result.file.definedNames ? { definedNames: result.file.definedNames } : {}),
  };
}

/**
 * Rebuild the hydration-facing WorkbookData from a DESKTOP load result
 * (the engine package's EngineLoadResult: per-sheet summaries from the
 * main process's summarizeSheet — formats + full styles + dimensions,
 * rows never cross IPC). Same contract as workbookDataFromLoadResult
 * above, for the IPC summary shape: the App's hydration
 * (importedFormatsToStore) seeds the renderer's FormatStore from
 * `formats`/`styles` here — if either is dropped in this reconstruction,
 * a desktop open renders imported bold / number formats plain
 * (defect E2, W10 R1b).
 */
export function workbookDataFromDesktopLoadResult(result: DesktopEngineLoadResult): WorkbookData {
  return {
    sheets: result.sheets.map((s) => ({
      name: s.name,
      rows: [],
      formats: s.formats,
      ...(s.styles ? { styles: s.styles } : {}),
      colWidths: s.colWidths,
      rowHeights: s.rowHeights,
      hiddenCols: s.hiddenCols,
      hiddenRows: s.hiddenRows,
    })),
    metadata: result.metadata,
    definedNames: result.definedNames,
  };
}

/** The mirror as adapter-shaped sheets (rows reconstructed from cells). */
export function mirrorSheetsAsRows(
  result: EngineLoadResult,
): Record<string, CellInput[][]> {
  const initial: Record<string, CellInput[][]> = {};
  for (const sheet of result.mirror?.sheets ?? []) {
    let maxRow = -1;
    for (const c of sheet.cells) if (c.row > maxRow) maxRow = c.row;
    const rows: CellInput[][] = [];
    for (let r = 0; r <= maxRow; r++) rows.push([]);
    for (const c of sheet.cells) {
      const row = rows[c.row]!;
      while (row.length <= c.col) row.push(null);
      row[c.col] = c.input;
    }
    initial[sheet.name] = rows;
  }
  return initial;
}

/**
 * A WorkbookData whose sheets carry the mirror's rows — used for the
 * browser-side cube/pivot registration the mirror engine needs (the
 * registries live in whichever process runs an engine; the mirror is an
 * engine too, and it must resolve the same GETPIVOTDATA/CUBE* calls).
 */
export function mirrorWorkbookData(result: EngineLoadResult): WorkbookData | null {
  if (!result.mirror) return null;
  const data = workbookDataFromLoadResult(result);
  const rowsBySheet = mirrorSheetsAsRows(result);
  return {
    ...data,
    sheets: data.sheets.map((s) => ({ ...s, rows: rowsBySheet[s.name] ?? [] })),
  };
}

/**
 * Build the local mirror engine from a /load response, or null when the
 * response carries no mirror (flag ON — server calc only). The mirror
 * workbook is built with the same options as the server's (defined
 * names, external links, imported pivot layouts), so local evaluation
 * matches server evaluation cell-for-cell.
 */
export function buildLocalMirror(result: EngineLoadResult): EngineHost | null {
  if (!result.mirror) return null;
  const data = workbookDataFromLoadResult(result);
  const workbook = new EngineWorkbook(mirrorSheetsAsRows(result), {
    definedNames: result.mirror.definedNames ?? data.definedNames,
    externalLinks: externalLinksFromWorkbookData(data),
    importedPivots: importedPivotsFromWorkbookData(data),
  });
  return new EngineHost(workbook);
}
