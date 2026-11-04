import { type SheetRowChunk } from '@icecream-sheets/xlsx-adapter';
import type { DefinedName, WorkbookData } from '@icecream-sheets/engine';
export interface LoadMeta {
    sheets: string[];
    definedNames?: DefinedName[];
    /** Zip-level metadata families (the same record /load returns). */
    metadata: Record<string, unknown>;
    totalSheets: number;
    /**
     * Progress denominator: used-range cell count summed from each sheet's
     * <dimension> (includes empty cells inside the used range — the count
     * knowable immediately after unzip). The exact non-empty total rides
     * the stream's data-done event.
     */
    totalCellsEstimate: number | null;
    totalSheetXmlBytes: number;
}
export interface LoadParseEvents {
    onMeta?: (meta: LoadMeta) => void;
    onSheetChunk?: (sheetIndex: number, chunk: SheetRowChunk) => void;
    onSheetDone?: (sheetIndex: number, info: {
        rows: number;
        cols: number;
        cellCount: number;
    }) => void;
}
export interface ParseTimings {
    unzipMs: number;
    sharedInputsMs: number;
    metaMs: number;
    sheetParseMs: number;
    /** Time from parse start until sheet 1's parse completed (null if none). */
    firstSheetReadyMs: number | null;
    assembleMs: number;
    totalMs: number;
    path: 'parallel' | 'inline' | 'sheetjs-fallback';
    workers: number;
    fallbackReason?: string;
}
export interface ParseOutcome {
    data: WorkbookData;
    timings: ParseTimings;
    /** Exact non-empty cell total across all sheets. */
    exactTotalCells: number;
}
export declare function parseWorkbookFast(bytes: Uint8Array, events?: LoadParseEvents): Promise<ParseOutcome>;
