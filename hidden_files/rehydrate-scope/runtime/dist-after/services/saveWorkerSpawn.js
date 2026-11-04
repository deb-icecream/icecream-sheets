/**
 * Save-worker spawn (W21 — P95 save fix, guarantee layer).
 *
 * Serialization of a whole-workbook .xlsx save runs in a SEPARATE
 * WORKER PROCESS (per-save spawn: a fresh process per save is the
 * cleanest guarantee — no state can leak between saves, and a worker
 * death can never take the live session's engine with it). The live
 * engine only hands off (source bytes + op journal + expected state
 * checksum, via files in a per-save temp dir), then streams the
 * worker's finished output file back to the client. A worker failure
 * of any kind — non-zero exit, V8 heap death under its budget,
 * SIGKILL from the host, timeout, checksum abort — surfaces as a
 * SaveWorkerError: the /download handler turns it into a save ERROR
 * for the client and the engine session is untouched.
 *
 * Heap budget: SAVE_WORKER_HEAP_MB (deploy/engineAccess.ts), passed
 * as --max-old-space-size to the worker only. The live engine's own
 * 6144 MB flag (defect 2a) is unrelated and unchanged.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export class SaveWorkerError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'SaveWorkerError';
    }
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
export function resolveSaveWorkerScript(override) {
    const candidates = [];
    if (override)
        candidates.push(override);
    const envScript = (process.env.ICECREAM_SAVE_WORKER_SCRIPT ?? '').trim();
    if (envScript)
        candidates.push(envScript);
    try {
        candidates.push(fileURLToPath(new URL('../bin/saveWorker.js', import.meta.url)));
        candidates.push(fileURLToPath(new URL('../../dist/bin/saveWorker.js', import.meta.url)));
    }
    catch {
        // Non-file module URL: no local worker script.
    }
    for (const c of candidates) {
        try {
            if (c && existsSync(c))
                return c;
        }
        catch {
            // keep looking
        }
    }
    return null;
}
/**
 * Spawn one save worker and wait for its result file. Resolves with
 * the output path + parsed result; the caller owns cleanup() (it must
 * run only after the output has been fully streamed/copied out).
 */
export async function spawnSaveWorker(opts) {
    const script = opts.script ?? resolveSaveWorkerScript();
    if (!script)
        throw new SaveWorkerError('save worker script not found', 'no-worker-script');
    const dir = join(tmpdir(), `icecream-save-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    mkdirSync(dir, { recursive: true });
    const cleanup = () => {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch {
            // Temp cleanup must never fail a save that already completed.
        }
    };
    try {
        const job = { ...opts.job };
        if (opts.sourceBytes) {
            const srcPath = join(dir, 'source.xlsx');
            writeFileSync(srcPath, opts.sourceBytes);
            job.sourcePath = srcPath;
        }
        const jobPath = join(dir, 'job.json');
        const outPath = join(dir, 'out.xlsx');
        const resultPath = join(dir, 'result.json');
        writeFileSync(jobPath, JSON.stringify(job), 'utf8');
        let parentPeakRssMb = 0;
        const stderrTail = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [`--expose-gc`, `--max-old-space-size=${opts.heapMb}`, script, jobPath, outPath, resultPath], { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
            // Parent-side peak-RSS sampling (the worker's OWN column,
            // measured honestly): the worker's in-process sampler goes
            // blind during long synchronous serialize stretches (its event
            // loop is blocked exactly when the allocations peak), so the
            // parent reads /proc/<pid>/status VmRSS on a timer — this
            // process is idle-waiting for the save anyway.
            const rssTimer = setInterval(() => {
                try {
                    if (child.pid) {
                        const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
                        const m = /VmRSS:\s*(\d+)\s*kB/.exec(status);
                        if (m) {
                            const mb = Number(m[1]) / 1024;
                            if (mb > parentPeakRssMb)
                                parentPeakRssMb = mb;
                        }
                    }
                }
                catch {
                    // Process gone or /proc unavailable: keep the last sample.
                }
            }, 250);
            rssTimer.unref?.();
            let stderr = '';
            child.stderr.on('data', (d) => {
                stderr = (stderr + d.toString('utf8')).slice(-8192);
            });
            child.stdout.on('data', () => {
                // Worker chatter (engine-style logs) is drained, not kept.
            });
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new SaveWorkerError(`save worker timed out after ${opts.timeoutMs}ms (heap budget ${opts.heapMb} MB)`, 'worker-timeout'));
            }, opts.timeoutMs);
            timer.unref?.();
            child.on('error', (e) => {
                clearTimeout(timer);
                clearInterval(rssTimer);
                reject(new SaveWorkerError(`save worker failed to start: ${e.message}`, 'worker-spawn'));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                clearInterval(rssTimer);
                // The result file is the contract: a clean exit without one,
                // or any non-zero exit, is a save failure with whatever the
                // worker managed to say.
                let parsed;
                try {
                    parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
                }
                catch {
                    parsed = null;
                }
                if (code === 0 && parsed?.ok === true) {
                    resolve(stderr);
                    return;
                }
                if (parsed && parsed.ok === false) {
                    reject(new SaveWorkerError(`save worker failed: ${parsed.error ?? 'unknown error'}`, parsed.code ?? 'worker-error'));
                    return;
                }
                reject(new SaveWorkerError(`save worker died (exit ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}, heap budget ${opts.heapMb} MB)` +
                    (stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''), 'worker-died'));
            });
        });
        void stderrTail;
        const result = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (parentPeakRssMb > 0) {
            result.workerPeakRssMb = Math.max(result.workerPeakRssMb, Math.round(parentPeakRssMb * 10) / 10);
        }
        return { outPath, result, cleanup };
    }
    catch (e) {
        cleanup();
        throw e;
    }
}
/** Directory a job's temp files live in (for tests/diagnostics). */
export function saveWorkerTmpRoot() {
    return tmpdir();
}
export function saveWorkerScriptDir(script) {
    return dirname(script);
}
