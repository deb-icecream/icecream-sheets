"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpcForwardingEngineHost = void 0;
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
const electron_1 = require("electron");
const engine_1 = require("@icecream-sheets/engine");
/** Bound on one forwarded op: fail the MCP call instead of hanging it. */
const FORWARD_TIMEOUT_MS = 30_000;
class IpcForwardingEngineHost extends engine_1.EngineHost {
    getWindow;
    seq = 1;
    pending = new Map();
    /**
     * Subscribers fed by ingestEvent(). The base class's listener set is
     * never used: this instance is never mutated directly, so the base
     * emit() would only ever fire into the void.
     */
    forwardListeners = new Set();
    replyHandlerInstalled = false;
    constructor(getWindow) {
        // The local workbook stays empty by design: every op forwards to the
        // renderer's host. Never mutate this instance directly.
        super();
        this.getWindow = getWindow;
    }
    ensureReplyHandler() {
        if (this.replyHandlerInstalled)
            return;
        electron_1.ipcMain.on('engine:forward:reply', (_event, msg) => {
            const reply = msg;
            if (typeof reply?.id !== 'number')
                return;
            const p = this.pending.get(reply.id);
            if (!p)
                return;
            this.pending.delete(reply.id);
            clearTimeout(p.timer);
            if (reply.ok)
                p.resolve(reply.result);
            else
                p.reject(new Error(reply.error ?? 'engine:forward failed'));
        });
        this.replyHandlerInstalled = true;
    }
    /**
     * Round-trip one protocol op to the renderer. Rejects (never hangs) when
     * the window is gone, the renderer has no forward handler registered yet
     * (preload replies with an error immediately in that case), or the reply
     * takes longer than FORWARD_TIMEOUT_MS.
     */
    forward(payload) {
        this.ensureReplyHandler();
        const win = this.getWindow();
        if (!win || win.isDestroyed()) {
            return Promise.reject(new Error('engine:forward: renderer window is not available'));
        }
        const id = this.seq++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`engine:forward timed out after ${FORWARD_TIMEOUT_MS}ms (op=${payload.op})`));
            }, FORWARD_TIMEOUT_MS);
            // A stuck forward must not keep the app alive on quit.
            timer.unref();
            this.pending.set(id, {
                resolve: resolve,
                reject,
                timer,
            });
            win.webContents.send('engine:forward', { id, payload });
        });
    }
    // -- Forwarded protocol ops (see the contract note at the top of file) ---
    execute(command) {
        return this.forward({ op: 'execute', command });
    }
    async executeAsync(command) {
        // executeAsync is genuinely async in the base class, so no signature
        // adaptation is needed here — forward it like the rest.
        return this.forward({ op: 'executeAsync', command });
    }
    readCell(ref, auth) {
        return this.forward({ op: 'readCell', ref, auth });
    }
    readRange(range, auth) {
        return this.forward({ op: 'readRange', range, auth });
    }
    readSheet(sheet, auth) {
        // The base implementation reads this.view (the empty local workbook);
        // forward the whole op so the used-range comes from the real workbook.
        return this.forward({ op: 'readSheet', sheet, auth });
    }
    snapshot() {
        return this.forward({ op: 'snapshot' });
    }
    getUsedRange(sheet) {
        return this.forward({ op: 'usedRange', sheet });
    }
    // -- Event push (feeds the MCP SubscriptionManager) -----------------------
    /**
     * Subscriptions attach here, not to the base listener set: engine events
     * originate in the renderer's host and arrive via ingestEvent().
     */
    subscribe(listener) {
        this.forwardListeners.add(listener);
        return () => {
            this.forwardListeners.delete(listener);
        };
    }
    /**
     * Fan out one renderer-pushed engine event to shim subscribers. Called
     * by main.ts for each validated `engine:event` from the renderer.
     */
    ingestEvent(event) {
        for (const l of [...this.forwardListeners]) {
            try {
                l(event);
            }
            catch {
                // A failing listener must not break the event feed.
            }
        }
    }
    dispose() {
        super.dispose();
        this.forwardListeners.clear();
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('engine:forward: host disposed'));
        }
        this.pending.clear();
    }
}
exports.IpcForwardingEngineHost = IpcForwardingEngineHost;
//# sourceMappingURL=mcp-forward.js.map