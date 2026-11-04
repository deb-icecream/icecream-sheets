import type { DefinedName, EngineCommand } from '@icecream-sheets/engine';
/**
 * Per-sheet CLIENT-reported save state. The live engine forwards only
 * what the client reported (its session styles / dims overlays); the
 * worker compares them against ITS OWN parse of the source file and
 * decides per sheet whether anything actually changed — the browser
 * reports styles for every sheet (its store is seeded at open), so
 * "reported" must never by itself mean "regenerate": an unchanged
 * sheet is copied byte-for-byte.
 */
export interface SaveWorkerSheetMeta {
    name: string;
    /** True when the client reported this sheet in its session styles. */
    clientStyles: boolean;
    /** The client's per-cell styles ("row:col" -> CellStyle), when reported. */
    styles?: Record<string, import('@icecream-sheets/engine').CellStyle>;
    /** True when the client reported this sheet's dims overlay. */
    clientDims: boolean;
    /** The client's dims overlay for the sheet, when reported. */
    dims?: {
        colWidths?: Record<string, number>;
        rowHeights?: Record<string, number>;
        hiddenCols?: number[];
        hiddenRows?: number[];
    };
}
/** The handoff the live engine writes for one worker save. */
export interface SaveWorkerJob {
    version: 1;
    /** Temp file holding the retained source .xlsx bytes; null = blank workbook. */
    sourcePath: string | null;
    /** Executed mutating ops since the source was loaded, in order. */
    ops: EngineCommand[];
    /** Principal the save is FOR (output is permission-filtered for them). */
    principal: string;
    /** Owner principal (checksum + replay authority). */
    ownerPrincipal: string;
    /** Live engine's whole-state checksum; the worker must reproduce it. */
    expectedChecksum: string;
    /** Final merged defined-names table for the saved file. */
    definedNames: DefinedName[];
    /** Final merged workbook metadata (source + protection + client extras). */
    metadata: Record<string, unknown>;
    sheets: SaveWorkerSheetMeta[];
}
export interface SaveWorkerResult {
    ok: true;
    /** 'verbatim' = streaming verbatim/streaming-writer path; 'adapter-fallback' = in-worker SheetJS write. */
    mode: 'verbatim' | 'adapter-fallback';
    /** Why the shared serializer took the adapter fallback (directSave.ts DirectSaveResult.fallbackReason), when it did. */
    fallbackReason?: string;
    bytes: number;
    changedSheets: string[];
    verbatimParts: number;
    regeneratedParts: string[];
    droppedParts: string[];
    /** Worker's self-sampled peak RSS, MB (its own column — never the engine's). */
    workerPeakRssMb: number;
    workerChecksum: string;
    rebuildMs: number;
    serializeMs: number;
    /** Phase timings inside the rebuild (parse / engine build / replay / checksum). */
    phases?: Record<string, number>;
}
export declare class SaveWorkerError extends Error {
    readonly code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
export interface SaveWorkerSpawnOptions {
    script?: string;
    heapMb: number;
    timeoutMs: number;
    job: SaveWorkerJob;
    /** Source bytes to materialize as the job's sourcePath (engine-retained). */
    sourceBytes?: Uint8Array | null;
    env?: NodeJS.ProcessEnv;
}
/**
 * Resolve the worker entry script. Production: the compiled
 * dist/bin/saveWorker.js next to the compiled services. Source-mode
 * (vitest) runs resolve the package's dist build the same way. An
 * explicit override (deps / ICECREAM_SAVE_WORKER_SCRIPT) wins. Null =
 * no worker available in this layout -> the caller uses the legacy
 * in-engine path (a deployment without the worker build is the only
 * way to reach that; a worker that EXISTS but fails is an error).
 */
export declare function resolveSaveWorkerScript(override?: string): string | null;
/**
 * Spawn one save worker and wait for its result file. Resolves with
 * the output path + parsed result; the caller owns cleanup() (it must
 * run only after the output has been fully streamed/copied out).
 */
export declare function spawnSaveWorker(opts: SaveWorkerSpawnOptions): Promise<{
    outPath: string;
    result: SaveWorkerResult;
    cleanup: () => void;
}>;
/** Directory a job's temp files live in (for tests/diagnostics). */
export declare function saveWorkerTmpRoot(): string;
export declare function saveWorkerScriptDir(script: string): string;
