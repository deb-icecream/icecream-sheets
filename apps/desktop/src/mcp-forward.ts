/**
 * Desktop MCP parity GAP-1: IPC-forwarding engine host (platform-shell.md §8).
 *
 * The desktop's MCP direct ingress (:8106) must serve the USER'S workbook,
 * but the user's workbook lives in the RENDERER's EngineHost — the
 * main-process EngineHost is a different, empty instance. This shim closes
 * that gap: every protocol op is forwarded to the renderer over IPC
 * (`engine:forward` on the main window's webContents) and the reply is
 * correlated back by id. The renderer side lives in
 * apps/web/src/services/desktopAgent.ts (registerEngineForwardHandler) with
 * the reply correlator in preload.ts.
 *
 * Event push: engine events originate in the renderer's host, never here.
 * The renderer pushes them back over IPC (`engine:event`, exposed as
 * icecreamDesktop.engineForward.publishEvent); main.ts validates each one
 * and calls ingestEvent(), which fans out to this instance's subscribers —
 * so the MCP SubscriptionManager attached to this host sees live changes.
 *
 * ---------------------------------------------------------------------------
 * SYNC-SIGNATURE / ASYNC-RUNTIME CONTRACT — READ BEFORE CALLING DIRECTLY
 * ---------------------------------------------------------------------------
 * The overrides below keep the base class's SYNCHRONOUS declared signatures
 * (execute(): CommandResult, readCell(): TypedValue, …) so this class stays
 * a genuine EngineHost subtype (Liskov: it can be passed anywhere an
 * EngineHost is expected, e.g. startMcpHttp's opts.host). At RUNTIME each
 * override returns a Promise, because the IPC round-trip is inherently
 * async. EVERY consumer must therefore `await` the result — awaiting a
 * genuine sync value is a no-op, so one call site serves both the local
 * host and this shim. packages/mcp-server/src/server.ts has been audited:
 * every engine.* call there is awaited. If you add a new engine call,
 * await it.
 */
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import {
  EngineHost,
  type AsyncCommandResult,
  type AuthContext,
  type CellRef,
  type CommandResult,
  type EngineCommand,
  type EngineEvent,
  type EngineEventListener,
  type EngineForwardPayload,
  type RangeRef,
  type TypedValue,
  type WorkbookSnapshot,
} from '@icecream-sheets/engine';

/** Bound on one forwarded op: fail the MCP call instead of hanging it. */
const FORWARD_TIMEOUT_MS = 30_000;

interface ForwardReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingForward {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcForwardingEngineHost extends EngineHost {
  private readonly getWindow: () => BrowserWindow | null;
  private seq = 1;
  private readonly pending = new Map<number, PendingForward>();
  /**
   * Subscribers fed by ingestEvent(). The base class's listener set is
   * never used: this instance is never mutated directly, so the base
   * emit() would only ever fire into the void.
   */
  private readonly forwardListeners = new Set<EngineEventListener>();
  private replyHandlerInstalled = false;

  constructor(getWindow: () => BrowserWindow | null) {
    // The local workbook stays empty by design: every op forwards to the
    // renderer's host. Never mutate this instance directly.
    super();
    this.getWindow = getWindow;
  }

  private ensureReplyHandler(): void {
    if (this.replyHandlerInstalled) return;
    ipcMain.on('engine:forward:reply', (_event, msg: unknown) => {
      const reply = msg as Partial<ForwardReply>;
      if (typeof reply?.id !== 'number') return;
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      clearTimeout(p.timer);
      if (reply.ok) p.resolve(reply.result);
      else p.reject(new Error(reply.error ?? 'engine:forward failed'));
    });
    this.replyHandlerInstalled = true;
  }

  /**
   * Round-trip one protocol op to the renderer. Rejects (never hangs) when
   * the window is gone, the renderer has no forward handler registered yet
   * (preload replies with an error immediately in that case), or the reply
   * takes longer than FORWARD_TIMEOUT_MS.
   */
  private forward<T>(payload: EngineForwardPayload): Promise<T> {
    this.ensureReplyHandler();
    const win = this.getWindow();
    if (!win || win.isDestroyed()) {
      return Promise.reject(
        new Error('engine:forward: renderer window is not available'),
      );
    }
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `engine:forward timed out after ${FORWARD_TIMEOUT_MS}ms (op=${payload.op})`,
          ),
        );
      }, FORWARD_TIMEOUT_MS);
      // A stuck forward must not keep the app alive on quit.
      timer.unref();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      win.webContents.send('engine:forward', { id, payload });
    });
  }

  // -- Forwarded protocol ops (see the contract note at the top of file) ---

  override execute(command: EngineCommand): CommandResult {
    return this.forward<CommandResult>({ op: 'execute', command }) as unknown as CommandResult;
  }

  override async executeAsync(command: EngineCommand): Promise<AsyncCommandResult> {
    // executeAsync is genuinely async in the base class, so no signature
    // adaptation is needed here — forward it like the rest.
    return this.forward<AsyncCommandResult>({ op: 'executeAsync', command });
  }

  override readCell(ref: CellRef, auth?: AuthContext): TypedValue {
    return this.forward<TypedValue>({ op: 'readCell', ref, auth }) as unknown as TypedValue;
  }

  override readRange(range: RangeRef, auth?: AuthContext): TypedValue[][] {
    return this.forward<TypedValue[][]>({ op: 'readRange', range, auth }) as unknown as TypedValue[][];
  }

  override readSheet(sheet: string, auth?: AuthContext): TypedValue[][] {
    // The base implementation reads this.view (the empty local workbook);
    // forward the whole op so the used-range comes from the real workbook.
    return this.forward<TypedValue[][]>({ op: 'readSheet', sheet, auth }) as unknown as TypedValue[][];
  }

  override snapshot(): WorkbookSnapshot {
    return this.forward<WorkbookSnapshot>({ op: 'snapshot' }) as unknown as WorkbookSnapshot;
  }

  override getUsedRange(sheet: string): RangeRef | null {
    return this.forward<RangeRef | null>({ op: 'usedRange', sheet }) as unknown as RangeRef | null;
  }

  // -- Event push (feeds the MCP SubscriptionManager) -----------------------

  /**
   * Subscriptions attach here, not to the base listener set: engine events
   * originate in the renderer's host and arrive via ingestEvent().
   */
  override subscribe(listener: EngineEventListener): () => void {
    this.forwardListeners.add(listener);
    return () => {
      this.forwardListeners.delete(listener);
    };
  }

  /**
   * Fan out one renderer-pushed engine event to shim subscribers. Called
   * by main.ts for each validated `engine:event` from the renderer.
   */
  ingestEvent(event: EngineEvent): void {
    for (const l of [...this.forwardListeners]) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the event feed.
      }
    }
  }

  override dispose(): void {
    super.dispose();
    this.forwardListeners.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('engine:forward: host disposed'));
    }
    this.pending.clear();
  }
}
