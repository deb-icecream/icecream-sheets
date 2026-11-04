/**
 * Save-worker core (W21 — P95 save fix): the work that runs INSIDE the
 * per-save worker process (bin/saveWorker.ts), isolated from the live
 * engine by saveWorkerSpawn.ts.
 *
 * Pipeline:
 *  1. REBUILD via the rehydration path: parse the retained source
 *     bytes (the exact bytes /load received) with the same fast parse
 *     the live load used, build a fresh engine workbook from them
 *     (same registrations buildFromData performs), then replay the
 *     session's executed-op journal (the ops the live engine captured
 *     for saves, in order) onto it.
 *  2. VERIFY: compute the whole-state checksum (ack-checksum
 *     machinery over the bulk readback — saveChecksum.ts) and compare
 *     against the live engine's checksum from the handoff. MISMATCH =
 *     abort with an error; no output file is ever emitted from
 *     unverified state.
 *  3. SERIALIZE via the SHARED direct-streaming serializer
 *     (@icecream-sheets/service/save-node — src/save/directSave.ts):
 *     the same module the live engine feeds directly (SAVE
 *     SERIALIZATION INVARIANT: one-pass streaming over the
 *     authoritative model, untouched parts verbatim). The worker
 *     feeds it the rebuilt, checksum-verified bulk readback (the
 *     requesting principal's view) plus its own source parse as
 *     parsedSheets. This worker remains as a non-ordinary fallback:
 *     the guarantee layer (isolation + checksum) still holds; the
 *     serializer code lives in exactly one place.
 *
 * Memory discipline: the parse grids are released the moment the
 * engine build returns (as buildFromData does); checksum structures
 * are scoped and dropped before serialization; inside the serializer,
 * sheet generation holds one sheet's sorted cell list and streams
 * rows out to a temp file; verbatim parts are fed to the zip in
 * 1 MiB slices from the one unzip of the source package.
 */
import { readFileSync, statSync } from 'node:fs';
import { allowAllPolicy, Authorizer, EngineHost, EngineWorkbook, ProtectionManager, } from '@icecream-sheets/engine';
import { PIVOT_TABLES_METADATA_KEY, externalLinksFromMetadata, } from '@icecream-sheets/xlsx-adapter';
import { importedPivotsFromMetadata, registerDataModelCubes, registerImportedPivotsForEngine, } from '@icecream-sheets/service';
import { serializeLiveWorkbook, } from '@icecream-sheets/service/save-node';
import { parseWorkbookFast } from './parallelParse.js';
import { checksumFromBulk } from './saveChecksum.js';
import { OWNER_PRINCIPAL } from './engineSvc.js';
export class SaveChecksumError extends Error {
    code = 'checksum-mismatch';
    constructor(message) {
        super(message);
        this.name = 'SaveChecksumError';
    }
}
/**
 * GC point at phase boundaries (the worker runs with --expose-gc):
 * the rebuild's parse peak and the checksum pass leave multi-hundred-
 * MB transients that must be RETURNED before the next phase's peak —
 * on this 7.7 GiB VM the W21 acceptance runs are a headroom budget,
 * and an unreturned transient is indistinguishable from a leak.
 */
