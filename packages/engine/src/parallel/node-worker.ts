/**
 * worker_threads bootstrap for parallel recalculation (track 13).
 *
 * Node-only entry point: receives RecalcRequest messages over parentPort,
 * executes them with the shared worker logic, and posts RecalcResponse
 * messages back. Multiplexed by jobId so one persistent worker can serve
 * many partition jobs.
 *
 * This file is compiled to dist/parallel/node-worker.js (CJS) and spawned
 * by NodeWorkerBackend. It is never bundled for browsers — the web app
 * ships its own bootstrap (apps/web/src/workers/recalc-worker.ts) that
 * calls the same executePartition().
 */
import { parentPort } from 'node:worker_threads';
import { executePartition } from './worker-logic.js';
import type { RecalcRequest, RecalcResponse } from './types.js';

if (!parentPort) {
  throw new Error('node-worker: no parentPort (not running in a worker thread)');
}

parentPort.on('message', (req: RecalcRequest) => {
  try {
    const res: RecalcResponse = executePartition(req);
    parentPort!.postMessage(res);
  } catch (e) {
    const errRes: RecalcResponse = {
      jobId: req?.jobId ?? 'unknown',
      values: [],
      error: e instanceof Error ? e.message : String(e),
    };
    parentPort!.postMessage(errRes);
  }
});
