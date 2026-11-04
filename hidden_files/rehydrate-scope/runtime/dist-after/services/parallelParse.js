/**
 * Parallel workbook parse for the engine service (Cycle 10 Phase 4).
 *
 * WHY: the SheetJS `XLSX.read` at the heart of XlsxAdapter.read is one
 * monolithic blocking call — measured 19.4s of the 44.7s server-side
 * P95 load on this VM (engine build is the other 25.3s; see
 * perf-evaluation.md). A workbook's sheets, however, are independent
 * ZIP parts. This module splits the parse at the level that CAN split:
 *
 *   1. unzip ONCE on the main thread;
 *   2. parse the two shared inputs ONCE on the main thread — the
 *      shared-string table and the style→format-code table — and share
 *      them with every worker (structured clone), never re-parsed;
 *   3. fan the worksheet parts out to a bounded worker pool
 *      (node:worker_threads, min(cores−1, sheets, 8)) running the same
 *      pure parser the main thread uses inline for single-sheet files;
 *   4. assemble on the main thread through the adapter's shared
 *      post-parse assembly (identical WorkbookData to the SheetJS read).
 *
 * Streaming: callers may pass events — onMeta fires as soon as the unzip
 * + workbook structure + zip-level metadata are known (before ANY sheet
 * is parsed), and per-sheet row chunks fire during each sheet's parse
 * (first chunk = the visible window). Workers may finish out of order;
 * ORDERING of emission is the caller's job (the stream layer emits in
 * sheet order). If anything about the fast path is unsupported for a
 * file, the parse falls back to the SheetJS read — but only before the
 * first chunk has been emitted; after that, a fast-path failure is fatal
 * to the stream rather than a silent duplicate re-emission.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter, builtinFormatTable, convertDimensions, decodeRef, newDimensionContext, parseCustomProperties, parseDefinedNames, parseSharedStrings, parseStyleFormatCodes, parseWorkbookSheetParts, parseWorksheetXml, unzipPackage, } from '@icecream-sheets/xlsx-adapter';
/** Below this total sheet-XML size, worker startup costs more than it saves. */
const WORKER_MIN_TOTAL_BYTES = 1_000_000;
/** Chunk size (rows) for synthesized fallback streams. */
const FALLBACK_CHUNK_ROWS = 4096;
const now = () => performance.now();
const decoder = new TextDecoder();
function dimensionEstimate(partBytes) {
    // <dimension> sits in the first KBs of a worksheet part.
    const head = decoder.decode(partBytes.subarray(0, 8192));
    const m = /<dimension\b[^>]*\bref\s*=\s*"([^"]*)"/.exec(head);
    if (!m)
        return null;
    const parts = m[1].split(':');
    const a = decodeRef(parts[0]);
    const b = decodeRef(parts[parts.length - 1]);
    if (!a || !b)
        return null;
    return (b.r - a.r + 1) * (b.c - a.c + 1);
}
class SheetWorkerPool {
    workers = [];
    idle = [];
    busy = new Map();
    queue = [];
    results = new Map();
    waiters = [];
    failure = null;
    chunkSink;
    doneSink;
    sharedStrings = [];
    styleFormatCodes = [];
    display = false;
    streamChunks = false;
    /** Per-sheet rows assembled from streamed chunks (stream mode). */
    chunkRows = new Map();
    constructor(opts) {
        this.chunkSink = opts.onChunk;
        this.doneSink = opts.onDone;
        const workerUrl = workerScriptUrl();
        // Source-mode probes (no compiled dist): the worker entry is the .ts
        // source and needs the same type-stripping loader the main thread
        // runs under. Production always uses the compiled .js entry.
        const loader = process.env.ICECREAM_WORKER_LOADER;
        const workerOpts = loader !== undefined && workerUrl.pathname.endsWith('.ts')
            ? { execArgv: ['--experimental-transform-types', '--import', loader] }
            : undefined;
        for (let i = 0; i < opts.size; i++) {
            const w = new Worker(workerUrl, workerOpts);
            w.on('message', (msg) => {
                this.onWorkerMessage(w, msg);
            });
            w.on('error', (e) => this.fail(e instanceof Error ? e : new Error(String(e))));
            this.workers.push(w);
            this.idle.push(w);
        }
    }
    /**
     * Two-phase init: workers are spawned by the constructor as early as
     * possible (their module load then overlaps the caller's unzip / metadata
     * / shared-input work — worth ~0.5–0.9 s of first-chunk latency on large
     * workbooks, Cycle 10 P95 TTFP), and the per-parse inputs are supplied
     * here, before run(). The fields are only read at dispatch (pump) and
     * message time, both of which happen after run() is called.
     */
    configure(opts) {
        this.sharedStrings = opts.sharedStrings;
        this.styleFormatCodes = opts.styleFormatCodes;
        this.display = opts.display;
        this.streamChunks = opts.streamChunks;
    }
    onWorkerMessage(w, msg) {
        if (msg.type === 'chunk' && msg.chunk) {
            if (this.streamChunks) {
                const acc = this.chunkRows.get(msg.sheetIndex) ?? [];
                for (const row of msg.chunk.rows)
                    acc.push(row);
                this.chunkRows.set(msg.sheetIndex, acc);
            }
            this.chunkSink(msg.sheetIndex, msg.chunk);
            return;
        }
        const sheetIndex = this.busy.get(w);
        this.busy.delete(w);
        this.idle.push(w);
        if (msg.type === 'error') {
            this.fail(new Error(`sheet parse worker failed (sheet ${msg.sheetIndex}): ${msg.error ?? 'unknown'}`));
            return;
        }
        if (msg.type === 'done' && msg.result && sheetIndex !== undefined) {
            const wire = msg.result;
            // Streamed results carry rows: null on the wire (they travelled as
            // chunks) — by completion time the pool ALWAYS hands consumers a
            // complete FastSheetResult with materialized rows.
            const completed = wire.rows === null
                ? { ...wire, rows: this.chunkRows.get(msg.sheetIndex) ?? [] }
                : { ...wire, rows: wire.rows };
            this.chunkRows.delete(msg.sheetIndex);
            this.results.set(msg.sheetIndex, completed);
            // Completion timestamp for first-sheet metrics belongs here, at
            // sheet-completion time — NOT when the whole pool drains.
            this.doneSink?.(msg.sheetIndex, completed);
        }
        this.pump();
        this.checkWaiters();
    }
    fail(e) {
        if (this.failure)
            return;
        this.failure = e;
        for (const waiter of this.waiters.splice(0))
            waiter.reject(e);
    }
    checkWaiters() {
        if (this.failure)
            return;
        if (this.busy.size === 0 && this.queue.length === 0) {
            for (const waiter of this.waiters.splice(0))
                waiter.resolve();
        }
    }
    pump() {
        while (!this.failure && this.idle.length > 0 && this.queue.length > 0) {
            const w = this.idle.pop();
            const task = this.queue.shift();
            this.busy.set(w, task.sheetIndex);
            const msg = {
                sheetIndex: task.sheetIndex,
                xmlBytes: task.partBytes,
                sharedStrings: this.sharedStrings,
                styleFormatCodes: this.styleFormatCodes,
                display: this.display,
                streamChunks: this.streamChunks,
            };
            // Transfer the sheet bytes (zero-copy); shared inputs are cloned
            // per worker by structured clone — parsed once, shared, per spec.
            w.postMessage(msg, [task.partBytes.buffer]);
        }
    }
    run(tasks) {
        this.queue.push(...tasks);
        this.pump();
        return new Promise((resolve, reject) => {
            if (this.failure)
                return reject(this.failure);
            if (this.busy.size === 0 && this.queue.length === 0)
                return resolve(this.results);
            this.waiters.push({
                resolve: () => resolve(this.results),
                reject,
            });
        });
    }
    async terminate() {
        await Promise.allSettled(this.workers.map((w) => w.terminate()));
    }
}
/** The compiled worker in production; the .ts source when running from source. */
function workerScriptUrl() {
    try {
        const js = new URL('./sheetParseWorker.js', import.meta.url);
        if (existsSync(fileURLToPath(js)))
            return js;
        const ts = new URL('./sheetParseWorker.ts', import.meta.url);
        if (existsSync(fileURLToPath(ts)))
            return ts;
    }
    catch {
        // fall through
    }
    return null;
}
function workerPoolAvailable() {
    return workerScriptUrl() !== null;
}
/* ------------------------------------------------------------------ */
/* The parse                                                           */
/* ------------------------------------------------------------------ */
export async function parseWorkbookFast(bytes, events = {}) {
    const t0 = now();
    let metaFired = false;
    let chunkFired = false;
    const fireMeta = (meta) => {
        if (metaFired)
            return;
        metaFired = true;
        events.onMeta?.(meta);
    };
    const fireChunk = (i, chunk) => {
        chunkFired = true;
        events.onSheetChunk?.(i, chunk);
    };
    const cleanups = [];
    try {
        return await fastPath(bytes, events, {
            fireMeta,
            fireChunk,
            t0,
            registerCleanup: (fn) => {
                cleanups.push(fn);
            },
        });
    }
    catch (e) {
        // A fast-path failure before the pool's own finally runs must not leak
        // worker threads into the fallback path.
        for (const fn of cleanups) {
            try {
                await fn();
            }
            catch {
                /* cleanup is best-effort */
            }
        }
        if (chunkFired)
            throw e; // never re-emit sheets the client already saw
        return fallbackPath(bytes, events, { fireMeta, t0, reason: e instanceof Error ? e.message : String(e) });
    }
}
async function fastPath(bytes, events, hooks) {
    const { t0 } = hooks;
    // -- worker pool, spawned BEFORE the unzip -----------------------------
    // Worker threads take ~0.5–0.9 s to boot and load the parser module.
    // Spawning them here overlaps that with the unzip + metadata +
    // shared-input work below instead of serializing it ahead of sheet 1's
    // first chunk (Cycle 10 P95 TTFP). Whether workers are actually used is
    // only known after the unzip (total sheet XML); a pool spawned in vain
    // is terminated unused, and a pool that turns out to be needed but was
    // not pre-spawned (small package, huge XML) is spawned late, as before.
    const display = events.onSheetChunk !== undefined;
    const streamChunks = display;
    const envWorkers = Number(process.env.ICECREAM_PARSE_WORKERS ?? '');
    const wantedWorkers = Number.isInteger(envWorkers) && envWorkers > 0
        ? envWorkers
        : Math.max(1, availableParallelism() - 1);
    let pool = null;
    let doneDelegate;
    const spawnPool = (size) => {
        const p = new SheetWorkerPool({
            size,
            onChunk: hooks.fireChunk,
            onDone: (i, r) => doneDelegate?.(i, r),
        });
        // If anything between here and the pool branch's own finally throws
        // (metadata extraction, shared-input parse), the caller terminates
        // the pool before falling back — idle workers must not leak.
        hooks.registerCleanup(async () => {
            if (pool) {
                await pool.terminate();
                pool = null;
            }
        });
        return p;
    };
    if (bytes.length >= 1_000_000 && wantedWorkers >= 1 && workerPoolAvailable()) {
        pool = spawnPool(Math.min(wantedWorkers, 8));
    }
    // -- unzip once -------------------------------------------------------
    const tUnzip = now();
    const sharedZip = unzipPackage(bytes);
    if (!sharedZip)
        throw new Error('not a readable XLSX package (unzip failed)');
    const unzipMs = now() - tUnzip;
    const wbXmlBytes = sharedZip['xl/workbook.xml'];
    const relsBytes = sharedZip['xl/_rels/workbook.xml.rels'];
    if (!wbXmlBytes || !relsBytes)
        throw new Error('workbook.xml / rels missing');
    const wbXml = decoder.decode(wbXmlBytes);
    const parts = parseWorkbookSheetParts(wbXml, decoder.decode(relsBytes));
    if (parts.length === 0)
        throw new Error('no sheets in workbook.xml');
    for (const p of parts) {
        if (p.kind !== 'worksheet' && p.kind !== 'chartsheet') {
            throw new Error(`unsupported sheet kind "${p.kind}"`);
        }
        if (p.kind === 'worksheet' && (!p.path || !sharedZip[p.path])) {
            throw new Error(`worksheet part missing: ${p.path ?? p.name}`);
        }
    }
    // Defined names + custom properties from raw XML (SheetJS equivalents).
    const allNames = parseDefinedNames(wbXml).filter((n) => !n.name.startsWith('_xlnm.'));
    // SheetJS-path parity: the adapter always emits the `sheet` key (value
    // undefined for workbook-scoped names); mirror that exactly.
    const definedNames = allNames.map((n) => ({
        name: n.name,
        sheet: n.sheet,
        ref: n.ref,
    }));
    const nameInfos = allNames.map((n) => ({
        name: n.name,
        sheet: n.sheet,
        ref: n.ref,
    }));
    const custXmlBytes = sharedZip['docProps/custom.xml'];
    const custProps = custXmlBytes ? parseCustomProperties(decoder.decode(custXmlBytes)) : undefined;
    // -- worker decision (post-unzip facts) --------------------------------
    const worksheetIdx = parts.map((p, i) => (p.path ? i : -1)).filter((i) => i >= 0);
    const totalBytes = worksheetIdx.reduce((n, i) => n + sharedZip[parts[i].path].length, 0);
    // Workers whenever the sheet XML is big enough to matter — including a
    // single huge sheet: the point is not just throughput, it is keeping
    // the main thread free to flush stream chunks while parsing runs.
    const useWorkers = worksheetIdx.length >= 1 && totalBytes >= WORKER_MIN_TOTAL_BYTES && wantedWorkers >= 1 && workerPoolAvailable();
    const results = new Array(parts.length);
    let firstSheetReadyMs = null;
    const noteDone = (i, info) => {
        if (i === 0 && firstSheetReadyMs === null)
            firstSheetReadyMs = now() - t0;
        events.onSheetDone?.(i, info);
    };
    const workersUsed = useWorkers ? Math.min(wantedWorkers, worksheetIdx.length, 8) : 0;
    if (pool && !useWorkers) {
        // Pre-spawned in vain (sheet XML below the worker threshold).
        await pool.terminate();
        pool = null;
    }
    else if (pool) {
        doneDelegate = (i, r) => {
            results[i] = r;
            noteDone(i, {
                rows: r.rows.length,
                cols: r.rows.reduce((m, row) => Math.max(m, row.length), 0),
                cellCount: r.cellCount,
            });
        };
    }
    else if (useWorkers) {
        // Small compressed package with huge sheet XML: spawn late (the
        // pre-unzip heuristic missed it); behavior as before this optimization.
        pool = spawnPool(workersUsed);
        doneDelegate = (i, r) => {
            results[i] = r;
            noteDone(i, {
                rows: r.rows.length,
                cols: r.rows.reduce((m, row) => Math.max(m, row.length), 0),
                cellCount: r.cellCount,
            });
        };
    }
    // -- zip-level metadata (stream's first chunk) ------------------------
    const tMeta = now();
    const metadata = XlsxAdapter.extractZipMetadata(bytes, sharedZip, custProps);
    const metaMs = now() - tMeta;
    let estimate = 0;
    let totalSheetXmlBytes = 0;
    for (const p of parts) {
        if (!p.path)
            continue;
        const pb = sharedZip[p.path];
        totalSheetXmlBytes += pb.length;
        const est = dimensionEstimate(pb);
        if (est === null)
            estimate = null;
        else if (estimate !== null)
            estimate += est;
    }
    hooks.fireMeta({
        sheets: parts.map((p) => p.name),
        ...(definedNames.length > 0 ? { definedNames } : {}),
        metadata,
        totalSheets: parts.length,
        totalCellsEstimate: estimate,
        totalSheetXmlBytes,
    });
    // -- shared inputs, parsed ONCE ---------------------------------------
    const tShared = now();
    const sstBytes = sharedZip['xl/sharedStrings.xml'];
    const sharedStrings = sstBytes ? parseSharedStrings(decoder.decode(sstBytes)) : [];
    const stylesBytes = sharedZip['xl/styles.xml'];
    const styleFormatCodes = stylesBytes
        ? parseStyleFormatCodes(decoder.decode(stylesBytes), builtinFormatTable())
        : [];
    const sharedInputsMs = now() - tShared;
    // -- sheet parse (parallel or inline; same parser either way) ---------
    const emptyResult = () => ({
        rows: [],
        formats: {},
        rawCols: [],
        rawRows: [],
        chunkingBroken: false,
        displayRows: display ? [] : null,
        pendingCalc: [],
        cellCount: 0,
    });
    const tSheets = now();
    let path = 'inline';
    if (pool) {
        path = 'parallel';
        pool.configure({ sharedStrings, styleFormatCodes, display, streamChunks });
        try {
            const tasks = worksheetIdx.map((i) => ({
                sheetIndex: i,
                // Copy: the part bytes are transferred to a worker; the sharedZip
                // original must survive (assemble + metadata stages read parts).
                partBytes: sharedZip[parts[i].path].slice(),
            }));
            await pool.run(tasks);
        }
        finally {
            await pool.terminate();
            pool = null;
        }
    }
    else {
        for (const i of worksheetIdx) {
            const xml = decoder.decode(sharedZip[parts[i].path]);
            const result = parseWorksheetXml(xml, sharedStrings, styleFormatCodes, {
                display,
                onChunk: streamChunks ? (chunk) => hooks.fireChunk(i, chunk) : undefined,
            });
            results[i] = result;
            noteDone(i, {
                rows: result.rows.length,
                cols: result.rows.reduce((m, row) => Math.max(m, row.length), 0),
                cellCount: result.cellCount,
            });
        }
    }
    for (let i = 0; i < parts.length; i++) {
        if (!results[i]) {
            results[i] = emptyResult();
            noteDone(i, { rows: 0, cols: 0, cellCount: 0 });
        }
    }
    const sheetParseMs = now() - tSheets;
    // -- assemble ----------------------------------------------------------
    const tAsm = now();
    const dimCtx = newDimensionContext();
    const sheets = parts.map((p, i) => {
        const r = results[i];
        const sheet = { name: p.name, rows: r.rows };
        if (Object.keys(r.formats).length > 0)
            sheet.formats = r.formats;
        const dims = convertDimensions(r.rawCols, r.rawRows, dimCtx);
        if (dims.colWidths)
            sheet.colWidths = dims.colWidths;
        if (dims.rowHeights)
            sheet.rowHeights = dims.rowHeights;
        if (dims.hiddenCols)
            sheet.hiddenCols = dims.hiddenCols;
        if (dims.hiddenRows)
            sheet.hiddenRows = dims.hiddenRows;
        return sheet;
    });
    const adapter = new XlsxAdapter();
    const data = adapter.assembleFromParsedSheets(bytes, sheets, {
        definedNames,
        nameInfos,
        custProps,
        sheetNames: parts.map((p) => p.name),
        skipFormulaRecovery: true,
        metadata,
        sharedZip,
    });
    const assembleMs = now() - tAsm;
    const exactTotalCells = results.reduce((n, r) => n + (r?.cellCount ?? 0), 0);
    return {
        data,
        exactTotalCells,
        timings: {
            unzipMs: Math.round(unzipMs),
            sharedInputsMs: Math.round(sharedInputsMs),
            metaMs: Math.round(metaMs),
            sheetParseMs: Math.round(sheetParseMs),
            firstSheetReadyMs: firstSheetReadyMs === null ? null : Math.round(firstSheetReadyMs),
            assembleMs: Math.round(assembleMs),
            totalMs: Math.round(now() - t0),
            path,
            workers: workersUsed,
        },
    };
}
/**
 * SheetJS fallback: identical WorkbookData via the original read. When
 * streaming, sheets are re-emitted as synthesized chunks — display values
 * are the parsed inputs, and formula cells are marked pending-calc (the
 * SheetJS parse does not retain cached formula results, so there is
 * nothing honest to paint for them until the engine build lands).
 */