function workerGc() {
    const gc = globalThis.gc;
    if (typeof gc === 'function')
        gc();
}
/** Build a host exactly the way the engine service's wireFresh does. */
function freshHost(workbook) {
    const protection = new ProtectionManager();
    protection.setHiddenExemptPrincipals([OWNER_PRINCIPAL]);
    const authorizer = new Authorizer(protection.protectionPolicy(allowAllPolicy()));
    const host = workbook ? new EngineHost(workbook, authorizer) : new EngineHost(undefined, authorizer);
    host.setHiddenCheck((ref, principal) => protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal));
    return { host, protection };
}
export async function runSaveJob(job, outPath, log = () => undefined) {
    // Self-sampled peak RSS: the worker reports its OWN column of the
    // memory story (the live engine's plateau is measured separately).
    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => {
        const rss = process.memoryUsage().rss;
        if (rss > peakRss)
            peakRss = rss;
    }, 200);
    sampler.unref?.();
    const tRebuild = performance.now();
    const phases = {};
    const mark = (name, since) => {
        const now = performance.now();
        phases[name] = Math.round(now - since);
        return now;
    };
    try {
        // -- 1. rebuild ---------------------------------------------------
        const sourceBytes = job.sourcePath ? readFileSync(job.sourcePath) : null;
        let data = null;
        let host;
        let protection;
        if (sourceBytes) {
            const outcome = await parseWorkbookFast(new Uint8Array(sourceBytes));
            data = outcome.data;
            mark('parseMs', tRebuild);
            registerDataModelCubes(data);
            const initial = {};
            for (const sheet of data.sheets)
                initial[sheet.name] = sheet.rows;
            let workbook;
            try {
                workbook = new EngineWorkbook(initial, {
                    definedNames: data.definedNames,
                    externalLinks: externalLinksFromMetadata(data.metadata),
                    importedPivots: importedPivotsFromMetadata(data.metadata[PIVOT_TABLES_METADATA_KEY]),
                });
            }
            catch (e) {
                throw new Error(`save worker rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            // Release the parsed grids now the engine graph holds the data
            // (the W16 load discipline, applied to the rebuild).
            for (const sheet of data.sheets)
                sheet.rows = [];
            ({ host, protection } = freshHost(workbook));
            registerImportedPivotsForEngine(importedPivotsFromMetadata(data.metadata[PIVOT_TABLES_METADATA_KEY]));
        }
        else {
            ({ host, protection } = freshHost());
        }
        try {
            protection.fromMetadata(job.metadata);
        }
        catch {
            // Protection hydration mirrors the live build: never fatal.
        }
        let tPhase = performance.now();
        phases.buildMs = Math.round(tPhase - tRebuild) - (phases.parseMs ?? 0);
        // Replay the executed-op journal, in order, with owner authority
        // (the ops already executed successfully against the live engine
        // under their own principals; replay reproduces that state).
        for (let i = 0; i < job.ops.length; i++) {
            const op = job.ops[i];
            const result = host.execute({ ...op, auth: { principal: job.ownerPrincipal } });
            if (!result.ok) {
                throw new Error(`save worker journal replay failed at op ${i} (${op.cmd}): ${JSON.stringify(result).slice(0, 200)}`);
            }
        }
        // The parsed WorkbookData has served its purpose (build inputs +
        // presentation records): release the grids before the checksum +
        // serialize phases so its grids never coexist with theirs. The
        // small per-sheet records survive as the serializer's
        // parsedSheets (their keys are the source sheet-name set the
        // verbatim-vs-adapter decision compares against).
        const parsedByName = new Map();
        if (data) {
            for (const s of data.sheets) {
                parsedByName.set(s.name, {
                    ...(s.styles ? { styles: s.styles } : {}),
                    ...(s.formats ? { formats: s.formats } : {}),
                    ...(s.colWidths ? { colWidths: s.colWidths } : {}),
                    ...(s.rowHeights ? { rowHeights: s.rowHeights } : {}),
                    ...(s.hiddenCols ? { hiddenCols: s.hiddenCols } : {}),
                    ...(s.hiddenRows ? { hiddenRows: s.hiddenRows } : {}),
                });
            }
        }
        data = null;
        tPhase = mark('replayMs', tPhase);
        workerGc();
        // -- 2. verify ------------------------------------------------------
        // One bulk pass serves both the checksum and (when the requester
        // IS the owner — the ordinary save) the serialization readback:
        // at P95 scale a bulk pass over 1.8M cells costs ~15 s and tens
        // of MB of line text, and it is never paid twice.
        const ownerBulk = host.bulkReadback({ principal: job.ownerPrincipal });
        tPhase = mark('bulkMs', tPhase);
        const checksum = checksumFromBulk(ownerBulk);
        mark('checksumMs', tPhase);
        if (checksum !== job.expectedChecksum) {
            throw new SaveChecksumError(`save aborted: rebuilt state checksum ${checksum} != live engine checksum ${job.expectedChecksum} (no file emitted)`);
        }
        const rebuildMs = Math.round(performance.now() - tRebuild);
        workerGc();
        // -- 3. serialize ---------------------------------------------------
        // The serialization readback is the REQUESTING principal's view:
        // /download is permission-filtered per principal by design
        // (cells hidden from the requester are dropped from their file —
        // the protection model's per-subject filtered view; the engineSvc
        // suite pins this). The checksum above is the OWNER's view (state
        // truth); the product is the requester's. When the requester IS
        // the owner — the ordinary save — the checksum's bulk pass is
        // reused and the 1.8M-cell pass is paid exactly once.
        const tSerialize = performance.now();
        const bulk = job.principal === job.ownerPrincipal
            ? ownerBulk
            : host.bulkReadback({ principal: job.principal });
        const sheetNames = host.sheetNames();
        // The rebuilt engine graph has served its purpose (replay +
        // verify + readback): release it BEFORE serialization so the
        // serialize phase's allocations (grouped cells, unzipped parts,
        // zip buffers) never stack on top of the ~1.6 GB graph — the
        // worker's peak is the MAX of the phases, not their sum. The
        // bulk readback is detached plain data (input/value payloads),
        // so it survives the host release; the arrays themselves are
        // dropped once the serializer has consumed them.
        host = null;
        protection = null;
        workerGc();
        const direct = serializeLiveWorkbook({
            bulk,
            sheetNames,
            definedNames: job.definedNames,
            metadata: job.metadata,
            sourceBytes,
            parsedSheets: parsedByName,
            sheets: job.sheets,
            ops: job.ops,
            outPath,
            log,
        });
        bulk.length = 0;
        if (bulk !== ownerBulk)
            ownerBulk.length = 0;
        const result = {
            mode: direct.mode,
            ...(direct.fallbackReason ? { fallbackReason: direct.fallbackReason } : {}),
            changedSheets: direct.changedSheets,
            verbatimParts: direct.verbatimParts,
            regeneratedParts: direct.regeneratedParts,
            droppedParts: direct.droppedParts,
        };
        const serializeMs = Math.round(performance.now() - tSerialize);
        return {
            ok: true,
            ...result,
            bytes: statSync(outPath).size,
            workerPeakRssMb: Math.round((peakRss / (1024 * 1024)) * 10) / 10,
            workerChecksum: checksum,
            rebuildMs,
            serializeMs,
            phases,
        };
    }
    finally {
        clearInterval(sampler);
    }
}
