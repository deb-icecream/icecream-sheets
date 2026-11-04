/**
 * SessionSubmitHost — the EngineHost the trigger runtime attaches to
 * when it is hosted against a live engine session (triggers program;
 * see hidden_files/triggers/REPORT.md "PIVOT — hosting point
 * corrected").
 *
 * Why this exists: the TriggerRuntime + AutomationApi are
 * SYNCHRONOUS. The session's real EngineHost is synchronous for reads
 * and events, but a trigger WRITE must not call host.execute()
 * directly — session writes have to go through the engine service's
 * sequenced composition (FIFO sequencer + journal + revision, the
 * /ops path) or co-authoring clients and the journal would diverge.
 * That composition is async (enqueueSequenced + runExecuteInternal).
 *
 * So this wrapper:
 *  - delegates every READ (readCell / readRange / getView / snapshot /
 *    sheetNames / usedRange / getAuthorizer) to the real host —
 *    synchronous and always current, exactly like the desktop's
 *    in-process hosting;
 *  - forwards engine EVENTS to the runtime's listeners, EXCEPT while
 *    an automation submit is being applied: the runtime's re-entrancy
 *    guard suppresses self-caused events during a run in the local
 *    topology, and submits here apply just after the run's sync part
 *    ends — without this filter a self-writing trigger would loop;
 *  - execute() enqueues the command through the session's submitOp
 *    (stamped with the command's own automation principal) and
 *    returns an optimistic { ok: true } — the AutomationApi contract
 *    is synchronous. Scripts therefore run to completion (multi-write
 *    scripts included). If a submit is later REJECTED by the engine,
 *    onLateFailure corrects the trigger's last-run record (the
 *    SessionTriggerHost's noteLateRunFailure) — failures are never
 *    silently swallowed;
 *  - drain() lets the supervisor wait for all queued submits (used
 *    before detach, so a session close never strands a write).
 *
 * Read-your-own-writes within a single run is the one documented
 * semantic difference from a purely local host: a script reads the
 * workbook as of the run's start (plus other clients' committed
 * edits); its own writes commit in order through the sequencer
 * immediately after each call.
 */
import { EngineHost, } from '@icecream-sheets/engine';
export class SessionSubmitHost extends EngineHost {
    inner;
    submitOp;
    onLateFailure;
    outerListeners = new Set();
    innerUnsubscribe;
    pending = new Set();
    /** >0 while an automation submit is queued/applying (event filter). */
    applying = 0;
    constructor(handle, opts = {}) {
        // The base host is an unused empty workbook: every method the
        // automation surface touches is overridden to delegate (or, for
        // execute, to submit). Same construction trick as
        // NodeRemoteEngineHost.
        super(undefined, handle.host.getAuthorizer());
        this.inner = handle.host;
        this.submitOp = handle.submitOp;
        this.onLateFailure = opts.onLateFailure;
        this.innerUnsubscribe = handle.host.subscribe((event) => {
            if (this.applying > 0)
                return; // automation-caused: the runtime must not re-fire
            for (const l of [...this.outerListeners]) {
                try {
                    l(event);
                }
                catch {
                    // A failing listener must not break the host.
                }
            }
        });
    }
    // -- writes: sequenced submit, optimistic sync result -----------------
    execute(command) {
        const principal = command.auth?.principal ??
            'automation';
        const principalStr = typeof principal === 'string' ? principal : 'automation';
        this.applying += 1;
        const run = (async () => {
            try {
                const res = await this.submitOp(command, principalStr);
                if (!res.ok) {
                    this.onLateFailure?.(principalStr.replace(/^automation:/, ''), res.error ?? 'op rejected by the engine');
                }
            }
            catch (e) {
                this.onLateFailure?.(principalStr.replace(/^automation:/, ''), e instanceof Error ? e.message : String(e));
            }
            finally {
                this.applying -= 1;
            }
        })();
        this.pending.add(run);
        void run.finally(() => this.pending.delete(run));
        return { ok: true };
    }
    /** Wait until every queued submit has settled (pre-detach). */
    async drain() {
        while (this.pending.size > 0) {
            await Promise.allSettled([...this.pending]);
        }
    }
    // -- events ------------------------------------------------------------
    subscribe(listener) {
        this.outerListeners.add(listener);
        return () => {
            this.outerListeners.delete(listener);
        };
    }
    // -- reads: straight delegation to the live host ------------------------
    readCell(ref) {
        return this.inner.readCell(ref);
    }
    readRange(range) {
        return this.inner.readRange(range);
    }
    getView() {
        return this.inner.getView();
    }
    snapshot() {
        return this.inner.snapshot();
    }
    sheetNames() {
        return this.inner.sheetNames();
    }
    getAuthorizer() {
        return this.inner.getAuthorizer();
    }
    dispose() {
        this.innerUnsubscribe();
        this.outerListeners.clear();
        super.dispose();
    }
}
