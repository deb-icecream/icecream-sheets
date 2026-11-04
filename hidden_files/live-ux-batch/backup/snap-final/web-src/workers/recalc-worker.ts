/**
 * Web Worker entry for parallel recalculation (track 13).
 *
 * Bundled by Vite as a separate worker chunk (`new Worker(new URL(...))`).
 * Runs the exact same executePartition() logic as the Node worker_threads
 * backend — one pure function, two transports.
 *
 * Protocol: receives RecalcRequest, posts RecalcResponse on success or
 * { jobId, error } on failure (the backend turns the latter into a
 * rejection, which the orchestrator treats as a serial-fallback trigger).
 */
import { executePartition } from '@icecream-sheets/engine';
import type { RecalcRequest, RecalcResponse } from '@icecream-sheets/engine';

type WorkerOut = RecalcResponse | { jobId: string; error: string };

self.onmessage = (e: MessageEvent<RecalcRequest>) => {
  const req = e.data;
  let out: WorkerOut;
  try {
    out = executePartition(req);
  } catch (err) {
    out = { jobId: req.jobId, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(out);
};

// Make this file a module for Vite's worker bundling.
export {};