function fallbackPath(bytes, events, hooks) {
    const t0 = hooks.t0;
    const data = new XlsxAdapter().read(bytes); // throws canonical parse errors
    const totalMs = now() - t0;
    let exactTotalCells = 0;
    for (const s of data.sheets) {
        for (const row of s.rows)
            for (const c of row)
                if (c !== null && c !== undefined)
                    exactTotalCells++;
    }
    hooks.fireMeta({
        sheets: data.sheets.map((s) => s.name),
        ...(data.definedNames ? { definedNames: data.definedNames } : {}),
        metadata: data.metadata,
        totalSheets: data.sheets.length,
        totalCellsEstimate: exactTotalCells,
        totalSheetXmlBytes: 0,
    });
    const fireChunk = events.onSheetChunk;
    if (fireChunk) {
        data.sheets.forEach((sheet, i) => {
            let cellCount = 0;
            for (let start = 0; start < sheet.rows.length; start += FALLBACK_CHUNK_ROWS) {
                const rows = sheet.rows.slice(start, start + FALLBACK_CHUNK_ROWS);
                const displayRows = [];
                const pending = [];
                let chunkCells = 0;
                rows.forEach((row, ri) => {
                    const drow = [];
                    row.forEach((v, c) => {
                        if (typeof v === 'string' && v.startsWith('=') && v.length > 1) {
                            drow.push(null);
                            pending.push(`${start + ri}:${c}`);
                        }
                        else {
                            drow.push(v);
                        }
                        if (v !== null && v !== undefined)
                            chunkCells++;
                    });
                    displayRows.push(drow);
                });
                cellCount += chunkCells;
                const formats = {};
                if (sheet.formats) {
                    for (const [key, code] of Object.entries(sheet.formats)) {
                        const r = Number(key.split(':')[0]);
                        if (r >= start && r < start + rows.length)
                            formats[key] = code;
                    }
                }
                fireChunk(i, {
                    startRow: start,
                    rows,
                    displayRows,
                    formats,
                    pendingCalc: pending,
                    cellCount: chunkCells,
                });
            }
            events.onSheetDone?.(i, {
                rows: sheet.rows.length,
                cols: sheet.rows.reduce((m, row) => Math.max(m, row.length), 0),
                cellCount,
            });
        });
    }
    return {
        data,
        exactTotalCells,
        timings: {
            unzipMs: 0,
            sharedInputsMs: 0,
            metaMs: 0,
            sheetParseMs: Math.round(totalMs),
            firstSheetReadyMs: Math.round(totalMs),
            assembleMs: 0,
            totalMs: Math.round(totalMs),
            path: 'sheetjs-fallback',
            workers: 0,
            fallbackReason: hooks.reason,
        },
    };
}
