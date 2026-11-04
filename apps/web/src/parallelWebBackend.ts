/**
 * Web Worker backend for parallel recalculation (track 13), used by the
 * web app. Each backend owns one dedicated Worker running
 * workers/recalc-worker.ts (Vite-bundled). Multiplexes jobs by jobId so a
 * single worker can serve sequential jobs; the pool holds N backends.
 *
 * If Workers are unavailable (very old browsers, restrictive CSP), the
 * factory throws and the caller falls back to the inline (single-threaded)
 * backend — identical results, no threads.
 */
import type {
  RecalcRequest,
  RecalcResponse,
  WorkerBackend,
  WorkerBackendFactory,
} from '@icecream-sheets/engine';
import {
  shouldEnableParallelRecalc,
  resolveParallelCellThreshold,
  normalizeParallelOptions,
  defaultWorkerCount,
  type ParallelRecalcOptions,
} from '@icecream-sheets/engine';

type WorkerOut = RecalcResponse | { jobId: string; error: string };

function isErrorOut(out: WorkerOut): out is { jobId: string; error: string } {
  return 'error' in out;
}

export class WebWorkerBackend implements WorkerBackend {
  private worker: Worker | null = null;
  private pending = new Map<
    string,
    { resolve: (r: RecalcResponse) => void; reject: (e: Error) => void }
  >();
  private nextSeq = 0;

  private ensureWorker(): Worker {
    if (!this.worker) {
      if (typeof Worker === 'undefined') {
        throw new Error('Web Workers are not available in this environment');
      }
      const w = new Worker(new URL('./workers/recalc-worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const out = e.data;
        const p = this.pending.get(out.jobId);
        if (!p) return;
        this.pending.delete(out.jobId);
        if (isErrorOut(out)) p.reject(new Error(out.error));
        else p.resolve(out);
      };
      w.onerror = (ev) => {
        // Fail every pending job; the orchestrator falls back to serial.
        const err = new Error(`recalc worker error: ${ev.message || 'unknown'}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
      this.worker = w;
    }
    return this.worker;
  }

  async run(req: RecalcRequest): Promise<RecalcResponse> {
    const worker = this.ensureWorker();
    const jobId = `${req.jobId}#${this.nextSeq++}`;
    return new Promise<RecalcResponse>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      worker.postMessage({ ...req, jobId });
    });
  }

  dispose(): void {
    for (const p of this.pending.values()) {
      p.reject(new Error('worker disposed'));
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * Resolve web parallel-recalc options for a workbook of `totalCellCount`
 * non-empty cells, with the automatic-multithreading flag applied
 * (Cycle 10, user's ruling).
 *
 * Below the flag → the browser keeps a full local engine mirror (local
 * calc paths available, hybrid routing applies). Above the flag → no
 * mirror — server-calc only for everything except rendering. This helper
 * is the web host's consumption point for that contract: it returns
 * options whose `enabled` is the flag result, so the engine pool and the
 * mirror-mode selector never disagree.
 *
 * The threshold comes from ICECREAM_MT_CELL_COUNT_THRESHOLD (or the legacy
 * ICECREAM_PARALLEL_CELL_THRESHOLD alias) when set,
 * else the engine default (5,000 — pending Cycle 10 Phase 4 tuning). Pass
 * `overrides` for anything else (workerCount, minFormulaCells).
 */
export function resolveWebParallelRecalcOptions(
  totalCellCount: number,
  overrides: Partial<ParallelRecalcOptions> = {},
  thresholdEnv: { ICECREAM_MT_CELL_COUNT_THRESHOLD?: string; ICECREAM_PARALLEL_CELL_THRESHOLD?: string } = {},
): ParallelRecalcOptions {
  const threshold = overrides.cellCountThreshold ?? resolveParallelCellThreshold(thresholdEnv);
  return normalizeParallelOptions({
    enabled: shouldEnableParallelRecalc(totalCellCount, threshold),
    workerCount: defaultWorkerCount(),
    cellCountThreshold: threshold,
    ...overrides,
  });
}

/**
 * Factory for the web app: creates WebWorkerBackends, falling back to the
 * inline backend when Workers are unavailable. Wire into the engine via
 * host.setWorkerBackendFactory() / setParallelRecalcOptions({ factory }).
 */
export function webWorkerBackendFactory(): WorkerBackendFactory {
  let workersAvailable = typeof Worker !== 'undefined';
  return {
    create: (): WorkerBackend => {
      if (!workersAvailable) {
        throw new Error('Web Workers unavailable');
      }
      try {
        return new WebWorkerBackend();
      } catch {
        // Remember: don't burn time retrying worker construction.
        workersAvailable = false;
        throw new Error('Web Workers unavailable');
      }
    },
  };
}
