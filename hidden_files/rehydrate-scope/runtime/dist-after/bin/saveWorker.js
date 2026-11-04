#!/usr/bin/env node
/**
 * Save worker entry (W21): ONE save per process, spawned per save by
 * the engine service (services/saveWorkerSpawn.ts) with its own heap
 * budget (--max-old-space-size=$SAVE_WORKER_HEAP_MB).
 *
 * Usage: node --max-old-space-size=<mb> dist/bin/saveWorker.js <job.json> <out.xlsx> <result.json>
 *
 * Exit codes: 0 = result file carries { ok: true, ... }; 3 = checksum
 * abort (result file carries the mismatch); 1 = any other failure;
 * 42 = test kill switch (ICECREAM_SAVE_WORKER_TEST_KILL=1 — used to
 * prove that a dead worker is a save error, never a dead session).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runSaveJob, SaveChecksumError } from '../services/saveWorkerCore.js';
const [jobPath, outPath, resultPath] = process.argv.slice(2);
if ((process.env.ICECREAM_SAVE_WORKER_TEST_KILL ?? '') === '1') {
    process.exit(42);
}
// Parent-death watchdog: if the engine that spawned this worker dies
// (the very failure this design isolates), do not linger as an orphan
// holding gigabytes — exit as soon as we are reparented to init.
const parentPid = process.ppid;
const watchdog = setInterval(() => {
    if (process.ppid !== parentPid)
        process.exit(43);
}, 1000);
watchdog.unref?.();
try {
    if (!jobPath || !outPath || !resultPath) {
        throw new Error('usage: saveWorker.js <job.json> <out.xlsx> <result.json>');
    }
    const job = JSON.parse(readFileSync(jobPath, 'utf8'));
    const result = await runSaveJob(job, outPath, (m) => console.log(m));
    writeFileSync(resultPath, JSON.stringify(result), 'utf8');
    process.exit(0);
}
catch (e) {
    const code = e instanceof SaveChecksumError ? 'checksum-mismatch' : 'worker-error';
    try {
        writeFileSync(resultPath, JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), code }), 'utf8');
    }
    catch {
        // No result channel left; the exit code + stderr carry the failure.
    }
    console.error(`[save-worker] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(code === 'checksum-mismatch' ? 3 : 1);
}
