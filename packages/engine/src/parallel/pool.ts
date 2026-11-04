/**
 * Worker pool for parallel recalculation (track 13).
 *
 * One abstraction, three backends:
 * - NodeWorkerBackend: node:worker_threads (services, desktop, Node tests).
 *   Loaded via dynamic import with @vite-ignore so browser bundles never
 *   touch node: imports.
 * - WebWorkerBackend: provided by the HOST (apps/web), not here — the web
 *   app constructs it around its own Vite-bundled worker entry
 *   (apps/web/src/workers/recalc-worker.ts), which calls the same
 *   executePartition(). See apps/web/src/services/parallelWorker.ts.
 * - InlineWorkerBackend: runs executePartition() in-process. The
 *   single-threaded fallback — identical code path, identical results,
 *   guaranteed. Used when workers are unavailable and in unit tests.
 */
import { executePartition } from './worker-logic.js';
import type {
  RecalcRequest,
  RecalcResponse,
  WorkerBackend,
  WorkerBackendFactory,
} from './types.js';

/** In-process fallback: same logic, no threads. Results identical by construction. */
export class InlineWorkerBackend implements WorkerBackend {
  async run(req: RecalcRequest): Promise<RecalcResponse> {
    return executePartition(req);
  }
  dispose(): void {
    // nothing to clean up
  }
}

type NodeWorkerThreads = typeof import('node:worker_threads');

/**
 * Persistent worker_threads backend. One OS thread per backend instance;
 * jobs are multiplexed over postMessage, keyed by jobId.
 */
export class NodeWorkerBackend implements WorkerBackend {
  private worker: InstanceType<NodeWorkerThreads['Worker']> | null = null;
  private wt: NodeWorkerThreads | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    {
      resolve: (r: RecalcResponse) => void;
      reject: (e: Error) => void;
    }
  >();
  private starting: Promise<void> | null = null;

  /**
   * @param workerPath absolute path to the compiled node-worker.js.
   * Defaults to the sibling file in this package's dist output. Only
   * evaluated on Node — never constructed in browsers.
   */
  constructor(private readonly workerPath?: string) {}

  private resolvedPath(): string {
    if (this.workerPath) return this.workerPath;
    // __dirname is dist/parallel at runtime (CJS emit). Forward slashes
    // work on every platform Node runs on.
    return `${__dirname}/node-worker.js`;
  }

  private start(): Promise<void> {
    if (this.worker) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // Dynamic import (vite-ignore): never evaluated in browser bundles.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wt = (await import(/* @vite-ignore */ 'node:worker_threads')) as any as NodeWorkerThreads;
      this.wt = wt;
      const worker = new wt.Worker(this.resolvedPath());
      worker.on('message', (msg: RecalcResponse) => {
        const p = this.pending.get(msg.jobId);
        if (!p) return;
        this.pending.delete(msg.jobId);
        if (msg.error) p.reject(new Error(`worker: ${msg.error}`));
        else p.resolve(msg);
      });
      worker.on('error', (e: Error) => {
        for (const [, p] of this.pending) p.reject(e);
        this.pending.clear();
      });
      worker.on('exit', (code: number) => {
        if (code !== 0) {
          const e = new Error(`worker exited with code ${code}`);
          for (const [, p] of this.pending) p.reject(e);
          this.pending.clear();
        }
        this.worker = null;
        this.starting = null;
      });
      // Surface startup errors (e.g. bad path) instead of hanging.
      await new Promise<void>((resolve, reject) => {
        worker.once('online', () => resolve());
        worker.once('error', (e: Error) => reject(e));
      });
      this.worker = worker;
    })();
    return this.starting;
  }

  async run(req: RecalcRequest): Promise<RecalcResponse> {
    await this.start();
    const worker = this.worker;
    if (!worker) throw new Error('NodeWorkerBackend: worker failed to start');
    const key = `${req.jobId}#${this.seq++}`;
    const wireReq: RecalcRequest = { ...req, jobId: key };
    return new Promise<RecalcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`worker timeout for job ${req.jobId}`));
      }, 120_000);
      this.pending.set(key, {
        resolve: (r) => {
          clearTimeout(timer);
          // Restore the caller's jobId.
          resolve({ ...r, jobId: req.jobId });
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage(wireReq);
    });
  }

  dispose(): void {
    this.pending.clear();
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
      this.starting = null;
    }
  }
}

function isNode(): boolean {
  try {
    const g = globalThis as {
      process?: { versions?: { node?: string } };
    };
    return typeof g.process?.versions?.node === 'string';
  } catch {
    return false;
  }
}

/**
 * Default factory: worker_threads on Node, in-process fallback elsewhere
 * (browsers get InlineWorkerBackend unless the host supplies a Web Worker
 * factory — see apps/web/src/services/parallelWorker.ts).
 */
export function defaultWorkerBackendFactory(): WorkerBackendFactory {
  if (isNode()) {
    return { create: () => new NodeWorkerBackend() };
  }
  return { create: () => new InlineWorkerBackend() };
}

/**
 * Fixed-size pool of backends. Jobs are dealt round-robin; each backend
 * processes its queue sequentially. dispose() terminates all workers.
 */
export class RecalcWorkerPool {
  private backends: WorkerBackend[] | null = null;

  constructor(
    private readonly factory: WorkerBackendFactory,
    private readonly size: number,
  ) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`RecalcWorkerPool: size must be >= 1 (got ${size})`);
    }
  }

  private ensure(): WorkerBackend[] {
    if (!this.backends) {
      this.backends = Array.from({ length: this.size }, () => this.factory.create());
    }
    return this.backends;
  }

  async runAll(requests: RecalcRequest[]): Promise<RecalcResponse[]> {
    const backends = this.ensure();
    const queues: RecalcRequest[][] = backends.map(() => []);
    requests.forEach((r, i) => {
      queues[i % backends.length]!.push(r);
    });
    const perBackend = await Promise.all(
      queues.map(async (queue, i) => {
        const out: RecalcResponse[] = [];
        for (const req of queue) {
          const res = await backends[i]!.run(req);
          if (res.error) throw new Error(`worker: ${res.error}`);
          out.push(res);
        }
        return out;
      }),
    );
    return perBackend.flat();
  }

  dispose(): void {
    if (this.backends) {
      for (const b of this.backends) {
        try {
          b.dispose();
        } catch {
          // best effort
        }
      }
      this.backends = null;
    }
  }
}
